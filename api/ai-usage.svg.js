const DAY = 24 * 60 * 60;

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

function emptyTotals() {
  return {
    configured: false,
    ok: false,
    tokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    requests: 0,
    costUsd: 0,
    aiCredits: 0,
    errors: [],
    source: "not configured",
  };
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

async function getOpenAiUsage() {
  const key = process.env.OPENAI_ADMIN_KEY || process.env.OPENAI_API_KEY;
  if (!key) return emptyTotals();

  const end = Math.floor(Date.now() / 1000);
  const start = end - 30 * DAY;
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  const usageUrl = new URL("https://api.openai.com/v1/organization/usage/completions");
  usageUrl.searchParams.set("start_time", String(start));
  usageUrl.searchParams.set("end_time", String(end));
  usageUrl.searchParams.set("bucket_width", "1d");
  usageUrl.searchParams.set("limit", "31");

  const costsUrl = new URL("https://api.openai.com/v1/organization/costs");
  costsUrl.searchParams.set("start_time", String(start));
  costsUrl.searchParams.set("end_time", String(end));
  costsUrl.searchParams.set("bucket_width", "1d");
  costsUrl.searchParams.set("limit", "31");

  const [usage, costs] = await Promise.all([
    fetchJson(usageUrl, headers),
    fetchJson(costsUrl, headers).catch(() => ({ data: [] })),
  ]);

  const totals = emptyTotals();
  totals.configured = true;
  totals.ok = true;
  totals.source = "OpenAI organization usage";

  for (const bucket of usage.data || []) {
    for (const result of bucket.results || []) {
      totals.inputTokens += Number(result.input_tokens || 0);
      totals.cachedInputTokens += Number(result.input_cached_tokens || result.cached_input_tokens || 0);
      totals.outputTokens += Number(result.output_tokens || 0);
      totals.requests += Number(result.num_model_requests || 0);
    }
  }
  totals.tokens = totals.inputTokens + totals.outputTokens;

  for (const bucket of costs.data || []) {
    for (const result of bucket.results || []) {
      const amount = result.amount || {};
      if ((amount.currency || "usd").toLowerCase() === "usd") {
        totals.costUsd += Number(amount.value || 0);
      }
    }
  }
  return totals;
}

async function getGithubCopilotUsage() {
  const token = process.env.GITHUB_COPILOT_TOKEN || process.env.GITHUB_TOKEN;
  const org = process.env.GITHUB_COPILOT_ORG;
  if (!token || !org) return emptyTotals();

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  const report = await fetchJson(
    `https://api.github.com/orgs/${encodeURIComponent(org)}/copilot/metrics/reports/users-28-day/latest`,
    headers,
  );

  const totals = emptyTotals();
  totals.configured = true;
  totals.ok = true;
  totals.source = `GitHub Copilot ${org}`;

  for (const link of report.download_links || []) {
    const response = await fetch(link);
    if (!response.ok) continue;
    const body = await response.text();
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      totals.aiCredits += Number(row.ai_credits_used || 0);
      totals.requests += Number(row.user_initiated_interaction_count || 0);
    }
  }
  return totals;
}

async function getAnthropicUsage() {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) return emptyTotals();

  const endingAt = new Date();
  const startingAt = new Date(Date.now() - 30 * DAY * 1000);
  const formatDate = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
  const headers = {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "User-Agent": "CDGDG AI Usage Card/1.0 (https://github.com/CDGDG/CDGDG)",
  };

  const usageUrl = new URL("https://api.anthropic.com/v1/organizations/usage_report/messages");
  usageUrl.searchParams.set("starting_at", formatDate(startingAt));
  usageUrl.searchParams.set("ending_at", formatDate(endingAt));
  usageUrl.searchParams.set("bucket_width", "1d");
  usageUrl.searchParams.set("limit", "31");

  const costUrl = new URL("https://api.anthropic.com/v1/organizations/cost_report");
  costUrl.searchParams.set("starting_at", formatDate(startingAt));
  costUrl.searchParams.set("ending_at", formatDate(endingAt));

  const [usage, costs] = await Promise.all([
    fetchJson(usageUrl, headers),
    fetchJson(costUrl, headers).catch(() => ({ data: [] })),
  ]);

  const totals = emptyTotals();
  totals.configured = true;
  totals.ok = true;
  totals.source = "Anthropic organization usage";

  const sumTokenFields = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) sumTokenFields(item);
      return;
    }
    for (const [keyName, nested] of Object.entries(value)) {
      if (typeof nested === "number" && keyName.endsWith("tokens")) {
        totals.tokens += nested;
        if (keyName.includes("output")) totals.outputTokens += nested;
        else totals.inputTokens += nested;
      } else if (keyName === "request_count" || keyName === "requests") {
        totals.requests += Number(nested || 0);
      } else if (nested && typeof nested === "object") {
        sumTokenFields(nested);
      }
    }
  };
  sumTokenFields(usage);

  const sumCostFields = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) sumCostFields(item);
      return;
    }
    for (const [keyName, nested] of Object.entries(value)) {
      if (keyName === "amount" && nested && typeof nested === "object") {
        totals.costUsd += Number(nested.value || 0);
      } else if ((keyName === "cost" || keyName === "cost_usd") && typeof nested === "number") {
        totals.costUsd += nested;
      } else if (nested && typeof nested === "object") {
        sumCostFields(nested);
      }
    }
  };
  sumCostFields(costs);

  return totals;
}

