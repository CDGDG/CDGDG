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

function telemetryBackground() {
  try {
    const imagePath = path.join(process.cwd(), "assets", "telemetry-neural-960.jpg");
    return `data:image/jpeg;base64,${fs.readFileSync(imagePath).toString("base64")}`;
  } catch {
    return "";
  }
}

function metricBlock(x, y, label, value, sublabel, accent) {
  return `
    <g transform="translate(${x} ${y})">
      <rect width="250" height="116" rx="22" fill="#ffffff" fill-opacity="0.74" stroke="${accent}" stroke-opacity="0.46"/>
      <rect x="1" y="1" width="248" height="114" rx="21" fill="#f8fafc" fill-opacity="0.32"/>
      <circle cx="222" cy="30" r="7" fill="${accent}" fill-opacity="0.88"/>
      <text x="24" y="34" fill="#475569" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="700">${escapeXml(label)}</text>
      <text x="24" y="78" fill="#0f172a" font-family="Inter, Arial, sans-serif" font-size="36" font-weight="850">${escapeXml(value)}</text>
      <text x="24" y="101" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="650">${escapeXml(sublabel)}</text>
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
    const x = 60 + (i % 28) * 30;
    const y = 348 + Math.floor(i / 28) * 22;
    cells.push(`<rect x="${x}" y="${y}" width="18" height="16" rx="5" fill="${colors[level]}" stroke="#ffffff" stroke-opacity="0.58"><title>${escapeXml(day.date || "")}: ${compact(value)} tokens</title></rect>`);
  }
  return cells.join("");
}

function renderSvg(usages) {
  const codex30 = metric(usages.codex, "codex", "rolling_30d");
  const claude30 = metric(usages.claude, "claude", "rolling_30d");
  const combined30 = sumMetrics(codex30, claude30);
  const combinedMonth = sumMetrics(metric(usages.codex, "codex", "month"), metric(usages.claude, "claude", "month"));
  const combinedAll = sumMetrics(metric(usages.codex, "codex", "all_time"), metric(usages.claude, "claude", "all_time"));
  const days = mergedDaily(usages);
  const background = telemetryBackground();

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

    ${metricBlock(60, 134, "Codex 최근 30일", compact(codex30.total_tokens), `${codex30.sessions || 0}개 세션 · 출력 ${compact(codex30.output_tokens)}`, "#0284c7")}
    ${metricBlock(355, 134, "Claude 최근 30일", compact(claude30.total_tokens), `${claude30.sessions || 0}개 세션 · 출력 ${compact(claude30.output_tokens)}`, "#7c3aed")}
    ${metricBlock(650, 134, "최근 30일 합산", compact(combined30.total_tokens), `${combined30.sessions || 0}개 세션 · 로컬 로그`, "#0f766e")}

    <text x="60" y="300" fill="#0f172a" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="800">일별 활동</text>
    <text x="60" y="323" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="650">이번 달 ${compact(combinedMonth.total_tokens)} · 전체 ${compact(combinedAll.total_tokens)} · 최근 84일</text>
    ${contributionGrid(days)}
  </svg>`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
  res.status(200).send(renderSvg(await loadUsages()));
};
