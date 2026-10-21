// Library API: access-code login, admin code management, usage tracking, and book catalogue/text proxy
// (Project Gutenberg via Gutendex, Open Library). Route: /api/lib/{action}
const { begin, limited, clientIp, T, sign, sessionFrom, isAdmin, activeCache } = require("../shared");

const BLOCKED = /\b(guns?|pistols?|rifles?|firearms?|bombs?|weapons?|knife|knives|stab|kill(?:ing|ed|s)?|murder|suicide|rape|sex(?:ual|y)?|porn\w*|nude|naked|drugs?|cocaine|heroin|marijuana|alcohol|erotic\w*|torture|massacre|war|violen(?:ce|t)|horror|ghosts?|vampires?|devil|satan)\b/i;
// Curated, age-appropriate Project Gutenberg classics (fast and reliable); Gutendex search is best-effort.
const SHELVES = {
  "Fables & Folktales": [[19994, "The Aesop for Children", "Aesop"], [21, "Three Hundred Aesop's Fables", "Aesop"], [2591, "Grimms' Fairy Tales", "Jacob & Wilhelm Grimm"], [1597, "Andersen's Fairy Tales", "H. C. Andersen"], [17208, "The Tales of Mother Goose", "Charles Perrault"], [2781, "Just So Stories", "Rudyard Kipling"]],
  "Animals & Nature": [[236, "The Jungle Book", "Rudyard Kipling"], [289, "The Wind in the Willows", "Kenneth Grahame"], [271, "Black Beauty", "Anna Sewell"], [14838, "The Tale of Peter Rabbit", "Beatrix Potter"], [1018, "The Water-Babies", "Charles Kingsley"]],
  "Adventure & Fantasy": [[11, "Alice's Adventures in Wonderland", "Lewis Carroll"], [12, "Through the Looking-Glass", "Lewis Carroll"], [16, "Peter Pan", "J. M. Barrie"], [55, "The Wonderful Wizard of Oz", "L. Frank Baum"], [500, "The Adventures of Pinocchio", "Carlo Collodi"], [778, "Five Children and It", "E. Nesbit"], [18857, "A Journey to the Centre of the Earth", "Jules Verne"]],
  "Family & Growing Up": [[113, "The Secret Garden", "Frances Hodgson Burnett"], [1448, "Heidi", "Johanna Spyri"], [45, "Anne of Green Gables", "L. M. Montgomery"], [514, "Little Women", "Louisa May Alcott"], [1874, "The Railway Children", "E. Nesbit"]]
};
const coverOf = id => `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`;
const shelfBook = (shelf, [id, title, author]) => ({ id, title, author, cover: coverOf(id), subjects: [shelf] });
const SESSION_MS = 12 * 3600 * 1000;
const textCache = new Map();

const safeText = (s, n) => String(s || "").slice(0, n);
const codeOk = c => /^\d{4}$/.test(String(c));

async function jget(url, ms) {
  const r = await fetch(url, { headers: { "User-Agent": "DigitalELibrary/1.0 (educational)" }, signal: AbortSignal.timeout(ms || 15000) });
  if (!r.ok) throw new Error(url + " " + r.status);
  return r.json();
}

function cleanBook(b) {
  return {
    id: b.id,
    title: safeText(b.title, 140),
    author: safeText(((b.authors && b.authors[0] && b.authors[0].name) || "Unknown").replace(/,\s*/, ", "), 80),
    cover: (b.formats && b.formats["image/jpeg"]) || "",
    subjects: (b.subjects || []).slice(0, 4).map(s => safeText(s, 60)),
    downloads: b.download_count || 0
  };
}

async function catalog(q) {
  const search = safeText(q.q, 80).trim().toLowerCase();
  const all = Object.entries(SHELVES).flatMap(([s, bs]) => bs.map(b => shelfBook(s, b)));
  if (!search) {
    const shelf = SHELVES[q.shelf] ? q.shelf : "";
    const books = shelf ? SHELVES[shelf].map(b => shelfBook(shelf, b)) : all;
    return { books, shelves: Object.keys(SHELVES) };
  }
  const local = all.filter(b => (b.title + " " + b.author).toLowerCase().includes(search));
  let more = [];
  try {
    const j = await jget("https://gutendex.com/books/?" + new URLSearchParams({ languages: "en", search }), 8000);
    more = (j.results || [])
      .filter(b => b.formats && Object.keys(b.formats).some(f => f.startsWith("text/plain")))
      .map(cleanBook)
      .filter(b => !BLOCKED.test(b.title + " " + b.subjects.join(" ")) && !local.some(l => l.id === b.id));
  } catch (e) { /* Gutendex can be slow; curated matches still return */ }
  return { books: [...local, ...more], shelves: Object.keys(SHELVES) };
}


