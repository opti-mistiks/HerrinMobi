const https = require("https");

const MODEL = "openai/gpt-oss-120b";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function groqRequest(body, retries = 3) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 30000,
    };

    const req = https.request(options, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", async () => {
        const text = Buffer.concat(chunks).toString("utf8");

        if (res.statusCode === 429 && retries > 0) {
          // Groq's Retry-After can be huge once you hit the daily/hourly
          // token quota (not just a per-second burst limit) — the log
          // showed waits up to ~1.5M ms (25 min) per single retry. Sleeping
          // that long inline burns through the whole GitHub Actions job
          // budget for one article. Cap the wait so we either back off a
          // reasonable amount or fail fast and let updateNews.js move on /
          // the job finish, instead of stalling for tens of minutes.
          const rawWait = parseFloat(res.headers["retry-after"] || "5") * 1000;
          const MAX_WAIT_MS = 60000; // never sleep more than 60s on one retry
          if (rawWait > MAX_WAIT_MS) {
            reject(new Error(`Groq rate limit requests a ${Math.round(rawWait / 1000)}s wait — giving up (quota likely exhausted)`));
            return;
          }
          console.warn(`[groq] Rate limit, retrying in ${rawWait}ms...`);
          await sleep(rawWait);
          groqRequest(body, retries - 1).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Groq HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
          return;
        }

        try { resolve(JSON.parse(text)); }
        catch { reject(new Error("Failed to parse Groq response")); }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(payload);
    req.end();
  });
}

const LEVEL_CONFIG = {
  A1: {
    textInstruction: "Write 4-5 sentences, roughly 6-12 words each, using ONLY grammar from an A1 course (Lektion 1-14 level): Präsens of regular and irregular verbs (sein, haben, and verbs with vowel change like sprechen/fahren/sehen), separable verbs (aufstehen, einkaufen, anrufen — verb splits: 'Er kauft ... ein'), Perfekt with haben/sein for simple facts ('Er ist gegangen', 'Sie hat gearbeitet'), modal verbs können/wollen/müssen/dürfen/sollen, definite/indefinite/negative articles, possessive articles (mein/dein/sein/ihr), Akkusativ and Dativ of definite/indefinite articles, simple prepositions (in, an, bei, mit, nach, seit, vor, für, zu) with their case, and basic W-questions. Connect clauses naturally with 'und', 'aber', 'dann', or 'oder' where it fits — don't write a robotic list of isolated facts. Do NOT use Nebensätze (weil/dass/wenn), Konjunktiv, or Passiv. Avoid compound nouns when a simpler word exists. Keep only the article's MOST IMPORTANT 2-3 facts (who/what happened, and one key detail like where/when/how much) — dropping minor details is correct at this level, but every sentence you write must still describe something that is actually IN the source article. Do not invent a different, simpler everyday scene just because the real story is hard to express in A1 grammar.",
    hintExclusions: 'NEVER include: sein, haben, werden, machen, gehen, kommen, sehen, sagen, wollen, können, müssen; all pronouns; all articles; all numbers; country/city names; obvious cognates with Ukrainian or English.',
    hintGuidance: 'An A1 learner\'s vocabulary is small, so most non-basic words in the text will be genuinely new to them — but this is also the shortest text (4-5 sentences), so there is a hard ceiling on how many distinct hint-worthy words even exist. Include every word in the text that a real A1 learner would not yet know, typically around 4-6 words for a text this length — do not pad the list with basic words just to hit a number, and do not skip a genuinely unfamiliar word just to keep the list short.',
  },
  A2: {
    textInstruction: "Write 5-7 sentences that read as a natural, connected mini-story, not a checklist of facts, using grammar from an A2 course: Perfekt (including separable verbs like 'eingekauft', non-separable verbs like 'erlebt/verstanden', and -ieren verbs like 'telefoniert' without ge-), the subordinating conjunction 'weil' for reasons, coordinating conjunctions und/aber/oder/denn, the connector 'trotzdem', Wechselpräpositionen (an/auf/in/neben/vor/hinter + Dativ for location or Akkusativ for direction), comparison (Komparativ/Superlativ, 'als'/'wie'), simple adjective endings after der/ein (definiter/indefiniter Artikel), and simple Konjunktiv II only for polite requests or wishes ('Ich hätte gern...', 'Das wäre...') if it fits naturally — don't force it. Do NOT use complex Nebensätze with dass/wenn/obwohl, Passiv, or Konjunktiv II for hypotheticals. Vocabulary: daily life, work, shopping, weather, feelings. Keep the article's main facts (who, what happened, key numbers/places/reasons) — you may simplify or drop minor details, but every sentence must describe something that is actually IN the source article, not a different, easier-to-write scenario you made up.",
    hintExclusions: 'NEVER include: basic everyday A1-A2 words; country/city names; obvious cognates.',
    hintGuidance: 'This text is longer than the A1 one (5-7 sentences) and reaches into A2-specific vocabulary, so expect noticeably more hint-worthy words than A1 — typically around 6-9. Include every word in the text an A2 learner would not yet reliably know; don\'t artificially cap the list, and don\'t include words an A2 learner already knows just to fill it out.',
  },
  B1: {
    textInstruction: "Write 7-9 sentences as a natural, flowing narrative — vary sentence length and structure the way a real short news piece would. You may use Nebensätze (weil, dass, wenn, obwohl), Konjunktiv II for hypotheticals, and simple Passiv. Preserve the article's key facts, numbers, names, and the actual sequence/cause-effect of events from the original — a B1 reader can handle real complexity, so there is no need to simplify away real content here.",
    hintExclusions: "NEVER include: words any B1 student already knows; obvious cognates.",
    hintGuidance: 'This is the longest and most advanced text (7-9 sentences, real news vocabulary — politics, economy, specialized terms), so it will typically contain the most hint-worthy words of the three levels, often 8-12 or more. List every word in the text a B1 student would genuinely need explained — do not stop at a round number if more of the text\'s vocabulary is actually unfamiliar at this level, and do not list something a B1 student already knows just to lengthen it.',
  },
};

