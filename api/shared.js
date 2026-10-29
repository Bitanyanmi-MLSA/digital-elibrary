// Shared helpers: CORS, Azure Table Storage (managed identity), signed session tokens.
const crypto = require("crypto");

const ALLOWED = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);
const TABLE_ENDPOINT = process.env.TABLE_ENDPOINT; // e.g. https://<account>.table.core.windows.net
const SECRET = process.env.TOKEN_SECRET || "";
const TV = "2020-12-06";

function corsHeaders(req) {
  const origin = req.headers.origin || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0] || "",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
    "Vary": "Origin"
  };
}

// Returns a send() helper, or null after responding to preflight / disallowed origins.
function begin(context, req) {
  const cors = corsHeaders(req);
  const send = (status, body) => { context.res = { status, headers: { ...cors, "Content-Type": "application/json" }, body }; };
  if (req.method === "OPTIONS") { send(204, ""); return null; }
  const origin = req.headers.origin || "";
  if (ALLOWED.length && !ALLOWED.includes(origin)) { send(403, { error: "Origin not allowed" }); return null; }
  return send;
}

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
const clientIp = req => (req.headers["x-forwarded-for"] || "").split(",")[0].trim();

// ---- Table Storage ----
let tok = { v: "", exp: 0 };
async function storageToken() {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  const r = await fetch(`${process.env.IDENTITY_ENDPOINT}?api-version=2019-08-01&resource=https://storage.azure.com/`, {
    headers: { "X-IDENTITY-HEADER": process.env.IDENTITY_HEADER }
  });
  if (!r.ok) throw new Error("storage token " + r.status);
  const j = await r.json();
  tok = { v: j.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return tok.v;
}

async function tcall(method, path, body, extra) {
  const r = await fetch(TABLE_ENDPOINT + path, {
    method,
    headers: {
      Authorization: "Bearer " + await storageToken(),
      "x-ms-version": TV,
      Accept: "application/json;odata=nometadata",
      "Content-Type": "application/json",
      ...(extra || {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

const ensured = new Set();
async function ensure(table) {
  if (ensured.has(table)) return;
  const r = await tcall("POST", "/Tables", { TableName: table });
  if (r.status !== 201 && r.status !== 409) throw new Error("create table " + r.status);
  ensured.add(table);
}

const key = s => encodeURIComponent(String(s).replace(/'/g, "''"));
const T = {
  async get(table, pk, rk) {
    await ensure(table);
    const r = await tcall("GET", `/${table}(PartitionKey='${key(pk)}',RowKey='${key(rk)}')`);
    return r.status === 200 ? r.json : null;
  },
  async list(table, pk) {
    await ensure(table);
    const out = [];
    let next = "";
    do {
      const r = await tcall("GET", `/${table}()?$filter=${encodeURIComponent(`PartitionKey eq '${pk}'`)}${next}`);
      out.push(...((r.json && r.json.value) || []));
      next = "";
    } while (next);
    return out;
  },
  async put(table, pk, rk, props) {
    await ensure(table);
    const r = await tcall("PUT", `/${table}(PartitionKey='${key(pk)}',RowKey='${key(rk)}')`, props);
    if (r.status >= 300) throw new Error("put " + r.status);
  },
  async merge(table, pk, rk, props) {
    await ensure(table);
    await tcall("MERGE", `/${table}(PartitionKey='${key(pk)}',RowKey='${key(rk)}')`, props, { "If-Match": "*" });
  },
  async insert(table, props) {
    await ensure(table);
    const r = await tcall("POST", `/${table}`, props);
    return r.status === 201;
  },
  async del(table, pk, rk) {
    await ensure(table);
    await tcall("DELETE", `/${table}(PartitionKey='${key(pk)}',RowKey='${key(rk)}')`, null, { "If-Match": "*" });
  }
};

// ---- Session tokens ----
const b64 = b => Buffer.from(b).toString("base64url");
function sign(payload) {
  const p = b64(JSON.stringify(payload));
  return p + "." + crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
}
function verify(token) {
  if (!SECRET || typeof token !== "string") return null;
  const [p, s] = token.split(".");
  if (!p || !s) return null;
  const good = crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, "base64url").toString());
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}

// Valid token AND the code is still active (revocation takes effect within a minute).
const activeCache = new Map();
async function sessionFrom(req) {
  const h = req.headers.authorization || "";
  const d = verify(h.startsWith("Bearer ") ? h.slice(7) : "");
  if (!d) return null;
  const c = activeCache.get(d.c);
  if (c && Date.now() - c.t < 60000) return c.ok ? d : null;
  const e = await T.get("codes", "code", d.c);
  const ok = !!(e && e.active);
  activeCache.set(d.c, { ok, t: Date.now() });
  return ok ? d : null;
}

function isAdmin(req) {
  const given = String(req.headers["x-admin-pass"] || "");
  const want = process.env.ADMIN_PASS || "";
  if (!want || given.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

module.exports = { begin, corsHeaders, limited, clientIp, T, sign, sessionFrom, isAdmin, activeCache };