function metricBlock(x, y, label, value, sublabel, accent) {
  return `
    <g transform="translate(${x} ${y})">
      <rect width="250" height="108" rx="18" fill="#0f172a" stroke="${accent}" stroke-opacity="0.38"/>
      <text x="24" y="34" fill="#94a3b8" font-family="Inter, Arial, sans-serif" font-size="14">${escapeXml(label)}</text>
      <text x="24" y="72" fill="#f8fafc" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="800">${escapeXml(value)}</text>
      <text x="24" y="94" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="13">${escapeXml(sublabel)}</text>
    </g>`;
}

function statusText(openai, anthropic, github) {
  return [
    `OpenAI ${openai.configured ? (openai.ok ? "connected" : "error") : "off"}`,
    `Claude ${anthropic.configured ? (anthropic.ok ? "connected" : "error") : "off"}`,
    `Copilot ${github.configured ? (github.ok ? "connected" : "error") : "off"}`,
  ].join(" · ");
}

function renderSvg({ openai, anthropic, github, generatedAt }) {
  const openaiStatus = openai.configured ? (openai.ok ? "connected" : "error") : "not configured";
  const anthropicStatus = anthropic.configured ? (anthropic.ok ? "connected" : "error") : "not configured";
  const githubStatus = github.configured ? (github.ok ? "connected" : "error") : "not configured";
  const title = openai.ok || anthropic.ok || github.ok ? "AI Usage Telemetry" : "AI Usage Telemetry";

  return `<svg width="960" height="430" viewBox="0 0 960 430" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AI usage telemetry">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="960" y2="300" gradientUnits="userSpaceOnUse">
        <stop stop-color="#020617"/>
        <stop offset="0.55" stop-color="#111827"/>
        <stop offset="1" stop-color="#172554"/>
      </linearGradient>
    </defs>
    <rect width="960" height="430" rx="24" fill="url(#bg)"/>
    <path d="M54 99C162 32 258 126 354 77C459 24 535 109 626 78C728 43 804 71 904 35" stroke="#38bdf8" stroke-width="2" opacity="0.42"/>
    <path d="M58 386C176 312 287 379 391 321C522 248 623 359 737 287C805 244 848 253 906 225" stroke="#a7f3d0" stroke-width="2" opacity="0.38"/>
    <text x="44" y="58" fill="#f8fafc" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="850">${escapeXml(title)}</text>
    <text x="44" y="86" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="15">Last 30 days · generated ${escapeXml(generatedAt)}</text>
    ${metricBlock(44, 128, "OpenAI tokens", compact(openai.tokens), `${compact(openai.requests, 0)} requests · ${openaiStatus}`, "#38bdf8")}
    ${metricBlock(354, 128, "Claude tokens", compact(anthropic.tokens), `${compact(anthropic.requests, 0)} requests · ${anthropicStatus}`, "#a78bfa")}
    ${metricBlock(664, 128, "Copilot credits", github.aiCredits ? compact(github.aiCredits) : "-", `${compact(github.requests, 0)} interactions · ${githubStatus}`, "#fde68a")}
    ${metricBlock(44, 260, "OpenAI cost", openai.costUsd ? `$${openai.costUsd.toFixed(2)}` : "-", "organization costs API", "#a7f3d0")}
    ${metricBlock(354, 260, "Claude cost", anthropic.costUsd ? `$${anthropic.costUsd.toFixed(2)}` : "-", "usage cost admin API", "#f0abfc")}
    ${metricBlock(664, 260, "Sources", "3 APIs", statusText(openai, anthropic, github), "#94a3b8")}
    <text x="44" y="408" fill="#64748b" font-family="Inter, Arial, sans-serif" font-size="12">Server-side keys only. No secrets are embedded in this SVG.</text>
  </svg>`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

  const [openaiResult, anthropicResult, githubResult] = await Promise.allSettled([
    getOpenAiUsage(),
    getAnthropicUsage(),
    getGithubCopilotUsage(),
  ]);
  const openai = openaiResult.status === "fulfilled" ? openaiResult.value : { ...emptyTotals(), configured: true, source: openaiResult.reason.message };
  const anthropic = anthropicResult.status === "fulfilled" ? anthropicResult.value : { ...emptyTotals(), configured: true, source: anthropicResult.reason.message };
  const github = githubResult.status === "fulfilled" ? githubResult.value : { ...emptyTotals(), configured: true, source: githubResult.reason.message };
  const generatedAt = new Date().toISOString().slice(0, 16).replace("T", " UTC ");

  res.status(200).send(renderSvg({ openai, anthropic, github, generatedAt }));
};
