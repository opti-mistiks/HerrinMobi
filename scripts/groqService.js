const https = require("https");

const MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

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
          const wait = parseFloat(res.headers["retry-after"] || "5") * 1000;
          console.warn(`[groq] Rate limit, retrying in ${wait}ms...`);
          await sleep(wait);
          groqRequest(body, retries - 1).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Groq HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
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
    textInstruction: "Write 4-5 short sentences (max 10 words each). Use ONLY Präsens. Use Subject-Verb-Object structure. Avoid compound nouns when a simpler word exists.",
    hintExclusions: 'NEVER include: sein, haben, werden, machen, gehen, kommen, sehen, sagen, wollen, können, müssen; all pronouns; all articles; all numbers; country/city names; obvious cognates with Ukrainian or English.',
  },
  A2: {
    textInstruction: "Write 5-7 sentences. You may use Perfekt and simple modal verbs. You may use und, aber, oder, denn. Vocabulary: daily life, work, shopping, weather.",
    hintExclusions: 'NEVER include: basic everyday A1-A2 words; country/city names; obvious cognates.',
  },
  B1: {
    textInstruction: "Write 7-9 sentences. You may use Nebensätze (weil, dass, wenn, obwohl) and Konjunktiv II. Preserve key facts, numbers, and names from the original.",
    hintExclusions: "NEVER include: words any B1 student already knows; obvious cognates.",
  },
};

async function simplifyArticle(article, level) {
  const cfg = LEVEL_CONFIG[level];

  const systemPrompt = `You are a Swiss High German teacher creating reading exercises.
SWISS GERMAN RULE: NEVER use "ß" — always write "ss".
Output: single minified JSON object. No markdown, no backticks.

=== TASK ===
1. SIMPLIFIED TEXT ("simplified_text_deu"):
${cfg.textInstruction}
Write in Swiss High German (no "ß").

2. VOCABULARY HINTS ("vocabulary_hints_ukr") — array of 5-7 strings:
- Pick words that APPEAR IN YOUR SIMPLIFIED TEXT
- Pick words a ${level} learner genuinely does NOT know
- ${cfg.hintExclusions}
- Format: "das Wort — українське значення"
  * Nouns: include article + plural if useful: "die Wahl, -en — вибори"
  * Verbs: infinitive: "sich ausbreiten — поширюватись"
  * ALWAYS give real Ukrainian meaning, NEVER "die X — X"

3. CATEGORY ("category"):
One word: Wetter / Politik / Sport / Wirtschaft / Gesundheit / Gesellschaft / Verkehr / Kultur / Wissenschaft

=== OUTPUT ===
{"simplified_text_deu":"...","vocabulary_hints_ukr":["..."],"category":"..."}`;

  const data = await groqRequest({
    model: MODEL,
    temperature: 0.1,
    max_tokens: 1000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: `Title: ${article.title}\nArticle: ${article.description}` },
    ],
  });

  const raw = data.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());

  const validHints = (parsed.vocabulary_hints_ukr || []).filter(h => h.includes(" — "));

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