async function discover(q) {
  const params = new URLSearchParams({
    q: safeText(q.q, 80).trim() || "subject:juvenile_fiction",
    limit: "24",
    fields: "key,title,author_name,cover_i,first_publish_year,subject"
  });
  const j = await jget("https://openlibrary.org/search.json?" + params);
  const books = (j.docs || []).map(d => ({
    title: safeText(d.title, 140),
    author: safeText((d.author_name || ["Unknown"])[0], 80),
    year: d.first_publish_year || "",
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : "",
    url: "https://openlibrary.org" + d.key,
    subjects: (d.subject || []).slice(0, 4).map(s => safeText(s, 40))
  })).filter(b => !BLOCKED.test(b.title + " " + b.subjects.join(" ")));
  return { books };
}

async function bookText(id) {
  if (textCache.has(id)) return textCache.get(id);
  const url = `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("text " + r.status);
  let t = (await r.text()).replace(/\r/g, "");
  const meta = { title: (t.match(/^Title: (.+)$/m) || [])[1], author: (t.match(/^Author: (.+)$/m) || [])[1] };
  const s = t.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/);
  if (s >= 0) t = t.slice(t.indexOf("\n", s) + 1);
  const e = t.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/);
  if (e >= 0) t = t.slice(0, e);
  const paras = t.split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, " ").trim()).filter(p => p.length > 1);
  const out = { id, title: safeText(meta.title, 140), author: safeText(meta.author, 80), paragraphs: paras.slice(0, 4000) };
  if (textCache.size > 20) textCache.delete(textCache.keys().next().value);
  textCache.set(id, out);
  return out;
}

async function newCode() {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    if (!(await T.get("codes", "code", c))) return c;
  }
  throw new Error("No free codes");
}

module.exports = async function (context, req) {
  const send = begin(context, req);
  if (!send) return;
  const action = context.bindingData.action;
  const ip = clientIp(req);
  const body = req.body || {};

  try {
    if (action === "login") {
      if (req.method !== "POST") return send(405, { error: "POST only" });
      if (limited("login:" + ip, 10, 10 * 60000)) return send(429, { error: "Too many tries. Please ask your librarian." });
      const code = String(body.code || "");
      const e = codeOk(code) && await T.get("codes", "code", code);
      if (!e || !e.active) return send(401, { error: "That code is not valid. Please check with your librarian." });
      await T.merge("codes", "code", code, { lastSeen: new Date().toISOString(), sessions: (e.sessions || 0) + 1 });
      return send(200, { name: e.name, token: sign({ c: code, n: e.name, exp: Date.now() + SESSION_MS }) });
    }

    if (action === "admin") {
      if (req.method !== "POST") return send(405, { error: "POST only" });
      if (limited("admin:" + ip, 30, 10 * 60000)) return send(429, { error: "Too many tries." });
      if (!isAdmin(req)) return send(401, { error: "Wrong admin passcode" });
      const op = body.op;
      if (op === "list") {
        const rows = (await T.list("codes", "code")).map(e => ({
          code: e.RowKey, name: e.name, active: !!e.active, created: e.created, lastSeen: e.lastSeen || "",
          sessions: e.sessions || 0, reads: e.reads || 0, stars: e.stars || 0
        })).sort((a, b) => a.name.localeCompare(b.name));
        const alerts = (await T.list("alerts", "alert")).map(a => ({ id: a.RowKey, time: a.time, name: a.name, text: a.text, reviewed: !!a.reviewed }))
          .sort((a, b) => b.time.localeCompare(a.time)).slice(0, 50);
        return send(200, { codes: rows, alerts });
      }
      if (op === "create") {
        const name = safeText(body.name, 40).trim();
        if (!name) return send(400, { error: "Enter the learner's name" });
        const code = await newCode();
        await T.put("codes", "code", code, { name, active: true, created: new Date().toISOString(), sessions: 0, reads: 0, stars: 0 });
        return send(200, { code, name });
      }
      if ((op === "revoke" || op === "restore" || op === "delete") && codeOk(body.code)) {
        if (op === "delete") await T.del("codes", "code", body.code);
        else await T.merge("codes", "code", body.code, { active: op === "restore" });
        activeCache.delete(body.code);
        return send(200, { ok: true });
      }
      if (op === "review" && body.id) {
        await T.merge("alerts", "alert", String(body.id), { reviewed: true });
        return send(200, { ok: true });
      }
      return send(400, { error: "Unknown operation" });
    }

    // Everything below requires a valid access-code session.
    const s = await sessionFrom(req);
    if (!s) return send(401, { error: "Please sign in with your code." });

    if (action === "track") {
      const e = await T.get("codes", "code", s.c);
      if (e) await T.merge("codes", "code", s.c, {
        reads: (e.reads || 0) + (body.read ? 1 : 0),
        stars: Math.max(e.stars || 0, Math.min(parseInt(body.stars, 10) || 0, 100000)),
        lastSeen: new Date().toISOString()
      });
      return send(200, { ok: true });
    }
    if (action === "catalog") return send(200, await catalog(req.query));
    if (action === "discover") return send(200, await discover(req.query));
    if (action === "text") {
      const id = parseInt(req.query.id, 10);
      if (!id || id < 1 || id > 9999999) return send(400, { error: "Bad id" });
      return send(200, await bookText(id));
    }
    return send(404, { error: "Not found" });
  } catch (e) {
    context.log.error(e);
    return send(502, { error: "The library service is busy. Please try again." });
  }
};
