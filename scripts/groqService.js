const https = require("https");

const MODEL = "openai/gpt-oss-120b";

// TSN gets its own Groq API key when GROQ_API_KEY_TSN is set. Groq's rate
// limits (30 RPM / 1,000 RPD / 8K TPM / 200K TPD for this model, per
// console.groq.com/docs/rate-limits) are per API key, not shared across
// an account's models/pipelines — so a second key gives the TSN pipeline
// its own independent 1,000 RPD budget instead of splitting one budget
// with app/DE. Falls back to the main key if the TSN-specific one isn't
// configured, so nothing breaks for anyone who hasn't set it up yet.
const TSN_API_KEY = process.env.GROQ_API_KEY_TSN || process.env.GROQ_API_KEY;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function groqRequest(body, retries = 3, apiKey = process.env.GROQ_API_KEY) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
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
          groqRequest(body, retries - 1, apiKey).then(resolve).catch(reject);
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


// ─────────────────────────────────────────────────────────────────────────
// Swiss orthography: Swiss High German has no "ß" — always "ss".
// The prompt asks for it, but LLMs still slip, so this is enforced in code
// as well (applied to title, text and every vocabulary hint).
// ─────────────────────────────────────────────────────────────────────────
function toSwiss(str) {
  if (!str) return str;
  return String(str)
    .replace(/ß/g, "ss").replace(/ẞ/g, "SS")
    // Look-alike characters the model sometimes emits. They break exact
    // matching between the text and the vocabulary list (e.g. "IT‑Leiterin"
    // with a non-breaking hyphen never matched "IT-Leiterin").
    .replace(/[\u2010\u2011\u2012\u2013]/g, "-")   // hyphens / en dash -> "-"
    .replace(/[\u202F\u00A0\u2009]/g, " ")          // narrow / no-break spaces -> " "
    .replace(/\u2019/g, "'");                        // curly apostrophe
}

// ─────────────────────────────────────────────────────────────────────────
// Category is decided ONCE per source article (not once per level), so the
// same news item always shows the same tag on A1, A2 and B1. Previously
// every level asked the model again and got e.g. "Politik" on A1 but
// "Gesundheit" on A2 for the very same story.
// Order matters: the first matching rule wins, most specific first.
// ─────────────────────────────────────────────────────────────────────────
const CATEGORIES = [
  "Wetter", "Politik", "Sport", "Wirtschaft", "Gesundheit",
  "Gesellschaft", "Verkehr", "Kultur", "Wissenschaft",
];

const CATEGORY_RULES = [
  ["Wetter",       /\b(wetter|unwetter|sturm|gewitter|hitze|kälte|schnee|regen|hagel|nebel|meteo|temperatur|orkan|überschwemm)/i],
  ["Sport",        /\b(fussball|football|eishockey|hockey|tennis|ski|skifahr|biathlon|kanu|rudern|velo|radrennen|tour de|olympi|meisterschaft|em\b|wm\b|super league|cup|trainer|spieler|match|sieg|niederlage|turnier|formel 1|f1\b|marathon|schwing|nati\b)/i],
  ["Verkehr",      /\b(verkehr|stau|sbb|zug|züge|bahn|autobahn|strasse|strassen|flughafen|flug|tunnel|gotthard|fahrplan|unfall|velo|bus\b|tram|lastwagen|lkw|sperrung|baustelle)/i],
  ["Gesundheit",   /\b(spital|spitäler|krankenhaus|krankenkasse|krankenkassen|prämie|arzt|ärzte|ärztin|patient|medizin|medikament|impf|virus|grippe|krebs|therapie|gesundheit|pflege|operation|klinik|psych|diagnose)/i],
  ["Wissenschaft", /\b(forscher|forschung|studie|wissenschaft|universität|eth\b|epfl|klima|weltraum|nasa|esa\b|planet|gen\b|dna|experiment|entdeck|künstliche intelligenz|ki\b|technologie|roboter)/i],
  ["Kultur",       /\b(film|kino|musik|konzert|festival|theater|buch|roman|künstler|kunst|museum|ausstellung|serie|star|sänger|schauspiel|oper|album|netflix|promi|show)/i],
  ["Wirtschaft",   /\b(wirtschaft|firma|firmen|unternehmen|konzern|börse|aktie|franken|euro|dollar|inflation|zoll|zölle|handel|bank|ubs|nestlé|novartis|roche|swiss\b|stellen|entlass|umsatz|gewinn|preis|preise|miete|mieten|lohn|löhne|steuer|steuern|konkurs|sparen|kosten|export|import)/i],
  ["Politik",      /\b(bundesrat|parlament|nationalrat|ständerat|regierung|abstimmung|initiative|wahl|wahlen|partei|svp|sp\b|fdp|mitte\b|grüne|gericht|urteil|bundesgericht|gesetz|verordnung|minister|präsident|eu\b|nato|krieg|ukraine|russland|putin|trump|usa|sanktion|asyl|migration)/i],
];

