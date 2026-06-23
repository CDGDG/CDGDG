const fs = require("fs");
const path = require("path");

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

function loadUsage() {
  const usagePath = path.join(process.cwd(), "data", "agent-usage.json");
  try {
    return JSON.parse(fs.readFileSync(usagePath, "utf8"));
  } catch {
    return {
      generated_at: null,
      sources: [],
      codex: {
        month: {},
        rolling_30d: {},
        all_time: {},
        daily: [],
      },
    };
  }
}

function metricBlock(x, y, label, value, sublabel, accent) {
  return `
    <g transform="translate(${x} ${y})">
      <rect width="250" height="104" rx="16" fill="#0f172a" stroke="${accent}" stroke-opacity="0.38"/>
      <text x="22" y="32" fill="#94a3b8" font-family="Inter, Arial, sans-serif" font-size="13">${escapeXml(label)}</text>
      <text x="22" y="70" fill="#f8fafc" font-family="Inter, Arial, sans-serif" font-size="32" font-weight="800">${escapeXml(value)}</text>
      <text x="22" y="91" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="12">${escapeXml(sublabel)}</text>
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
    const colors = ["#1e293b", "#164e63", "#0e7490", "#14b8a6", "#a7f3d0"];
    const x = 44 + (i % 28) * 30;
    const y = 342 + Math.floor(i / 28) * 24;
    cells.push(`<rect x="${x}" y="${y}" width="18" height="18" rx="4" fill="${colors[level]}"><title>${escapeXml(day.date || "")}: ${compact(value)} tokens</title></rect>`);
  }
  return cells.join("");
}

function renderSvg(data) {
  const codex = data.codex || {};
  const rolling = codex.rolling_30d || {};
  const month = codex.month || {};
  const allTime = codex.all_time || {};
  const generated = data.generated_at
    ? new Date(data.generated_at).toISOString().slice(0, 16).replace("T", " UTC ")
    : "not generated";
  const sourceText = (data.sources || []).join(" + ") || "local collector pending";

  return `<svg width="960" height="450" viewBox="0 0 960 450" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Local AI agent telemetry">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="960" y2="450" gradientUnits="userSpaceOnUse">
        <stop stop-color="#020617"/>
        <stop offset="0.52" stop-color="#111827"/>
        <stop offset="1" stop-color="#172554"/>
      </linearGradient>
    </defs>
    <rect width="960" height="450" rx="24" fill="url(#bg)"/>
    <path d="M54 102C162 35 258 129 354 80C459 27 535 112 626 81C728 46 804 74 904 38" stroke="#38bdf8" stroke-width="2" opacity="0.42"/>
    <path d="M58 414C176 340 287 407 391 349C522 276 623 387 737 315C805 272 848 281 906 253" stroke="#a7f3d0" stroke-width="2" opacity="0.38"/>
    <text x="44" y="58" fill="#f8fafc" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="850">Local AI Agent Telemetry</text>
    <text x="44" y="86" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="15">Codex desktop/app logs · updated ${escapeXml(generated)}</text>

    ${metricBlock(44, 124, "Last 30 days tokens", compact(rolling.total_tokens), `${rolling.sessions || 0} sessions · ${compact(rolling.output_tokens)} output`, "#38bdf8")}
    ${metricBlock(354, 124, "This month tokens", compact(month.total_tokens), `${month.sessions || 0} sessions · ${compact(month.reasoning_output_tokens)} reasoning`, "#a7f3d0")}
    ${metricBlock(664, 124, "All-time logged", compact(allTime.total_tokens), `${allTime.sessions || 0} sessions · local logs`, "#fde68a")}

    <text x="44" y="280" fill="#e2e8f0" font-family="Inter, Arial, sans-serif" font-size="17" font-weight="700">Daily activity</text>
    <text x="44" y="304" fill="#94a3b8" font-family="Inter, Arial, sans-serif" font-size="13">Last 84 days · darker means fewer tokens, brighter means heavier agent work</text>
    ${contributionGrid(codex.daily || [])}

    <text x="44" y="430" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="12">Source: ${escapeXml(sourceText)}. No prompts, file contents, or secrets are published.</text>
  </svg>`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
  res.status(200).send(renderSvg(loadUsage()));
};
