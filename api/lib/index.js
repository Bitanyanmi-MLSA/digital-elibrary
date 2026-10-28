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
// Adult shelves are only served to sessions whose code was created as "adult".
const ADULT_SHELVES = {
  "Classic Literature": [[1342, "Pride and Prejudice", "Jane Austen"], [1260, "Jane Eyre", "Charlotte Brontë"], [768, "Wuthering Heights", "Emily Brontë"], [98, "A Tale of Two Cities", "Charles Dickens"], [1400, "Great Expectations", "Charles Dickens"], [2701, "Moby-Dick", "Herman Melville"], [2554, "Crime and Punishment", "Fyodor Dostoevsky"], [64317, "The Great Gatsby", "F. Scott Fitzgerald"]],
  "Mystery & Thrillers": [[1661, "The Adventures of Sherlock Holmes", "Arthur Conan Doyle"], [2852, "The Hound of the Baskervilles", "Arthur Conan Doyle"], [345, "Dracula", "Bram Stoker"], [84, "Frankenstein", "Mary Shelley"], [174, "The Picture of Dorian Gray", "Oscar Wilde"], [1184, "The Count of Monte Cristo", "Alexandre Dumas"]],
  "Philosophy & Leadership": [[1232, "The Prince", "Niccolò Machiavelli"], [2680, "Meditations", "Marcus Aurelius"], [132, "The Art of War", "Sun Tzu"], [1497, "The Republic", "Plato"], [205, "Walden", "Henry David Thoreau"], [5827, "The Problems of Philosophy", "Bertrand Russell"]],
  "Science & Society": [[1228, "On the Origin of Species", "Charles Darwin"], [3300, "The Wealth of Nations", "Adam Smith"], [35, "The Time Machine", "H. G. Wells"], [36, "The War of the Worlds", "H. G. Wells"], [4363, "Beyond Good and Evil", "Friedrich Nietzsche"]],
  // SHS study shelves: public-domain texts only (current Ghana SHS textbooks are copyrighted and cannot be hosted).
  "SHS Science": [[14474, "The Chemical History of a Candle", "Michael Faraday"], [20848, "An Elementary Study of Chemistry", "William McPherson & William E. Henderson"], [22766, "Electricity for Boys", "James Slough Zerbe"], [28553, "How it Works", "Archibald Williams"], [15491, "Micrographia", "Robert Hooke"], [944, "The Voyage of the Beagle", "Charles Darwin"]],
  "SHS Mathematics": [[33283, "Calculus Made Easy", "Silvanus P. Thompson"], [13309, "A First Book in Algebra", "Wallace C. Boyden"], [38536, "A Review of Algebra", "Romeyn Henry Rivenburg"], [21154, "Philosophy and Fun of Algebra", "Mary Everest Boole"], [32973, "Elements of Plane Trigonometry", "Hugh Blackburn"], [21076, "The First Six Books of the Elements of Euclid", "John Casey"], [68662, "Elements of Arithmetic", "Augustus De Morgan"], [201, "Flatland", "Edwin A. Abbott"]],
  "SHS Geography & Agriculture": [[61652, "Physical Geography", "Mary Somerville"], [37957, "Man and Nature: Physical Geography as Modified by Human Action", "George P. Marsh"], [27378, "The Story of the Heavens", "Robert S. Ball"], [25267, "Astronomy for Amateurs", "Camille Flammarion"], [70973, "The Agricultural and Forest Products of British West Africa", "Gerald C. Dudgeon"], [30975, "Soil Culture", "J. H. Walden"], [79736, "Journal of a Residence in Ashantee", "Joseph Dupuis"]],
  "SHS English Literature": [[1522, "Julius Caesar", "William Shakespeare"], [1533, "Macbeth", "William Shakespeare"], [2267, "Othello", "William Shakespeare"], [1513, "Romeo and Juliet", "William Shakespeare"], [1524, "Hamlet", "William Shakespeare"], [2243, "The Merchant of Venice", "William Shakespeare"]],
  "Economics & Government": [[3300, "The Wealth of Nations", "Adam Smith"], [61, "The Communist Manifesto", "Karl Marx & Friedrich Engels"], [46333, "The Social Contract & Discourses", "Jean-Jacques Rousseau"], [60979, "Reminiscences of a Stock Operator", "Edwin Lefèvre"]]
};
const shelvesFor = adult => adult ? ADULT_SHELVES : SHELVES;
const coverOf = id => `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`;
const shelfBook = (shelf, [id, title, author]) => ({ id, title, author, cover: coverOf(id), subjects: [shelf] });
const SESSION_MS = 12 * 3600 * 1000;
const ONLINE_MS = 150 * 1000; // heartbeat is every 60s
const textCache = new Map();

const safeText = (s, n) => String(s || "").slice(0, n);
const codeOk = c => /^\d{4}$/.test(String(c));
// Codes created before adult support have no type and stay kids codes.
const typeOf = e => (e && e.type === "adult" ? "adult" : "kids");

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

