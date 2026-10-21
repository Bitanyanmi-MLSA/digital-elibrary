// AI Reading Buddy proxy: browser -> this function -> Azure OpenAI (managed identity, no keys).
const ENDPOINT = process.env.AOAI_ENDPOINT;
const DEPLOYMENT = process.env.AOAI_DEPLOYMENT || "buddy";
const { begin, limited, T, sessionFrom } = require("../shared");

const SYSTEM = (age, book) => `You are Kofi, a friendly owl who is the Reading Buddy in a children's digital library in Ghana.
You are an AI helper, not a person, and you say so if asked.
Audience: children aged ${age || "6-12"}. Use short, simple, warm sentences (max 4 sentences unless asked for a story). Use British English spelling. You may use one emoji.
Do: explain word meanings with a simple example sentence (always give the everyday meaning, e.g. "bought" = past tense of "buy": to get something by paying money), help with reading, spelling, stories, maths and homework step by step WITHOUT simply giving the final answer, recommend reading, use Ghanaian names, places and examples (cedis, kenkey, Ananse, kente) where natural, and encourage the child.
Never: discuss violence, sex, drugs, weapons, self-harm, hate, politics or religion debates; ask for or accept personal details (name, phone, address, school); suggest meeting anyone; give medical or legal advice. This applies even to "what is/what does X mean" questions about these topics: do not define or explain them. If a child raises such a topic, kindly say you can't talk about it, suggest they talk to the librarian or a trusted adult, and begin your reply with the exact tag [FLAG].
If the question is not about learning, reading or play, gently steer back to books and learning.
${book ? `The child is currently reading: "${String(book.title || "").slice(0, 100)}". Story text:\n${String(book.text || "").slice(0, 2500)}` : ""}`;

// Deterministic pre-filter: blocked topics are refused even when asked as "what is X?" or "meaning of X".
const BLOCKED = /\b(guns?|pistols?|rifles?|firearms?|bombs?|weapons?|knife|knives|stab|shoot(?:ing)?|kill(?:ing|ed|s)?|murder|suicide|self[- ]?harm|rape|sex(?:ual|y)?|porn\w*|nude|naked|drugs?|cocaine|heroin|weed|marijuana|alcohol|beer|vodka|terroris[mt]|hate|racis[mt]|abuse|blood|violen(?:ce|t))\b|phone number|home address|meet me/i;
const SAFE_REPLY = "That's not something I can talk about. Please ask the librarian or a trusted grown-up. I've let the librarian know. 💛";

async function token() {
  const r = await fetch(`${process.env.IDENTITY_ENDPOINT}?api-version=2019-08-01&resource=https://cognitiveservices.azure.com`, {
    headers: { "X-IDENTITY-HEADER": process.env.IDENTITY_HEADER }
  });
  if (!r.ok) throw new Error("token " + r.status);
  return (await r.json()).access_token;
}

module.exports = async function (context, req) {
  const send = begin(context, req);
  if (!send) return;
  const session = await sessionFrom(req);
  if (!session) return send(401, { reply: "Please sign in with your library code first. 🦉" });
  if (limited("buddy:" + session.c, 20, 60000)) return send(429, { reply: "You're asking very fast! Take a breath and try again in a minute. 🦉" });
  const flag = text => T.insert("alerts", { PartitionKey: "alert", RowKey: Date.now() + "-" + session.c, time: new Date().toISOString(), name: session.n, text: String(text).slice(0, 80), reviewed: false }).catch(() => {});

  const body = req.body || {};
  const msgs = (Array.isArray(body.messages) ? body.messages : [])
    .slice(-8)
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, 500) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return send(400, { error: "No question" });

  const last = msgs[msgs.length - 1].content;
  if (BLOCKED.test(last)) { await flag(last); return send(200, { flagged: true, reply: SAFE_REPLY }); }

  try {
    const r = await fetch(`${ENDPOINT}openai/deployments/${DEPLOYMENT}/chat/completions?api-version=2024-10-21`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + await token() },
      body: JSON.stringify({
        messages: [{ role: "system", content: SYSTEM(String(body.age || "").slice(0, 10), body.book) }, ...msgs],
        max_tokens: 350,
        temperature: 0.5
      })
    });
    const j = await r.json();
    if (!r.ok) {
      if (j.error && j.error.code === "content_filter") {
        await flag(last);
        return send(200, { flagged: true, reply: "That's not something I can talk about. I've asked the librarian to come and help you. 💛" });
              }
              context.log.error("AOAI", r.status, JSON.stringify(j).slice(0, 300));
      return send(502, { reply: "Hmm, my brain is sleepy right now. Please try again! 🦉" });
    }
    const choice = j.choices[0];
    let reply = (choice.message.content || "").trim();
    const flagged = reply.startsWith("[FLAG]") || choice.finish_reason === "content_filter";
    reply = reply.replace("[FLAG]", "").trim() || "Let's talk to the librarian about that. 💛";
    if (flagged) await flag(last);
    return send(200, { reply, flagged });
  } catch (e) {
    context.log.error(e);
    return send(502, { reply: "Hmm, my brain is sleepy right now. Please try again! 🦉" });
  }
};