// A source-specific hint from the RSS feed name is the fallback before the
// generic "Gesellschaft" bucket.
const SOURCE_CATEGORY = {
  "20min Sport": "Sport",
  "20min Entertainment": "Kultur",
  "20min Wissen": "Wissenschaft",
  "20min Lifestyle": "Gesellschaft",
};

function detectCategory(article) {
  const hay = `${article.title || ""} ${(article.description || "").slice(0, 400)}`;
  // Title counts double: it is the strongest signal of what the story is about.
  const title = article.title || "";
  for (const [cat, re] of CATEGORY_RULES) {
    if (re.test(title)) return cat;
  }
  for (const [cat, re] of CATEGORY_RULES) {
    if (re.test(hay)) return cat;
  }
  return SOURCE_CATEGORY[article.source] || "Gesellschaft";
}

// ─────────────────────────────────────────────────────────────────────────
// STORY CORE — resolved ONCE per source article and shared by A1, A2 and B1.
//
// Why: each level used to be a fully independent LLM call over the raw RSS
// text, so the model was free to pick a different angle / different tag for
// every level (Politik on A1, Gesundheit on A2 for the same story). Now one
// short call decides the category AND writes a neutral "core" (the 1-2 facts
// that every level must be about). All three level prompts get the same core,
// so the topic cannot drift between levels.
//
// If this call fails, the keyword rules above are the fallback, so a Groq
// hiccup never blocks an article — it just loses the smarter category.
// ─────────────────────────────────────────────────────────────────────────
const coreCache = new Map(); // key: article.title -> Promise<{category, core}>