async function catalog(q, adult) {
  const SH = shelvesFor(adult);
  const search = safeText(q.q, 80).trim().toLowerCase();
  const all = Object.entries(SH).flatMap(([s, bs]) => bs.map(b => shelfBook(s, b)));
  if (!search) {
    const shelf = SH[q.shelf] ? q.shelf : "";
    const books = shelf ? SH[shelf].map(b => shelfBook(shelf, b)) : all;
    return { books, shelves: Object.keys(SH) };
  }
  const local = all.filter(b => (b.title + " " + b.author).toLowerCase().includes(search));
  let more = [];
  try {
    const j = await jget("https://gutendex.com/books/?" + new URLSearchParams({ languages: "en", search }), 8000);
    more = (j.results || [])
      .filter(b => b.formats && Object.keys(b.formats).some(f => f.startsWith("text/plain")))
      .map(cleanBook)
      .filter(b => (adult || !BLOCKED.test(b.title + " " + b.subjects.join(" "))) && !local.some(l => l.id === b.id));
  } catch (e) { /* Gutendex can be slow; curated matches still return */ }
  return { books: [...local, ...more], shelves: Object.keys(SH) };
}


async function discover(q, adult) {
  const params = new URLSearchParams({
    q: safeText(q.q, 80).trim() || (adult ? "subject:fiction" : "subject:juvenile_fiction"),
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
  })).filter(b => adult || !BLOCKED.test(b.title + " " + b.subjects.join(" ")));
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
      const now = new Date().toISOString();
      await T.merge("codes", "code", code, { lastSeen: now, sessionStart: now, online: true, sessions: (e.sessions || 0) + 1 });
      const type = typeOf(e);
      return send(200, { name: e.name, type, token: sign({ c: code, n: e.name, t: type, exp: Date.now() + SESSION_MS }) });
    }

    if (action === "admin") {
      if (req.method !== "POST") return send(405, { error: "POST only" });
      if (limited("admin:" + ip, 30, 10 * 60000)) return send(429, { error: "Too many tries." });
      if (!isAdmin(req)) return send(401, { error: "Wrong admin passcode" });
      const op = body.op;
      if (op === "list") {
        const rows = (await T.list("codes", "code")).map(e => ({
          code: e.RowKey, name: e.name, type: typeOf(e), active: !!e.active, created: e.created, lastSeen: e.lastSeen || "",
          sessions: e.sessions || 0, reads: e.reads || 0, stars: e.stars || 0,
          totalSecs: e.totalSecs || 0,
          online: !!e.online && !!e.active && Date.now() - Date.parse(e.lastSeen || 0) < ONLINE_MS,
          sessionSecs: e.sessionStart && e.lastSeen ? Math.max(0, Math.round((Date.parse(e.lastSeen) - Date.parse(e.sessionStart)) / 1000)) : 0
        })).sort((a, b) => a.name.localeCompare(b.name));
        const alerts = (await T.list("alerts", "alert")).map(a => ({ id: a.RowKey, time: a.time, name: a.name, text: a.text, reviewed: !!a.reviewed }))
          .sort((a, b) => b.time.localeCompare(a.time)).slice(0, 50);
        return send(200, { codes: rows, alerts });
      }
      if (op === "create") {
        const name = safeText(body.name, 40).trim();
        if (!name) return send(400, { error: "Enter the member's name" });
        if (body.type !== "kids" && body.type !== "adult") return send(400, { error: "Choose Kids or Adult" });
        const code = await newCode();
        await T.put("codes", "code", code, { name, type: body.type, active: true, created: new Date().toISOString(), sessions: 0, reads: 0, stars: 0 });
        return send(200, { code, name, type: body.type });
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
      if (e) {
        const now = Date.now();
        const last = Date.parse(e.lastSeen || 0) || 0;
        const gap = now - last;
        // Count time only between heartbeats close together; longer gaps mean the app was closed.
        const add = e.online && gap > 0 && gap < ONLINE_MS ? Math.round(gap / 1000) : 0;
        const fresh = !e.online || gap >= ONLINE_MS;
        const upd = {
          reads: (e.reads || 0) + (body.read ? 1 : 0),
          stars: Math.max(e.stars || 0, Math.min(parseInt(body.stars, 10) || 0, 100000)),
          lastSeen: new Date(now).toISOString(),
          totalSecs: (e.totalSecs || 0) + add,
          online: !body.logout
        };
        if (fresh) upd.sessionStart = upd.lastSeen;
        await T.merge("codes", "code", s.c, upd);
      }
      return send(200, { ok: true });
    }
    const adult = s.t === "adult";
    if (action === "catalog") return send(200, await catalog(req.query, adult));
    if (action === "discover") return send(200, await discover(req.query, adult));
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
