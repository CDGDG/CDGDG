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

function renderSvg(usages) {
  const codex30 = metric(usages.codex, "codex", "rolling_30d");
  const claude30 = metric(usages.claude, "claude", "rolling_30d");
  const combined30 = sumMetrics(codex30, claude30);
  const combinedMonth = sumMetrics(metric(usages.codex, "codex", "month"), metric(usages.claude, "claude", "month"));
  const combinedAll = sumMetrics(metric(usages.codex, "codex", "all_time"), metric(usages.claude, "claude", "all_time"));
  const days = mergedDaily(usages);
  const available = SOURCES.filter((source) => usages[source]?.[source]?.rolling_30d?.total_tokens).join(" + ") || "codex 기본 데이터";

  return `<svg width="960" height="450" viewBox="0 0 960 450" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="로컬 AI 에이전트 사용량">
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
    <text x="44" y="58" fill="#f8fafc" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="850">로컬 AI 에이전트 사용량</text>
    <text x="44" y="86" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="15">Codex + Claude Code 집계 · 갱신 ${escapeXml(newestGeneratedAt(usages))}</text>

    ${metricBlock(44, 124, "Codex 최근 30일 토큰", compact(codex30.total_tokens), `${codex30.sessions || 0}개 세션 · 출력 ${compact(codex30.output_tokens)}`, "#38bdf8")}
    ${metricBlock(354, 124, "Claude 최근 30일 토큰", compact(claude30.total_tokens), `${claude30.sessions || 0}개 세션 · 출력 ${compact(claude30.output_tokens)}`, "#a78bfa")}
    ${metricBlock(664, 124, "최근 30일 합산", compact(combined30.total_tokens), `${combined30.sessions || 0}개 세션 · 로컬 로그`, "#fde68a")}

    <text x="44" y="280" fill="#e2e8f0" font-family="Inter, Arial, sans-serif" font-size="17" font-weight="700">일별 활동</text>
    <text x="44" y="304" fill="#94a3b8" font-family="Inter, Arial, sans-serif" font-size="13">이번 달 ${compact(combinedMonth.total_tokens)} · 전체 ${compact(combinedAll.total_tokens)} · 최근 84일</text>
    ${contributionGrid(days)}

    <text x="44" y="430" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="12">출처: ${escapeXml(available)}. 프롬프트, 파일 내용, 비밀값은 게시하지 않습니다.</text>
  </svg>`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
  res.status(200).send(renderSvg(await loadUsages()));
};
