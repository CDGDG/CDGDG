const fs = require("fs");
const path = require("path");

const SOURCES = ["codex", "claude"];

function compact(value, digits = 1) {
  const number = Number(value || 0);
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(digits)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(digits)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(digits)}K`;
  return `${Math.round(number)}`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function emptyUsage(source) {
  return {
    generated_at: null,
    sources: [],
    [source]: {
      month: {},
      rolling_30d: {},
      all_time: {},
      daily: [],
    },
  };
}

async function streamToText(stream) {
  return new Response(stream).text();
}

async function loadBlobUsage(source) {
  try {
    const { get } = await import("@vercel/blob");
    const result = await get(`agent-usage/${source}.json`, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return JSON.parse(await streamToText(result.stream));
  } catch {
    return null;
  }
}

function loadBundledUsage(source) {
  const candidates = source === "codex"
    ? ["agent-usage.json", "codex-agent-usage.json"]
    : [`${source}-agent-usage.json`, "agent-usage.json"];

  for (const fileName of candidates) {
    const usagePath = path.join(process.cwd(), "data", fileName);
    try {
      const data = JSON.parse(fs.readFileSync(usagePath, "utf8"));
      if (data[source]) return data;
    } catch {
      // Keep looking for another bundled source file.
    }
  }
  return null;
}

async function loadUsages() {
  const entries = {};
  for (const source of SOURCES) {
    entries[source] = await loadBlobUsage(source);
  }
  if (!entries.codex) {
    entries.codex = loadBundledUsage("codex") || emptyUsage("codex");
  }
  if (!entries.claude) {
    entries.claude = loadBundledUsage("claude") || emptyUsage("claude");
  }
  return entries;
}

function metric(data, source, window) {
  return data?.[source]?.[window] || {};
}

function sumMetrics(...metrics) {
  const total = {};
  for (const item of metrics) {
    for (const [key, value] of Object.entries(item || {})) {
      if (typeof value === "number") total[key] = (total[key] || 0) + value;
    }
  }
  return total;
}

function mergedDaily(usages) {
  const byDate = new Map();
  for (const source of SOURCES) {
    for (const day of usages[source]?.[source]?.daily || []) {
      const date = day.date;
      if (!date) continue;
      const current = byDate.get(date) || { date };
      for (const [key, value] of Object.entries(day)) {
        if (key !== "date" && typeof value === "number") {
          current[key] = (current[key] || 0) + value;
          current[`${source}_${key}`] = (current[`${source}_${key}`] || 0) + value;
        }
      }
      byDate.set(date, current);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-84);
}

function newestGeneratedAt(usages) {
  const values = SOURCES
    .map((source) => usages[source]?.generated_at)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  if (!values.length) return "not generated";
  return new Date(Math.max(...values)).toISOString().slice(0, 16).replace("T", " UTC ");
}

function dailySeries(days) {
  const normalized = [...(days || [])].slice(-84);
  if (!normalized.length) {
    return [{ index: 0, total_tokens: 0, input_tokens: 0, output_tokens: 0, sessions: 0 }];
  }
  return normalized.map((day, index) => ({
    index,
    date: day.date || "",
    total_tokens: Number(day.total_tokens || 0),
    codex_total_tokens: Number(day.codex_total_tokens || 0),
    claude_total_tokens: Number(day.claude_total_tokens || 0),
    input_tokens: Number(day.input_tokens || 0),
    output_tokens: Number(day.output_tokens || 0),
    sessions: Number(day.sessions || 0),
  }));
}

function telemetryBackground() {
  try {
    const imagePath = path.join(process.cwd(), "assets", "telemetry-neural-960.jpg");
    return `data:image/jpeg;base64,${fs.readFileSync(imagePath).toString("base64")}`;
  } catch {
    return "";
  }
}

function compactMetric(x, y, width, label, value, sublabel, accent) {
  return `
    <g transform="translate(${x} ${y})">
      <rect width="${width}" height="78" rx="20" fill="#ffffff" fill-opacity="0.74"/>
      <circle cx="${width - 28}" cy="25" r="7" fill="${accent}" fill-opacity="0.9"/>
      <text x="18" y="26" fill="#475569" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="750">${escapeXml(label)}</text>
      <text x="18" y="60" fill="#0f172a" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="850">${escapeXml(value)}</text>
      <text x="148" y="58" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="700">${escapeXml(sublabel)}</text>
    </g>`;
}

function contributionGrid(days) {
  // GitHub-style calendar heatmap: 7 rows (Sun→Sat) × one column per week.
  const normalized = [...(days || [])].filter((day) => day && day.date).slice(-84);
  if (!normalized.length) return "";

  const colors = ["#e2e8f0", "#bae6fd", "#7dd3fc", "#38bdf8", "#0f766e"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAY_MS = 86400000;
  const parse = (value) => new Date(`${value}T00:00:00Z`);
  const maxTokens = Math.max(1, ...normalized.map((day) => Number(day.total_tokens || 0)));

  const first = parse(normalized[0].date);
  // Anchor the grid to the Sunday on/before the first day so columns are weeks.
  const gridStart = new Date(first.getTime() - first.getUTCDay() * DAY_MS);

  const cell = 12;
  const step = cell + 4; // 16
  const originX = 96; // cells begin here; weekday labels sit to the left
  const originY = 482; // top (Sunday) row

  const cells = [];
  const monthLabels = [];
  const seenMonth = new Set();

  for (const day of normalized) {
    const date = parse(day.date);
    const col = Math.floor((date.getTime() - gridStart.getTime()) / (7 * DAY_MS));
    const row = date.getUTCDay();
    const value = Number(day.total_tokens || 0);
    const level = value <= 0 ? 0 : Math.min(4, Math.ceil((value / maxTokens) * 4));
    const x = originX + col * step;
    const y = originY + row * step;
    cells.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5" fill="${colors[level]}"><title>${escapeXml(day.date)}: ${compact(value)} tokens</title></rect>`);

    const month = date.getUTCMonth();
    if (!seenMonth.has(month)) {
      seenMonth.add(month);
      monthLabels.push(`<text x="${x}" y="${originY - 8}" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="11" font-weight="700">${MONTHS[month]}</text>`);
    }
  }

  const weekdayLabels = [[1, "Mon"], [3, "Wed"], [5, "Fri"]]
    .map(([row, label]) => `<text x="${originX - 10}" y="${(originY + row * step + cell * 0.5 + 3).toFixed(1)}" text-anchor="end" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="10" font-weight="650">${label}</text>`)
    .join("");

  // Legend (Less → More) just below the grid.
  const legendY = originY + 7 * step + 10;
  let legend = `<text x="${originX}" y="${legendY}" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="10" font-weight="650">Less</text>`;
  const swatchX = originX + 32;
  colors.forEach((color, i) => {
    legend += `<rect x="${swatchX + i * (cell + 3)}" y="${legendY - cell + 2}" width="${cell}" height="${cell}" rx="2.5" fill="${color}"/>`;
  });
  legend += `<text x="${swatchX + colors.length * (cell + 3) + 6}" y="${legendY}" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="10" font-weight="650">More</text>`;

  return monthLabels.join("") + weekdayLabels + cells.join("") + legend;
}