async function simplifyArticle(article, level) {
  const cfg = LEVEL_CONFIG[level];

  const systemPrompt = `You are a Swiss High German teacher creating reading exercises.
SWISS GERMAN RULE: NEVER use "ß" — always write "ss".
Output: single minified JSON object. No markdown, no backticks.

=== CRITICAL RULE: STAY FAITHFUL TO THE SOURCE ===
The simplified text must describe the SAME real event(s) as the source
article below — same topic, same people/organizations/places involved, same
basic outcome. You are allowed to CUT details that are too complex for the
level (numbers, sub-clauses, background context) — you are NEVER allowed to
INVENT a different, easier scene (e.g. turning a political/economic/health
news story into an everyday personal anecdote about shopping, chores, or
a walk in the park) just because the real story is hard to phrase within
the level's grammar. If the source is too dense to compress fully, simplify
by cutting to the single most important fact and stating just that in
correct level-appropriate grammar — never by substituting fiction for it.

=== TASK ===
1. SIMPLIFIED TEXT ("simplified_text_deu"):
${cfg.textInstruction}
Write in Swiss High German (no "ß").

2. VOCABULARY HINTS ("vocabulary_hints_ukr") — array of strings:
- Pick words that APPEAR IN YOUR SIMPLIFIED TEXT
- Pick words a ${level} learner genuinely does NOT know
- ${cfg.hintExclusions}
- Do NOT target a fixed count. ${cfg.hintGuidance} The right number is however
  many words in THIS text actually meet that bar — it will vary article to
  article depending on how much unfamiliar vocabulary the text happens to use.
- Format: "das Wort — українське значення"
  * Nouns: include article + plural if useful: "die Wahl, -en — вибори"
  * Verbs: infinitive: "sich ausbreiten — поширюватись"
  * ALWAYS give real Ukrainian meaning, NEVER "die X — X"

3. CATEGORY ("category"):
One word: Wetter / Politik / Sport / Wirtschaft / Gesundheit / Gesellschaft / Verkehr / Kultur / Wissenschaft

=== OUTPUT ===
Return ONLY valid JSON, nothing else, no explanation, no markdown:
{"simplified_text_deu":"...","vocabulary_hints_ukr":["..."],"category":"..."}`;

  const truncatedDescription = article.description.slice(0, 1500);
  const maxAttempts = 3;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const data = await groqRequest({
        model: MODEL,
        temperature: 0.1,
        max_tokens: 3000,
        reasoning_effort: "low",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: `Title: ${article.title}\nArticle: ${truncatedDescription}` },
        ],
      });

      const raw = data.choices?.[0]?.message?.content || "";
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());

      if (!parsed.simplified_text_deu || !Array.isArray(parsed.vocabulary_hints_ukr) || !parsed.category) {
        throw new Error("Missing required fields in parsed JSON");
      }

      const validHints = parsed.vocabulary_hints_ukr.filter(h => h.includes(" — "));

      return {
        id:              generateId(article.title, level),
        originalTitle:   article.title,
        simplifiedText:  parsed.simplified_text_deu || "",
        vocabularyHints: validHints,
        category:        parsed.category || "Gesellschaft",
        imageUrl:        article.imageUrl || null,
        publishedAt:     article.pubDate || null,
        processedAt:     new Date().toISOString(),
      };
    } catch (err) {
      lastErr = err;
      console.warn(`  ⚠️  Attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt < maxAttempts) await sleep(2000);
    }
  }

  throw lastErr;
}

function generateId(title, level) {
  const str = `${level}:${title}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

module.exports = { simplifyArticle };
