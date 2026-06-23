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
  const usagePath = path.join(process.cwd(), "data", "agent-usage.json");
  try {
    const data = JSON.parse(fs.readFileSync(usagePath, "utf8"));
    return data[source] ? data : null;
  } catch {
    return null;
  }
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
    entries.claude = emptyUsage("claude");
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

function compactMetric(x, y, label, value, sublabel, accent) {
  return `
    <g transform="translate(${x} ${y})">
      <rect width="190" height="76" rx="18" fill="#ffffff" fill-opacity="0.72"/>
      <circle cx="166" cy="24" r="6" fill="${accent}" fill-opacity="0.9"/>
      <text x="18" y="26" fill="#475569" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="750">${escapeXml(label)}</text>
      <text x="18" y="56" fill="#0f172a" font-family="Inter, Arial, sans-serif" font-size="25" font-weight="850">${escapeXml(value)}</text>
      <text x="88" y="55" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="11" font-weight="650">${escapeXml(sublabel)}</text>
    </g>`;
}

function contributionGrid(days) {
  const cells = [];
  const normalized = [...(days || [])].slice(-84);
  const maxTokens = Math.max(1, ...normalized.map((day) => Number(day.total_tokens || 0)));
  for (let i = 0; i < 84; i += 1) {
    const day = normalized[i] || {};
    const value = Number(day.total_tokens || 0);
    const level = value <= 0 ? 0 : Math.min(4, Math.ceil((value / maxTokens) * 4));
    const colors = ["#e2e8f0", "#bae6fd", "#7dd3fc", "#38bdf8", "#0f766e"];
    const x = 704 + (i % 21) * 9;
    const y = 374 + Math.floor(i / 21) * 12;
    cells.push(`<rect x="${x}" y="${y}" width="8" height="8" rx="2" fill="${colors[level]}"><title>${escapeXml(day.date || "")}: ${compact(value)} tokens</title></rect>`);
  }
  return cells.join("");
}

async function tokenChart(days) {
  const [{ scaleLinear }, { area, line, curveMonotoneX }, { max }] = await Promise.all([
    import("d3-scale"),
    import("d3-shape"),
    import("d3-array"),
  ]);
  const data = dailySeries(days);
  const chart = { x: 60, y: 142, width: 840, height: 150 };
  const maxTotal = max(data, (day) => day.total_tokens) || 1;
  const xScale = scaleLinear().domain([0, Math.max(1, data.length - 1)]).range([chart.x, chart.x + chart.width]);
  const yScale = scaleLinear().domain([0, maxTotal]).nice().range([chart.y + chart.height, chart.y]);
  const areaPath = area()
    .x((day) => xScale(day.index))
    .y0(chart.y + chart.height)
    .y1((day) => yScale(day.total_tokens))
    .curve(curveMonotoneX)(data);
  const linePath = line()
    .x((day) => xScale(day.index))
    .y((day) => yScale(day.total_tokens))
    .curve(curveMonotoneX)(data);
  const outputPath = line()
    .x((day) => xScale(day.index))
    .y((day) => yScale(day.output_tokens))
    .curve(curveMonotoneX)(data);
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
      <path d="${areaPath || ""}" fill="#38bdf8" fill-opacity="0.28"/>
      <path d="${linePath || ""}" fill="none" stroke="#0284c7" stroke-width="4" stroke-linecap="round"/>
      <path d="${outputPath || ""}" fill="none" stroke="#7c3aed" stroke-width="2.5" stroke-linecap="round" stroke-opacity="0.72"/>
      <circle cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="6" fill="#0f766e" stroke="#ffffff" stroke-width="3"/>
      <text x="${chart.x}" y="${chart.y + chart.height + 24}" fill="#475569" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="700">총 토큰</text>
      <circle cx="${chart.x + 58}" cy="${chart.y + chart.height + 20}" r="4" fill="#0284c7"/>
      <text x="${chart.x + 86}" y="${chart.y + chart.height + 24}" fill="#475569" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="700">출력 토큰</text>
      <circle cx="${chart.x + 154}" cy="${chart.y + chart.height + 20}" r="4" fill="#7c3aed"/>
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

  return `<svg width="960" height="450" viewBox="0 0 960 450" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AI 에이전트 사용량">
    <defs>
      <linearGradient id="wash" x1="0" y1="0" x2="960" y2="450" gradientUnits="userSpaceOnUse">
        <stop stop-color="#f8fafc" stop-opacity="0.92"/>
        <stop offset="0.48" stop-color="#eff6ff" stop-opacity="0.76"/>
        <stop offset="1" stop-color="#cffafe" stop-opacity="0.58"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-24%" width="140%" height="148%" color-interpolation-filters="sRGB">
        <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#0f172a" flood-opacity="0.16"/>
      </filter>
    </defs>
    <rect width="960" height="450" rx="30" fill="#f8fafc"/>
    ${background ? `<image href="${background}" x="0" y="0" width="960" height="450" preserveAspectRatio="xMidYMid slice" opacity="0.9"/>` : ""}
    <rect width="960" height="450" rx="30" fill="url(#wash)"/>
    <rect x="1.5" y="1.5" width="957" height="447" rx="28.5" stroke="#67e8f9" stroke-opacity="0.46" stroke-width="3"/>

    <g filter="url(#shadow)">
      <rect x="34" y="30" width="892" height="390" rx="28" fill="#ffffff" fill-opacity="0.48" stroke="#ffffff" stroke-opacity="0.72"/>
    </g>

    <text x="60" y="74" fill="#0f172a" font-family="Inter, Arial, sans-serif" font-size="32" font-weight="880">AI 에이전트 사용량</text>
    <text x="60" y="102" fill="#475569" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="650">Codex + Claude Code · ${escapeXml(newestGeneratedAt(usages))}</text>

    ${chart}

    ${compactMetric(60, 318, "Codex", compact(codex30.total_tokens), `${codex30.sessions || 0}개 세션`, "#0284c7")}
    ${compactMetric(270, 318, "Claude", compact(claude30.total_tokens), `${claude30.sessions || 0}개 세션`, "#7c3aed")}
    ${compactMetric(480, 318, "최근 30일", compact(combined30.total_tokens), `${combined30.sessions || 0}개 세션`, "#0f766e")}

    <text x="704" y="335" fill="#0f172a" font-family="Inter, Arial, sans-serif" font-size="15" font-weight="800">최근 84일</text>
    <text x="704" y="356" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="650">이번 달 ${compact(combinedMonth.total_tokens)} · 전체 ${compact(combinedAll.total_tokens)}</text>
    ${contributionGrid(days)}
  </svg>`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
  res.status(200).send(await renderSvg(await loadUsages()));
};