async function tokenChart(days) {
  const [{ scaleLinear }, { area, line, curveLinear }, { max }] = await Promise.all([
    import("d3-scale"),
    import("d3-shape"),
    import("d3-array"),
  ]);
  const data = dailySeries(days);
  const chart = { x: 60, y: 128, width: 840, height: 175 };
  const maxTotal = max(data, (day) => day.total_tokens) || 1;
  const xScale = scaleLinear().domain([0, Math.max(1, data.length - 1)]).range([chart.x, chart.x + chart.width]);
  const yScale = scaleLinear().domain([0, maxTotal]).nice().range([chart.y + chart.height, chart.y]);
  const codexAreaPath = area()
    .x((day) => xScale(day.index))
    .y0(chart.y + chart.height)
    .y1((day) => yScale(day.codex_total_tokens))
    .curve(curveLinear)(data);
  const claudeStackAreaPath = area()
    .x((day) => xScale(day.index))
    .y0((day) => yScale(day.codex_total_tokens))
    .y1((day) => yScale(day.total_tokens))
    .curve(curveLinear)(data);
  const totalPath = line()
    .x((day) => xScale(day.index))
    .y((day) => yScale(day.total_tokens))
    .curve(curveLinear)(data);
  const codexPath = line()
    .x((day) => xScale(day.index))
    .y((day) => yScale(day.codex_total_tokens))
    .curve(curveLinear)(data);
  const claudePath = line()
    .x((day) => xScale(day.index))
    .y((day) => yScale(day.claude_total_tokens))
    .curve(curveLinear)(data);
  const ticks = yScale.ticks(3).filter((value) => value > 0);
  const grid = ticks.map((value) => `
    <g>
      <line x1="${chart.x}" y1="${yScale(value).toFixed(2)}" x2="${chart.x + chart.width}" y2="${yScale(value).toFixed(2)}" stroke="#cbd5e1" stroke-opacity="0.52"/>
      <text x="${chart.x + chart.width + 10}" y="${(yScale(value) + 4).toFixed(2)}" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="11" font-weight="650">${compact(value)}</text>
    </g>`).join("");
  const last = data[data.length - 1] || data[0];
  const lastX = xScale(last.index);
  const lastY = yScale(last.total_tokens);

  return `
    <g>
      <rect x="${chart.x}" y="${chart.y}" width="${chart.width}" height="${chart.height}" rx="20" fill="#ffffff" fill-opacity="0.56"/>
      ${grid}
      <path d="${codexAreaPath || ""}" fill="#38bdf8" fill-opacity="0.22"/>
      <path d="${claudeStackAreaPath || ""}" fill="#8b5cf6" fill-opacity="0.22"/>
      <path d="${totalPath || ""}" fill="none" stroke="#0f766e" stroke-width="3.5" stroke-linecap="round" stroke-opacity="0.9"/>
      <path d="${codexPath || ""}" fill="none" stroke="#0284c7" stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.82"/>
      <path d="${claudePath || ""}" fill="none" stroke="#7c3aed" stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.86"/>
      <circle cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="6" fill="#0f766e" stroke="#ffffff" stroke-width="3"/>
      <text x="${chart.x}" y="${chart.y + chart.height + 24}" fill="#475569" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="700">전체 합산</text>
      <circle cx="${chart.x + 66}" cy="${chart.y + chart.height + 20}" r="4" fill="#0f766e"/>
      <text x="${chart.x + 94}" y="${chart.y + chart.height + 24}" fill="#475569" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="700">Codex</text>
      <circle cx="${chart.x + 140}" cy="${chart.y + chart.height + 20}" r="4" fill="#0284c7"/>
      <text x="${chart.x + 168}" y="${chart.y + chart.height + 24}" fill="#475569" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="700">Claude</text>
      <circle cx="${chart.x + 218}" cy="${chart.y + chart.height + 20}" r="4" fill="#7c3aed"/>
    </g>`;
}

