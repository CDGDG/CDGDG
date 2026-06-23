function isAuthorized(req) {
  const expected = process.env.AGENT_USAGE_INGEST_SECRET;
  if (!expected) return false;
  const header = req.headers.authorization || "";
  return header === `Bearer ${expected}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function numericTotals(input = {}) {
  const keys = [
    "sessions",
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ];
  const output = {};
  for (const key of keys) {
    output[key] = Math.max(0, Math.floor(Number(input[key] || 0)));
  }
  return output;
}

function sanitizePayload(source, payload) {
  const root = payload[source] || payload;
  const daily = Array.isArray(root.daily) ? root.daily : [];
  return {
    generated_at: payload.generated_at || new Date().toISOString(),
    sources: Array.isArray(payload.sources) ? payload.sources.map(String).slice(0, 6) : [`${source} local logs`],
    [source]: {
      month: numericTotals(root.month),
      rolling_30d: numericTotals(root.rolling_30d),
      all_time: numericTotals(root.all_time),
      daily: daily.slice(-120).map((day) => ({
        date: String(day.date || ""),
        ...numericTotals(day),
      })).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date)),
    },
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.status(405).send(JSON.stringify({ ok: false, error: "method_not_allowed" }));
    return;
  }
  if (!isAuthorized(req)) {
    res.status(401).send(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }

  const source = String(req.query.source || "").toLowerCase();
  if (!["codex", "claude"].includes(source)) {
    res.status(400).send(JSON.stringify({ ok: false, error: "invalid_source" }));
    return;
  }

  try {
    const payload = JSON.parse(await readBody(req));
    const sanitized = sanitizePayload(source, payload);
    const { put } = await import("@vercel/blob");
    await put(`agent-usage/${source}.json`, JSON.stringify(sanitized, null, 2), {
      access: "private",
      allowOverwrite: true,
      contentType: "application/json; charset=utf-8",
      cacheControlMaxAge: 60,
    });
    res.status(200).send(JSON.stringify({
      ok: true,
      source,
      total_tokens: sanitized[source].rolling_30d.total_tokens,
      sessions: sanitized[source].rolling_30d.sessions,
    }));
  } catch (error) {
    res.status(500).send(JSON.stringify({ ok: false, error: error.message }));
  }
};
