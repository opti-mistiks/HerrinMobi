// One-off / on-demand backfill: adds Russian translation fields
// (simplifiedTextRu for TSN articles, vocabularyHintsRu for both DE and
// TSN articles) to entries ALREADY in data/articles.json that don't have
// them yet — without re-running RSS fetch + DE/TSN generation.
//
// Why this exists: updateNews.js's own RU pass (processRuTranslation)
// only covers articles freshly generated in that same run, and only runs
// AFTER the full DE+TSN generation (~20-30 min). This script is for
// catching up articles that already exist in the DB but predate the RU
// feature, without waiting through another full generation run first.
//
// Usage: node scripts/backfillRuTranslation.js [maxArticles]
// maxArticles (optional, default 20) caps how many articles (across all
// six sections combined) get translated in one run, so a single
// invocation can't accidentally blow through the whole daily Groq quota
// on a big backlog — run it again to continue with the next batch.
const fs   = require("fs");
const path = require("path");
const { translateHintsToRussian, translateTsnToRussian } = require("./groqService");

const DB_PATH = path.join(__dirname, "..", "data", "articles.json");
const DE_SECTIONS  = ["A1", "A2", "B1"];
const TSN_SECTIONS = ["tsnA1", "tsnA2", "tsnB1"];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadDB() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`No DB found at ${DB_PATH}`);
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

// Same collection/fallback-chain logic as updateNews.js's
// RU_FALLBACK_CHAIN — kept identical here so the backfill behaves the
// same way as the main run's own RU pass (see that file's comment for
// why oldest-used-first ordering matters: those keys are more likely to
// be "cooled down" already). Duplicated rather than imported because
// updateNews.js doesn't export its key-collection helpers.
function collectRotationKeys(prefix, fallback) {
  const keys = [];
  for (let i = 1; ; i++) {
    const v = process.env[`${prefix}_${i}`];
    if (!v) break;
    keys.push(v);
  }
  return keys.length > 0 ? keys : (fallback ? [fallback] : []);
}

const DE_ROTATION_KEYS  = collectRotationKeys("GROQ_API_KEY_DE", process.env.GROQ_API_KEY);
const TSN_ROTATION_KEYS = collectRotationKeys("GROQ_API_KEY_TSN", process.env.GROQ_API_KEY_TSN || process.env.GROQ_API_KEY);
const RU_KEY = process.env.GROQ_API_KEY_RU;
const RU_FALLBACK_CHAIN = [RU_KEY, ...DE_ROTATION_KEYS, ...TSN_ROTATION_KEYS].filter(Boolean);

async function runWithRuFallback(chain, startIdx, fn) {
  let idx = startIdx;
  let lastErr;
  while (idx < chain.length) {
    try {
      const result = await fn(chain[idx]);
      return { result, nextIdx: idx };
    } catch (err) {
      lastErr = err;
      console.warn(`  ⚠️  Key #${idx + 1}/${chain.length} failed (${err.message}) — advancing to next key in fallback chain.`);
      idx++;
    }
  }
  throw lastErr || new Error("RU fallback chain exhausted with no keys configured");
}

async function main() {
  const maxArticles = parseInt(process.argv[2] || process.env.RU_BACKFILL_MAX || "20", 10);

  if (RU_FALLBACK_CHAIN.length === 0) {
    console.error("❌ No GROQ_API_KEY_RU (or DE/TSN fallback keys) set — nothing to run with.");
    process.exit(1);
  }

  const db = loadDB();

  // Collect candidates: DE articles missing vocabularyHintsRu, TSN
  // articles missing simplifiedTextRu. Oldest-first isn't tracked here
  // (articles.json doesn't preserve original run order across sections
  // reliably) — just take them in on-disk array order and cap at
  // maxArticles total across both kinds combined.
  const deCandidates = [];
  for (const level of DE_SECTIONS) {
    for (const article of db[level] || []) {
      if (!article.vocabularyHintsRu) deCandidates.push({ level, article });
    }
  }
  const tsnCandidates = [];
  for (const level of TSN_SECTIONS) {
    for (const article of db[level] || []) {
      // also re-do TSN articles that already have Russian text but no
      // vocabularyWordsRu — those are the ones with missing underlines.
      if (!article.simplifiedTextRu || (article.vocabularyWords?.length && !article.vocabularyWordsRu)) {
        tsnCandidates.push({ level, article });
      }
    }
  }

  const totalAvailable = deCandidates.length + tsnCandidates.length;
  console.log(`📊 Found ${deCandidates.length} DE + ${tsnCandidates.length} TSN articles without RU fields (${totalAvailable} total).`);
  if (totalAvailable === 0) {
    console.log("✅ Nothing to backfill.");
    return;
  }

  // Interleave so a capped run gets a mix of both kinds rather than
  // draining DE_SECTIONS first and never reaching TSN if maxArticles is
  // smaller than deCandidates.length.
  const combined = [];
  const maxLen = Math.max(deCandidates.length, tsnCandidates.length);
  for (let i = 0; i < maxLen; i++) {
    if (deCandidates[i]) combined.push({ kind: "de", ...deCandidates[i] });
    if (tsnCandidates[i]) combined.push({ kind: "tsn", ...tsnCandidates[i] });
  }
  const batch = combined.slice(0, maxArticles);
  console.log(`🚀 Processing ${batch.length} of them this run (cap=${maxArticles}).`);

  let processed = 0, failed = 0;
  let keyIdx = 0;

  for (const { kind, level, article } of batch) {
    try {
      if (kind === "de") {
        const { result: hintsRu, nextIdx } = await runWithRuFallback(
          RU_FALLBACK_CHAIN, keyIdx,
          (key) => translateHintsToRussian(article.vocabularyHints, key)
        );
        keyIdx = nextIdx;
        article.vocabularyHintsRu = hintsRu;
        console.log(`  ✅ [DE ${level}] "${article.originalTitle.slice(0, 50)}..."`);
      } else {
        const { result, nextIdx } = await runWithRuFallback(
          RU_FALLBACK_CHAIN, keyIdx,
          (key) => translateTsnToRussian(article.simplifiedText, article.vocabularyHints, key, article.originalTitle, article.vocabularyWords)
        );
        keyIdx = nextIdx;
        article.originalTitleRu   = result.titleRu || article.originalTitleRu;
        article.simplifiedTextRu  = result.textRu;
        article.vocabularyHintsRu = result.hintsRu;
        article.vocabularyWordsRu = result.wordsRu;
        console.log(`  ✅ [TSN ${level}] "${article.originalTitle.slice(0, 50)}..."`);
      }
      processed++;
    } catch (err) {
      console.error(`  ❌ [${kind.toUpperCase()} ${level}] "${article.originalTitle.slice(0, 30)}": ${err.message}`);
      failed++;
    }
    saveDB(db); // save after every article, same as the main pipeline — no lost work on a mid-run failure
    await sleep(20000);
  }

  console.log(`\n✅ Done! RU backfill — Processed: ${processed}, Failed: ${failed}, Remaining: ${totalAvailable - batch.length}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