async function resolveStoryCore(article) {
  const key = article.title;
  if (coreCache.has(key)) return coreCache.get(key);

  const p = (async () => {
    const fallback = { category: detectCategory(article), core: "" };
    const system = `You classify Swiss news articles. Output a single minified JSON object, no markdown.
Never use the letter "ß" (Swiss spelling: always "ss").

Return:
{"category":"<one of: ${CATEGORIES.join(" / ")}>","core":"<ONE plain German sentence, max 25 words, stating the single main fact of the article: who did/what happened. Only facts present in the source. No opinions, no invented details.>"}

Category rules: choose by what the story is MAINLY about.
- Sport: any athlete, team, match, competition, sports figure (even if the news is about death, health or money).
- Gesundheit: hospitals, doctors, illness, health insurance, medicine.
- Politik: government, parliament, courts, elections, laws, war, international politics.
- Wirtschaft: companies, prices, jobs, money, housing costs, consumer topics.
- Wissenschaft: research, studies, nature, animals, climate science, technology.
- Kultur: film, music, art, celebrities, entertainment.
- Verkehr: traffic, trains, roads, accidents on roads/rails, airports.
- Wetter: weather events.
- Gesellschaft: everyday life, people stories, crime, social topics that fit none of the others.`;
    try {
      const data = await groqRequest({
        model: MODEL,
        temperature: 0,
        max_tokens: 400,
        reasoning_effort: "low",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Title: ${toSwiss(article.title)}\nArticle: ${toSwiss(article.description.slice(0, 1200))}` },
        ],
      });
      const raw = data.choices?.[0]?.message?.content || "";
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      const category = CATEGORIES.includes(parsed.category) ? parsed.category : fallback.category;
      const core = toSwiss(String(parsed.core || "")).trim();
      return { category, core };
    } catch (err) {
      console.warn(`  ⚠️  Story-core lookup failed, using keyword fallback: ${err.message}`);
      return fallback;
    }
  })();

  coreCache.set(key, p);
  return p;
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
  // Decided once per source article — identical on A1/A2/B1 (see above).
  const { category, core } = await resolveStoryCore(article);
  // resolveStoryCore and the simplify call below are two back-to-back Groq
  // requests with nothing between them — against Groq's 30 RPM cap that's
  // effectively 2x the intended rate for a brief burst. A small gap here
  // (on top of the per-level/per-article pause in updateNews.js) keeps
  // actual request spacing closer to what that outer pause is meant to
  // provide.
  await sleep(1000);
  const cleanTitle = toSwiss(article.title);

  const systemPrompt = `You are a teacher of SWISS High German (Schweizer Hochdeutsch) creating reading exercises.

=== SWISS ORTHOGRAPHY (MANDATORY) ===
- The letter "ß" does NOT exist in Swiss Standard German. NEVER output "ß" anywhere
  (text, vocabulary, everywhere). Always write "ss": "Strasse" (not "Straße"),
  "heissen", "Fussball", "gross", "beschliessen", "Massnahme", "weiss", "draussen".
- Use Swiss written conventions: "Velo" (not Fahrrad) only if the source uses it;
  keep Swiss proper names and places exactly as in the source (e.g. "Kanton Schwyz",
  "Bundesrat", "SBB", "Franken").
- Otherwise standard grammar and spelling (no dialect words like "Znüni", no Mundart).
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

=== SAME STORY ON EVERY LEVEL ===
This exact article is rewritten three times (A1, A2, B1) for different learners.
The topic, main actors and core fact MUST be the same on all three; only the
language complexity and the amount of detail change. The topic is: "${category}".
The headline is: "${cleanTitle}".${core ? `\nThe core fact every level must express (in some form): "${core}"` : ""}
Your text MUST clearly be about that headline and core fact — the key subject
(who/what) must appear in the first sentence. Do not add facts, places, or names
that are not in the source. Do not turn it into a different theme.

=== TASK ===
1. SIMPLIFIED TEXT ("simplified_text_deu"):
${cfg.textInstruction}
Write in Swiss High German (no "ß").

2. VOCABULARY ("vocabulary") — array of objects:
- Pick words that APPEAR IN YOUR SIMPLIFIED TEXT
- Pick words a ${level} learner genuinely does NOT know
- ${cfg.hintExclusions}
- Do NOT target a fixed count. ${cfg.hintGuidance} The right number is however
  many words in THIS text actually meet that bar — it will vary article to
  article depending on how much unfamiliar vocabulary the text happens to use.
- Each object has THREE fields:
  * "surface": the word EXACTLY as it is written in your simplified text
    (same inflection and capitalization, e.g. "geklagt", "Leiturteil", "Spitalplanung").
    It must be findable in the text by exact match. For a separable verb whose two
    parts are apart in the text (e.g. "kauft ... ein"), use only the part that
    carries the meaning as it appears ("kauft").
  * "lemma": dictionary form for the vocabulary list. Nouns with article + plural if
    useful: "die Wahl, -en"; verbs in infinitive: "klagen"; adjectives base form.
  * "ukr": the real Ukrainian meaning (NEVER copy the German word).
- Each word once only. Never list the same surface twice.

3. Do NOT return a category — it is already decided.

=== OUTPUT ===
Return ONLY valid JSON, nothing else, no explanation, no markdown:
{"simplified_text_deu":"...","vocabulary":[{"surface":"...","lemma":"...","ukr":"..."}]}`;

  const truncatedDescription = toSwiss(article.description.slice(0, 1500));
  const maxAttempts = 3;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const data = await groqRequest({
        model: MODEL,
        temperature: 0.1,
        max_tokens: 3000,
        // "low" reasoning effort occasionally makes the model split
        // simplified_text_deu into multiple quoted fragments joined by
        // commas instead of one string (json_validate_failed — observed
        // on "Klimawandel... Aletschgletscher"). "medium" gives it enough
        // room to actually assemble one valid string, same fix already
        // applied to the TSN Ukrainian pipeline above. The retry loop
        // below still covers the rare remaining failure.
        reasoning_effort: "medium",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: `Title: ${cleanTitle}\nArticle: ${truncatedDescription}` },
        ],
      });

      const raw = data.choices?.[0]?.message?.content || "";
      if (!raw.trim()) throw new Error("Groq returned an empty completion");
      let parsed;
      try {
        parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      } catch {
        // The model sometimes emits simplified_text_deu as several
        // comma-separated quoted fragments instead of one string, e.g.
        // "simplified_text_deu":"A.","B.","C.","vocabulary":[...] — which
        // is invalid JSON. Recover by merging any such leading string
        // fragments back into one string before parsing again, instead of
        // just failing straight to a retry.
        const merged = raw.replace(
          /"simplified_text_deu"\s*:\s*((?:"(?:[^"\\]|\\.)*"\s*,\s*)+"(?:[^"\\]|\\.)*")\s*,\s*"vocabulary"/,
          (_, fragments) => {
            const parts = fragments.match(/"(?:[^"\\]|\\.)*"/g) || [];
            const joined = parts.map(p => JSON.parse(p)).join(" ");
            return `"simplified_text_deu":${JSON.stringify(joined)},"vocabulary"`;
          }
        );
        parsed = JSON.parse(merged.replace(/```json|```/g, "").trim());
      }

      if (!parsed.simplified_text_deu || !Array.isArray(parsed.vocabulary)) {
        throw new Error("Missing required fields in parsed JSON");
      }

      // Hard guarantee of Swiss spelling regardless of what the model did.
      const text = toSwiss(parsed.simplified_text_deu).trim();
      const { hints, words } = buildVocabulary(parsed.vocabulary, text);

      return {
        id:              generateId(article.title, level),
        originalTitle:   cleanTitle,
        simplifiedText:  text,
        vocabularyHints: hints,
        // Exact in-text forms to render bold + tappable in the app.
        // Kept SEPARATE from vocabularyHints so older app builds keep working.
        vocabularyWords: words,
        category:        category,
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

// Turns the model's vocabulary objects into:
//   hints: ["die Wahl, -en — вибори", ...]     (the existing list format)
//   words: [{ surface, hint }, ...]             (surface = exact form in text;
//                                                hint  = the full hint line, so the
//                                                app can highlight the matching row)
// A word is kept in `words` only if its surface really occurs in the text as a
// whole word — otherwise it could never be bolded, and would just be dead data.
function buildVocabulary(vocab, text) {
  const hints = [];
  const words = [];
  const seenSurface = new Set();
  const seenHint = new Set();

  for (const v of vocab) {
    if (!v || typeof v !== "object") continue;
    const surface = toSwiss(String(v.surface || "")).trim();
    const lemma   = toSwiss(String(v.lemma || v.surface || "")).trim();
    const ukr     = String(v.ukr || "").trim();
    if (!lemma || !ukr) continue;
    // Guard against "die X — X" style non-translations.
    if (ukr.toLowerCase() === lemma.toLowerCase()) continue;

    const hint = `${lemma} — ${ukr}`;
    if (!seenHint.has(hint)) {
      seenHint.add(hint);
      hints.push(hint);
    }

    if (!surface || seenSurface.has(surface.toLowerCase())) continue;
    if (!containsWholeWord(text, surface)) continue;
    seenSurface.add(surface.toLowerCase());
    words.push({ surface, hint });
  }

  // Order everything by where the word first appears in the text, so the
  // vocabulary list reads top-to-bottom in the same order as the article.
  // Hints whose word could not be located keep their relative order at the end.
  const pos = new Map(); // hint -> index in text
  for (const w of words) {
    const m = new RegExp(`(^|[^\\p{L}])(${w.surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})([^\\p{L}]|$)`, "iu").exec(text);
    if (m) pos.set(w.hint, m.index + m[1].length);
  }
  const order = h => (pos.has(h) ? pos.get(h) : Number.MAX_SAFE_INTEGER);
  hints.sort((a, b) => order(a) - order(b));
  words.sort((a, b) => order(a.hint) - order(b.hint));
  return { hints, words };
}

function containsWholeWord(text, word) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Unicode-aware "whole word": not preceded/followed by a letter.
  return new RegExp(`(^|[^\\p{L}])${esc}([^\\p{L}]|$)`, "iu").test(text);
}

// Mirror of buildVocabulary() above, for the TSN (Ukrainian) pipeline.
// The direction is reversed: `surface`/`lemma` are Ukrainian (found in the
// Ukrainian article text the student reads), `deu` is the Swiss German word
// the student will need when translating that word INTO German — so only
// the German side goes through toSwiss(), and the hint line reads
// "українське_слово — deutsches Wort" (Ukrainian first, matching how the
// student encounters the word in the text, German second, what they'll
// need to produce).
function buildVocabularyUkrainian(vocab, text) {
  const hints = [];
  const words = [];
  const seenSurface = new Set();
  const seenHint = new Set();

  for (const v of vocab) {
    if (!v || typeof v !== "object") continue;
    const surface = String(v.surface || "").trim();
    const lemma   = String(v.lemma || v.surface || "").trim();
    const deu     = toSwiss(String(v.deu || "")).trim();
    if (!lemma || !deu) continue;
    // Guard against "слово — Слово" style non-translations.
    if (deu.toLowerCase() === lemma.toLowerCase()) continue;

    const hint = `${lemma} — ${deu}`;
    if (!seenHint.has(hint)) {
      seenHint.add(hint);
      hints.push(hint);
    }

    if (!surface || seenSurface.has(surface.toLowerCase())) continue;
    if (!containsWholeWord(text, surface)) continue;
    seenSurface.add(surface.toLowerCase());
    words.push({ surface, hint });
  }

  const pos = new Map(); // hint -> index in text
  for (const w of words) {
    const m = new RegExp(`(^|[^\\p{L}])(${w.surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})([^\\p{L}]|$)`, "iu").exec(text);
    if (m) pos.set(w.hint, m.index + m[1].length);
  }
  const order = h => (pos.has(h) ? pos.get(h) : Number.MAX_SAFE_INTEGER);
  hints.sort((a, b) => order(a) - order(b));
  words.sort((a, b) => order(a.hint) - order(b.hint));
  return { hints, words };
}

function generateId(title, level) {
  const str = `${level}:${title}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

// ─────────────────────────────────────────────────────────────────────────
// TSN.ua PIPELINE — mirrors simplifyArticle above, but the source AND the
// simplified text stay Ukrainian (no language change here). The student
// reads this Ukrainian text and translates it INTO German themselves; that
// attempt is checked client-side directly against this Ukrainian original
// (see GroqService.checkNewsTranslationToGerman in the app) — mirroring how
// the app/DE pipeline's own German text is checked directly against a
// Ukrainian attempt, with no separately pre-generated reference translation
// on either side.
// ─────────────────────────────────────────────────────────────────────────
const UK_LEVEL_CONFIG = {
  A1: {
    textInstruction: "Напиши 4-5 речень, приблизно 6-12 слів кожне, простою українською мовою: прості розповідні речення, теперішній/минулий час у звичайній формі, без складних підрядних речень (уникай 'який/яка/яке', 'оскільки', 'незважаючи на те що'). Пов'язуй речення природно словами 'і', 'але', 'потім', 'тому' — не пиши роботизований список фактів. Залиш лише 2-3 найважливіші факти статті (хто/що сталося, і одну ключову деталь: де/коли/скільки) — опускати другорядні деталі правильно на цьому рівні, але кожне речення має описувати щось, що дійсно Є в джерельній статті. Не вигадуй іншу, простішу побутову сценку лише тому, що реальну історію важко висловити простими словами.",
    hintExclusions: "НІКОЛИ не додавай підказку для базових слів рівня A1: sein, haben, werden, machen, gehen, kommen, sehen, sagen, wollen, können, müssen; займенники; артиклі; числа; назви країн/міст; очевидні когнати з українською чи англійською.)",
    hintGuidance: "Словник A1-студента малий, тож більшість не-базових слів справді будуть для нього новими — але й текст найкоротший (4-5 речень), тож підказок теж не буде багато, зазвичай близько 4-6 для тексту такої довжини.",
  },
  A2: {
    textInstruction: "Напиши 5-7 речень, які читаються як природна, зв'язна міні-історія, а не список фактів. Можна використовувати прості підрядні речення з 'тому що', 'коли', 'хоча', порівняння ('більше/менше ніж'), і трохи більше побутової лексики. Залиш головні факти статті (хто, що сталося, ключові цифри/місця/причини) — можна спрощувати чи опускати другорядні деталі, але кожне речення має описувати щось, що дійсно Є в джерельній статті, а не вигадану простішу ситуацію.",
    hintExclusions: "НІКОЛИ не додавай підказку для базових слів рівня A1-A2; назв країн/міст; очевидних когнатів.)",
    hintGuidance: "Цей текст довший за A1 (5-7 речень) і сягає лексики рівня A2, тому очікуй помітно більше підказок, ніж на A1 — зазвичай близько 6-9.",
  },
  B1: {
    textInstruction: "Напиши 7-9 речень як природну, плинну розповідь — варіюй довжину та структуру речень так, як це робить справжня коротка новина. Можна використовувати складніші підрядні речення, різні часи. Збережи ключові факти, цифри, імена та реальну послідовність/причинно-наслідкові зв'язки подій з оригіналу.",
    hintExclusions: "НІКОЛИ не додавай підказку для слів, які будь-який B1-студент вже знає; очевидних когнатів.)",
    hintGuidance: "Це найдовший і найскладніший текст (7-9 речень, реальна новинна лексика — політика, економіка, спеціалізовані терміни), тому він зазвичай матиме найбільше підказок з усіх трьох рівнів, часто 8-12 і більше. Додавай підказку для кожного слова тексту, яке B1-студенту справді знадобиться пояснити німецьким відповідником — не зупиняйся на круглому числі, якщо лексика тексту реально складніша.",
  },
};

async function simplifyArticleUkrainian(article, level) {
  const cfg = UK_LEVEL_CONFIG[level];
  const cleanTitle = String(article.title || "").trim();

  const systemPrompt = `Ти редактор, який спрощує українські новини для вивчаючих німецьку мову.
Output: single minified JSON object. No markdown, no backticks.

=== КРИТИЧНЕ ПРАВИЛО: ВІРНІСТЬ ДЖЕРЕЛУ ===
Спрощений текст має описувати ТІ САМІ реальні події, що й стаття-джерело
нижче — та сама тема, ті самі люди/організації/місця, той самий базовий
результат. Можна СКОРОЧУВАТИ деталі, занадто складні для рівня (цифри,
підрядні частини, контекст) — але НІКОЛИ не можна ВИГАДУВАТИ іншу, простішу
сцену замість реальної.
Числа, дати, імена людей/організацій і географічні назви, які ти
ЗАЛИШАЄШ у тексті, мають бути передані ТОЧНО як у джерелі — не округлюй,
не змінюй і не плутай їх. Якщо конкретна цифра чи дата не влізає в рівень
складності — краще повністю прибрати деталь, ніж написати її неточно.

=== ПРИРОДНІСТЬ МОВИ ===
Уникай "телеграфного" новинного стилю (сухий переказ фактів одним
реченням за іншим без зв'язків). Пиши як зв'язну, природну міні-розповідь
із логічними переходами між реченнями — так, як реально говорить/пише
носій мови цього рівня, а не як стиснутий підрядковий переклад.

=== ЗАВДАННЯ ===
Заголовок: "${cleanTitle}"
1. СПРОЩЕНИЙ ТЕКСТ ("simplified_text_ukr"):
${cfg.textInstruction}
Пиши літературною українською мовою.

2. СЛОВНИК ("vocabulary") — масив об'єктів. Студент читає цей УКРАЇНСЬКИЙ
текст, але його завдання — самостійно перекласти його НІМЕЦЬКОЮ (рівень
${level}, швейцарська німецька, "ss" замість "ß"). Тому підказки тут — це
НЕ пояснення українських слів (текст і так рідною мовою студента), а
підказки НІМЕЦЬКОГО слова, яке знадобиться студенту під час перекладу.
- Пройдись по своєму спрощеному тексту і для кожного українського слова
  чи виразу, якому відповідає НІМЕЦЬКЕ слово, що ${level}-студент, ймовірно,
  НЕ знає, НЕ пам'ятає, або яке є рідковживаним/складним — додай підказку.
- НЕ додавай підказку, якщо очікуваний німецький відповідник базовий,
  дуже частотний або totally cognate/очевидний на цьому рівні (${cfg.hintExclusions}
- Do NOT target a fixed count. ${cfg.hintGuidance} Правильна кількість —
  саме стільки, скільки слів у ЦЬОМУ тексті реально відповідають цьому
  критерію — може відрізнятись від статті до статті.
- Кожен об'єкт має ТРИ поля:
  * "surface": українське слово/вираз ТОЧНО як воно написане в твоєму
    спрощеному тексті (та сама форма, той самий відмінок/число), щоб його
    можна було знайти в тексті точним збігом.
  * "lemma": те саме українське слово в словниковій формі (називний
    відмінок однини для іменників, інфінітив для дієслів), якщо форма в
    тексті відмінюється — інакше те саме, що surface.
  * "deu": НІМЕЦЬКИЙ відповідник цього слова швейцарською німецькою
    (те слово/вираз, яке студенту знадобиться при перекладі на німецьку).
    Іменники — з артиклем і, якщо доречно, множиною: "die Wahl, -en".
    Дієслова — в інфінітиві: "klagen". НІКОЛИ не копіюй українське слово
    замість перекладу.
- Кожне слово лише один раз. Ніколи не дублюй один і той самий surface.

=== OUTPUT ===
Return ONLY valid JSON, nothing else:
{"simplified_text_ukr":"...","vocabulary":[{"surface":"...","lemma":"...","deu":"..."}]}`;

  const truncatedDescription = String(article.description || "").slice(0, 1500);
  const maxAttempts = 3;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const data = await groqRequest({
        model: MODEL,
        temperature: 0.1,
        max_tokens: 2000,
        // "low" reasoning effort occasionally returns a fully empty
        // completion for this call (json_validate_failed, empty
        // failed_generation) on certain inputs — observed on a short,
        // non-hard-news article (a cooking tip). "medium" gives the model
        // enough room to actually produce the JSON instead of truncating
        // to nothing; the retry loop below still covers the rare
        // remaining failure.
        reasoning_effort: "medium",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Заголовок: ${cleanTitle}\nСтаття: ${truncatedDescription}` },
        ],
      }, 3, TSN_API_KEY);

      const raw = data.choices?.[0]?.message?.content || "";
      if (!raw.trim()) throw new Error("Groq returned an empty completion");
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      if (!parsed.simplified_text_ukr) throw new Error("Missing simplified_text_ukr in parsed JSON");
      return {
        text: parsed.simplified_text_ukr.trim(),
        vocabulary: Array.isArray(parsed.vocabulary) ? parsed.vocabulary : [],
      };
    } catch (err) {
      lastErr = err;
      console.warn(`  ⚠️  [TSN ${level}] Attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt < maxAttempts) await sleep(2000);
    }
  }
  throw lastErr;
}

// TSN's own editorial category (article.category, from rssParser's
// extractCategory) is more reliable than a keyword guess — it's the real
// section TSN filed the piece under, already used upstream to filter the
// feed down to our 5 allowed sections. Map it straight to the app's
// existing category set (same CATEGORIES used for German/20min articles,
// so category chips/colors stay unified across both sources) instead of
// re-detecting from text.
const UK_CATEGORY_MAP = {
  "Україна":        "Politik",
  "Київ":           "Politik",
  "Львів":          "Politik",
  "Події":          "Gesellschaft",
  "Світ":           "Politik",
  "За кордоном":    "Politik",
  "Туризм":         "Gesellschaft",
  "Наука та IT":    "Wissenschaft",
  "Наука та ІТ":    "Wissenschaft",
  "Технології":     "Wissenschaft",
  "Технологія":     "Wissenschaft",
  "Цікавинки":      "Gesellschaft",
  "Різне":          "Gesellschaft",
};

// Keyword fallback — only used if article.category is missing/unmapped
// (shouldn't normally happen since rssParser already filters on it), kept
// so the pipeline never crashes on an edge case rather than for everyday
// use.
const UK_CATEGORY_RULES = [
  ["Wissenschaft", /\b(дослідник|дослідженн|наук|університет|космос|планет|ген\b|днк|експеримент|відкритт|штучн(ий|ого) інтелект|технологі|робот)/i],
  ["Politik",      /\b(уряд|парламент|рад[аи]|верховн|вибори|парті[яї]|суд\b|закон|президент|міністр|війн|росі[яїю]|путін|санкці|мігра)/i],
  ["Gesellschaft", /\b(туризм|туристи|подорож|курорт|готел|пляж|відпочин)/i],
];

function detectCategoryUkrainian(article) {
  const mapped = UK_CATEGORY_MAP[article.category];
  if (mapped) return mapped;

  const hay = `${article.title || ""} ${(article.description || "").slice(0, 400)}`;
  for (const [cat, re] of UK_CATEGORY_RULES) {
    if (re.test(hay)) return cat;
  }
  return "Gesellschaft";
}

// The internal category codes above (Politik/Gesellschaft/Wissenschaft/...)
// are the same taxonomy used for the German/20min articles, kept as the
// canonical set for consistency (colors, grouping). But TSN articles are
// Ukrainian news for a Ukrainian-reading student — the label actually shown
// in the UI (the "pill" over the article) must be Ukrainian too, not the
// internal German code name. This maps the internal code to its Ukrainian
// display label; used only at the point where `category` is written into
// the TSN article record.
const UK_CATEGORY_LABELS = {
  Wetter:        "Погода",
  Politik:       "Політика",
  Sport:         "Спорт",
  Wirtschaft:    "Економіка",
  Gesundheit:    "Здоров'я",
  Gesellschaft:  "Суспільство",
  Verkehr:       "Транспорт",
  Kultur:        "Культура",
  Wissenschaft:  "Наука",
};

async function simplifyTsnArticle(article, level) {
  const { text: simplifiedUkr, vocabulary } = await simplifyArticleUkrainian(article, level);
  const internalCategory = detectCategoryUkrainian(article);
  // "surface"/"lemma" from the model are Ukrainian (found in simplifiedUkr);
  // only the "deu" side is Swiss German and needs the toSwiss() pass —
  // buildVocabularyUkrainian() applies it to the right field.
  const { hints, words } = buildVocabularyUkrainian(vocabulary, simplifiedUkr);
  return {
    id:               generateId(`tsn:${article.title}`, level),
    originalTitle:    String(article.title || "").trim(),
    simplifiedText:   simplifiedUkr,       // Ukrainian — what the student reads
    vocabularyHints:  hints,               // "укр_слово — deutsches Wort"
    vocabularyWords:  words,               // exact in-text Ukrainian forms to bold/tap
    // Ukrainian label for display (the article is Ukrainian news for a
    // Ukrainian-reading student) — see UK_CATEGORY_LABELS above. Falls back
    // to the internal code itself in the unlikely case a new internal
    // category is ever added here without a matching label.
    category:         UK_CATEGORY_LABELS[internalCategory] || internalCategory,
    imageUrl:         article.imageUrl || null,
    publishedAt:      article.pubDate || null,
    processedAt:      new Date().toISOString(),
  };
}

module.exports = {
  simplifyArticle,
  toSwiss,
  detectCategory,
  simplifyTsnArticle,
};

