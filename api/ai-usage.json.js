// Public, CORS-enabled JSON view of the same agent-usage data the README SVG
// renders — so the portfolio (cdgdg.github.io) can read it live in the browser.
const fs = require("fs");
const path = require("path");

const SOURCES = ["codex", "claude"];

function emptyUsage(source) {
  return {
    generated_at: null,
    sources: [],
    [source]: { month: {}, rolling_30d: {}, all_time: {}, daily: [] },
  };
}

async function streamToText(stream) {
  return new Response(stream).text();
}

async function loadBlobUsage(source) {
  try {
    const { get } = await import("@vercel/blob");
    const result = await get(`agent-usage/${source}.json`, {
      access: "private",
      useCache: false,
    });
    if (!result || result.statusCode !== 200) return null;
    return JSON.parse(await streamToText(result.stream));
  } catch {
    return null;
  }
}

function loadBundledUsage(source) {
  const candidates =
    source === "codex"
      ? ["agent-usage.json", "codex-agent-usage.json"]
      : [`${source}-agent-usage.json`, "agent-usage.json"];
  for (const fileName of candidates) {
    const usagePath = path.join(process.cwd(), "data", fileName);
    try {
      const data = JSON.parse(fs.readFileSync(usagePath, "utf8"));
      if (data[source]) return data;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function loadUsages() {
  const entries = {};
  for (const source of SOURCES) {
    entries[source] = await loadBlobUsage(source);
  }
  if (!entries.codex) entries.codex = loadBundledUsage("codex") || emptyUsage("codex");
  if (!entries.claude) entries.claude = loadBundledUsage("claude") || emptyUsage("claude");
  return entries;
}

function metric(data, source, window) {
  return data?.[source]?.[window] || {};
}

function windowTotals(usages, window) {
  const codex = metric(usages.codex, "codex", window);
  const claude = metric(usages.claude, "claude", window);
  const c = Number(codex.total_tokens || 0);
  const a = Number(claude.total_tokens || 0);
  return {
    codex: c,
    claude: a,
    total: c + a,
    sessions: Number(codex.sessions || 0) + Number(claude.sessions || 0),
  };
}

function mergedDaily(usages) {
  const byDate = new Map();
  for (const source of SOURCES) {
    for (const day of usages[source]?.[source]?.daily || []) {
      const date = day.date;
      if (!date) continue;
      const current = byDate.get(date) || { date, codex: 0, claude: 0, total: 0 };
      const t = Number(day.total_tokens || 0);
      current[source] += t;
      current.total += t;
      byDate.set(date, current);
    }
  }
  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-84);
}

function newestGeneratedAt(usages) {
  const values = SOURCES.map((s) => usages[s]?.generated_at)
    .filter(Boolean)
    .map((v) => new Date(v).getTime())
    .filter((v) => Number.isFinite(v));
  if (!values.length) return null;
  return new Date(Math.max(...values)).toISOString();
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=600, s-maxage=600");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    const usages = await loadUsages();
    const payload = {
      generated_at: newestGeneratedAt(usages),
      windows: {
        all_time: windowTotals(usages, "all_time"),
        rolling_30d: windowTotals(usages, "rolling_30d"),
        month: windowTotals(usages, "month"),
      },
      daily: mergedDaily(usages),
    };
    res.status(200).send(JSON.stringify(payload));
  } catch (error) {
    res.status(500).send(JSON.stringify({ ok: false, error: error.message }));
  }
};