async function renderSvg(usages) {
  const codex30 = metric(usages.codex, "codex", "rolling_30d");
  const claude30 = metric(usages.claude, "claude", "rolling_30d");
  const combined30 = sumMetrics(codex30, claude30);
  const combinedMonth = sumMetrics(metric(usages.codex, "codex", "month"), metric(usages.claude, "claude", "month"));
  const combinedAll = sumMetrics(metric(usages.codex, "codex", "all_time"), metric(usages.claude, "claude", "all_time"));
  const days = mergedDaily(usages);
  const background = telemetryBackground();
  const chart = await tokenChart(days);

  return `<svg width="960" height="640" viewBox="0 0 960 640" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AI 에이전트 사용량">
    <defs>
      <linearGradient id="wash" x1="0" y1="0" x2="960" y2="640" gradientUnits="userSpaceOnUse">
        <stop stop-color="#f8fafc" stop-opacity="0.92"/>
        <stop offset="0.48" stop-color="#eff6ff" stop-opacity="0.76"/>
        <stop offset="1" stop-color="#cffafe" stop-opacity="0.58"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-24%" width="140%" height="148%" color-interpolation-filters="sRGB">
        <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#0f172a" flood-opacity="0.16"/>
      </filter>
    </defs>
    <rect width="960" height="640" rx="30" fill="#f8fafc"/>
    ${background ? `<image href="${background}" x="0" y="0" width="960" height="640" preserveAspectRatio="xMidYMid slice" opacity="0.9"/>` : ""}
    <rect width="960" height="640" rx="30" fill="url(#wash)"/>
    <rect x="1.5" y="1.5" width="957" height="637" rx="28.5" stroke="#67e8f9" stroke-opacity="0.46" stroke-width="3"/>

    <g filter="url(#shadow)">
      <rect x="34" y="30" width="892" height="580" rx="28" fill="#ffffff" fill-opacity="0.48" stroke="#ffffff" stroke-opacity="0.72"/>
    </g>

    <text x="60" y="74" fill="#0f172a" font-family="Inter, Arial, sans-serif" font-size="32" font-weight="880">AI 에이전트 사용량</text>
    <text x="60" y="102" fill="#475569" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="650">Codex + Claude Code · ${escapeXml(newestGeneratedAt(usages))}</text>

    ${chart}

    ${compactMetric(60, 345, 260, "Codex", compact(codex30.total_tokens), `${codex30.sessions || 0}개 세션`, "#0284c7")}
    ${compactMetric(350, 345, 260, "Claude", compact(claude30.total_tokens), `${claude30.sessions || 0}개 세션`, "#7c3aed")}
    ${compactMetric(640, 345, 260, "최근 30일", compact(combined30.total_tokens), `${combined30.sessions || 0}개 세션`, "#0f766e")}

    <text x="60" y="452" fill="#0f172a" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="850">최근 84일</text>
    <text x="170" y="452" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="700">이번 달 ${compact(combinedMonth.total_tokens)} · 전체 ${compact(combinedAll.total_tokens)}</text>
    ${contributionGrid(days)}
  </svg>`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
  res.status(200).send(await renderSvg(await loadUsages()));
};
