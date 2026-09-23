const fs   = require("fs");
const path = require("path");
const { parseRSSFeeds, fetchOgImage, parseTsnFeed } = require("./rssParser");
const { simplifyArticle, toSwiss, simplifyTsnArticle } = require("./groqService");

const DB_PATH       = path.join(__dirname, "..", "data", "articles.json");
const LEVELS        = ["A1", "A2", "B1"];
const MAX_PER_LEVEL = 100;
// TSN articles are stored under their own keys (tsnA1/tsnA2/tsnB1) so the
// existing app/DE sections (A1/A2/B1) stay untouched — an app build that
// doesn't know about TSN yet just ignores the extra keys.
const TSN_LEVEL_KEYS = { A1: "tsnA1", A2: "tsnA2", B1: "tsnB1" };
const MAX_PER_LEVEL_TSN = 100;

// How many NEW source articles (not levels — articles) to process per run,
// per pipeline (app/DE and TSN each get their own budget).
//
// Groq free tier for openai/gpt-oss-120b (confirmed via console.groq.com/
// docs/rate-limits, Sep 2026): 30 RPM, 1,000 RPD, 8K TPM, 200K TPD. Token
// caps (TPM/TPD) are NOT the bottleneck here — Metrics dashboard shows
// actual token usage far below both. The binding constraint is RPD: each
// article costs ~1 Groq call per level (simplify only for both app/DE and
// TSN — TSN's separate reference-translation call was removed) x 3 levels
// = ~3 calls/article in the normal case; failed attempts retry up to 3x
// per level and each retry still counts against the RPD budget, so a run
// with a lot of json_validate_failed/truncated-JSON errors burns through
// RPD much faster than this "normal case" estimate.
// The scheduled workflow runs once/day, so the full 1,000 RPD budget goes
// to a single run, split across 2 pipelines (app/DE + TSN): ~500 requests
// each ≈ 150+ articles/pipeline in theory. In practice keep well under that
// — RPM (30/min) means a run this size takes 15-20+ min regardless, and
// leaving headroom avoids a single slow day (retries, longer articles)
// tipping the whole run into RPD exhaustion. 6 is a conservative starting
// point with room to raise once you've watched a few runs against the
// Metrics dashboard. Override via env, e.g. NEWS_BATCH_SIZE=15, to speed
// up backfill once the daily budget is confirmed comfortable.
const BATCH_SIZE = parseInt(process.env.NEWS_BATCH_SIZE || "6", 10);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadDB() {
  if (!fs.existsSync(DB_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
  catch { return {}; }
}

function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}



// ── Word ↔ text matching for articles generated before `vocabularyWords`
// existed. Mirrors NewsArticle.resolveWords in the app (same rules).
function cleanLemma(s) {
  let t = s.split(",")[0].trim();
  t = t.replace(/^(der|die|das|sich|ein|eine)\s+/i, "").replace(/^(der|die|das|sich)\s+/i, "");
  const parts = t.trim().split(/\s+/);
  return parts[parts.length - 1];
}
function stemOf(w) {
  let x = w;
  if (x.startsWith("ge") && x.length > 6) x = x.slice(2);
  for (const suf of ["ungen", "ung", "en", "er", "es", "em", "st", "te", "ten", "e", "n", "t", "s"]) {
    if (x.length > suf.length + 4 && x.endsWith(suf)) { x = x.slice(0, -suf.length); break; }
  }
  return x;
}
function stemOverlap(lemma, word) {
  const a = stemOf(lemma), b = stemOf(word);
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  if (i < 5) return 0;
  return i / Math.min(a.length, b.length) >= 0.7 ? i : 0;
}
function resolveWords(text, hints) {
  const tokens = [...new Set(text.match(/[\p{L}]+(?:-[\p{L}]+)*/gu) || [])];
  const used = new Set();
  const out = [];
  for (const hint of hints) {
    const lemma = cleanLemma(hint.split(" — ")[0].trim());
    if (lemma.length < 3) continue;
    let best = tokens.find(t => t.toLowerCase() === lemma.toLowerCase()) || null;
    if (!best) {
      let bs = 0;
      for (const t of tokens) {
        const sc = stemOverlap(lemma.toLowerCase(), t.toLowerCase());
        if (sc > bs) { bs = sc; best = t; }
      }
      if (bs < 5) best = null;
    }
    if (best && !used.has(best.toLowerCase())) { used.add(best.toLowerCase()); out.push({ surface: best, hint }); }
  }
  return out;
}
function firstIndex(text, surface) {
  const esc = surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(^|[^\\p{L}])(${esc})([^\\p{L}]|$)`, "iu").exec(text);
  return m ? m.index + m[1].length : -1;
}

// One-time / idempotent cleanup of articles already in the DB:
//  - "ß" → "ss" everywhere (Swiss spelling) — older runs stored plenty of them
//  - make the category of the same story identical across A1/A2/B1. Older runs
//    asked the model per level, so the same headline could carry different tags.
//    We keep the tag from the B1 version (longest/most reliable text) and copy
//    it to A1 and A2 of the same headline.
function migrateDB(db) {
  let fixed = 0;
  for (const level of LEVELS) {
    for (const a of db[level] || []) {
      const before = JSON.stringify([a.originalTitle, a.simplifiedText, a.vocabularyHints, a.vocabularyWords || null]);
      a.originalTitle   = toSwiss(a.originalTitle);
      a.simplifiedText  = toSwiss(a.simplifiedText);
      a.vocabularyHints = (a.vocabularyHints || []).map(toSwiss);
      if (Array.isArray(a.vocabularyWords)) {
        a.vocabularyWords = a.vocabularyWords.map(w => ({ surface: toSwiss(w.surface), hint: toSwiss(w.hint) }));
      }
      // Older articles have no exact in-text forms yet — derive them, then put
      // both the words and the vocabulary list in the order they occur in the text.
      if (!a.vocabularyWords || a.vocabularyWords.length === 0) {
        a.vocabularyWords = resolveWords(a.simplifiedText, a.vocabularyHints);
      }
      const pos = new Map();
      for (const w of a.vocabularyWords) {
        const i = firstIndex(a.simplifiedText, w.surface);
        if (i >= 0) pos.set(w.hint, i);
      }
      const order = h => (pos.has(h) ? pos.get(h) : Number.MAX_SAFE_INTEGER);
      a.vocabularyHints = [...a.vocabularyHints].sort((x, y) => order(x) - order(y));
      a.vocabularyWords = [...a.vocabularyWords].sort((x, y) => order(x.hint) - order(y.hint));
      if (JSON.stringify([a.originalTitle, a.simplifiedText, a.vocabularyHints, a.vocabularyWords || null]) !== before) fixed++;
    }
  }

  const canonical = new Map(); // title -> category from B1 (else A2, else A1)
  for (const level of ["A1", "A2", "B1"]) {
    for (const a of db[level] || []) canonical.set(a.originalTitle, a.category);
  }
  let recat = 0;
  for (const level of LEVELS) {
    for (const a of db[level] || []) {
      const c = canonical.get(a.originalTitle);
      if (c && a.category !== c) { a.category = c; recat++; }
    }
  }
  if (fixed || recat) console.log(`🧹 Migration: ß→ss in ${fixed} articles, unified category in ${recat} articles`);
}

// Processes the TSN.ua (Ukrainian) pipeline: fetch -> filter to new -> for
// each new article, simplify UK text per level + generate the DE reference
// translation -> save. Mirrors the app/DE loop in main() below, but kept
// separate since the two pipelines don't share dedupe state (different
// language, different source) or a level-config shape (no vocabulary here).
async function processTsn(db) {
  console.log("📡 Fetching TSN.ua RSS...");
  let rawArticles;
  try {
    rawArticles = await parseTsnFeed();
  } catch (err) {
    console.error("❌ TSN RSS fetch failed:", err.message);
    return { processed: 0, failed: 0 };
  }
  console.log(`✅ Fetched ${rawArticles.length} articles from TSN.ua`);

  const existingTitles = new Set();
  for (const key of Object.values(TSN_LEVEL_KEYS)) {
    (db[key] || []).forEach(a => existingTitles.add(a.originalTitle));
  }

  const newArticles = rawArticles.filter(a => !existingTitles.has(a.title)).slice(0, BATCH_SIZE);
  console.log(`🆕 ${newArticles.length} new TSN articles to process`);
  if (newArticles.length === 0) return { processed: 0, failed: 0 };

  let processed = 0;
  let failed = 0;
  // If Groq's quota is exhausted, every single article will fail the
  // same way for the rest of this run (confirmed by logs: once it starts,
  // it doesn't recover mid-run) — burning through the whole article list
  // anyway just wastes CI minutes and produces a wall of identical log
  // lines. Bail out of the loop early once this happens repeatedly, so
  // the run ends quickly instead of grinding through every remaining
  // article for no benefit.
  let quotaFailStreak = 0;
  const QUOTA_FAIL_BAIL_THRESHOLD = 3;

  for (const article of newArticles) {
    if (quotaFailStreak >= QUOTA_FAIL_BAIL_THRESHOLD) {
      console.warn(`⏭️  [TSN] Skipping remaining articles — Groq quota appears exhausted for this run.`);
      break;
    }
    for (const level of LEVELS) {
      const dbKey = TSN_LEVEL_KEYS[level];
      try {
        console.log(`⚙️  [TSN ${level}] "${article.title.slice(0, 50)}..."`);
        const result = await simplifyTsnArticle(article, level);

        if (!db[dbKey]) db[dbKey] = [];
        db[dbKey].unshift(result);
        if (db[dbKey].length > MAX_PER_LEVEL_TSN) {
          db[dbKey] = db[dbKey].slice(0, MAX_PER_LEVEL_TSN);
        }

        saveDB(db);
        processed++;
        quotaFailStreak = 0;
      } catch (err) {
        console.error(`❌ [TSN ${level}] "${article.title.slice(0, 30)}": ${err.message}`);
        failed++;
        // Only bail early on a genuine DAILY (RPD) exhaustion — that
        // won't recover this run no matter what. A TPM burst is
        // transient (resets within a minute), so don't count it toward
        // the bail streak; just move on and let the next request's own
        // pacing/retry handle it.
        if (/DAILY \(RPD\) quota exhausted/.test(err.message)) {
          quotaFailStreak++;
          if (quotaFailStreak >= QUOTA_FAIL_BAIL_THRESHOLD) break;
        }
      }
      // Same TPM reasoning as the app/DE loop above — see its comment.
      // TSN's simplify call is the same size class (long prompt with its
      // own vocabulary section + article text in, up to 3000-token
      // completion out), so it needs the same real pause, not the RPM-only
      // 4s this used to be.
      await sleep(20000);
    }
  }

  return { processed, failed };
}

async function main() {
  if (!process.env.GROQ_API_KEY) {
    console.error("❌ GROQ_API_KEY is not set!");
    process.exit(1);
  }

  console.log("📡 Fetching RSS feeds...");
  let rawArticles;
  try {
    rawArticles = await parseRSSFeeds();
  } catch (err) {
    console.error("❌ RSS fetch failed:", err.message);
    process.exit(1);
  }
  console.log(`✅ Fetched ${rawArticles.length} articles from RSS`);

  const db = loadDB();
  migrateDB(db);

  // Збираємо заголовки що вже є в базі
  const existingTitles = new Set();
  LEVELS.forEach(l => {
    (db[l] || []).forEach(a => existingTitles.add(a.originalTitle));
  });

  // Тільки нові статті
  const newArticles = rawArticles.filter(a => !existingTitles.has(toSwiss(a.title))).slice(0, BATCH_SIZE);
  console.log(`🆕 ${newArticles.length} new articles to process`);

  // Фолбек на картинки: RSS дав imageUrl не для всіх статей, а для деяких
  // джерел (SRF) дає лише маленьке прев'ю (URL виду .../320ws/....webp —
  // фіксована ширина 320px, помітно менш чітка за повнорозмірні фото інших
  // джерел типу 20min). Для статей без картинки взагалі, а тепер і для
  // статей з таким маленьким прев'ю, заходимо на сторінку статті й беремо
  // og:image/twitter:image — це, як правило, повнорозмірне фото.
  // Best-effort — якщо сторінка не відповіла чи там немає og:image, просто
  // лишаємо те, що вже було (маленьке прев'ю або null), на обробку це не
  // впливає.
  const isLowResUrl = (url) => !!url && /\/\d{2,3}ws\//i.test(url);

  let imagesFetched = 0;
  for (const article of newArticles) {
    if ((!article.imageUrl || isLowResUrl(article.imageUrl)) && article.link) {
      const og = await fetchOgImage(article.link);
      if (og) {
        article.imageUrl = og;
        imagesFetched++;
      }
    }
  }
  console.log(`🖼️  Догенеровано og:image для ${imagesFetched} статей`);

  let processed = 0;
  let failed    = 0;
  let tsnResult = { processed: 0, failed: 0 };
  // Same early-bail logic as processTsn() above — see its comment.
  let quotaFailStreak = 0;
  const QUOTA_FAIL_BAIL_THRESHOLD = 3;

  if (newArticles.length === 0) {
    console.log("✅ Nothing new from app/DE sources.");
  } else {

  for (const article of newArticles) {
    if (quotaFailStreak >= QUOTA_FAIL_BAIL_THRESHOLD) {
      console.warn(`⏭️  [DE] Skipping remaining articles — Groq quota appears exhausted for this run.`);
      break;
    }
    for (const level of LEVELS) {
      try {
        console.log(`⚙️  [${level}] "${article.title.slice(0, 50)}..."`);
        const result = await simplifyArticle(article, level);

        if (!db[level]) db[level] = [];
        db[level].unshift(result);

        // Обрізаємо до MAX
        if (db[level].length > MAX_PER_LEVEL) {
          db[level] = db[level].slice(0, MAX_PER_LEVEL);
        }

        // Зберігаємо після кожної статті — щоб не втратити при помилці
        saveDB(db);
        processed++;
        quotaFailStreak = 0;
      } catch (err) {
        console.error(`❌ [${level}] "${article.title.slice(0, 30)}": ${err.message}`);
        failed++;
        // Same distinction as the TSN loop above: only a genuine DAILY
        // (RPD) exhaustion is worth bailing the whole run for.
        if (/DAILY \(RPD\) quota exhausted/.test(err.message)) {
          quotaFailStreak++;
          if (quotaFailStreak >= QUOTA_FAIL_BAIL_THRESHOLD) break;
        }
      }

      // Pause between levels. 4s only accounts for RPM (30/min — 2s/request
      // is already comfortable), which is NOT the real bottleneck here:
      // Groq's free tier for this model also caps at 8,000 TPM (tokens/min),
      // and a single simplify call (long system prompt with the vocabulary
      // section + article text in, up to 3000-token completion out) can
      // easily run 2,500-3,500 tokens on its own — so 2-3 such calls back
      // to back already exhausts the whole minute's token budget regardless
      // of how many *requests* that is. When TPM is hit, Groq's Retry-After
      // is measured in minutes, not seconds (confirmed in production logs:
      // waits of 600-1600+s), which is what was repeatedly tipping runs
      // into "quota exhausted" well before the 1,000 RPD ceiling was ever
      // reached. 20s leaves realistic headroom under 8K TPM for a
      // few-thousand-token call; the built-in retry in groqRequest() still
      // covers any remaining short 429s from RPM bursts.
      await sleep(20000);
    }
  }

  } // end app/DE processing (newArticles.length === 0 short-circuit above)

  // TSN.ua (Ukrainian -> German) pipeline — independent of the app/DE
  // dedupe/counters above, runs regardless of whether app/DE had anything new.
  tsnResult = await processTsn(db);

  db.updatedAt = new Date().toISOString();
  saveDB(db);

  console.log(`\n✅ Done! App/DE — Processed: ${processed}, Failed: ${failed}`);
  console.log(`✅ TSN — Processed: ${tsnResult.processed}, Failed: ${tsnResult.failed}`);
  console.log(`📊 DB: A1=${db.A1?.length||0}, A2=${db.A2?.length||0}, B1=${db.B1?.length||0}, ` +
              `tsnA1=${db.tsnA1?.length||0}, tsnA2=${db.tsnA2?.length||0}, tsnB1=${db.tsnB1?.length||0}`);

  // Якщо ЖОДНА стаття не оброблена успішно (наприклад модель Groq
  // decommissioned, квота вичерпана, чи ключ невалідний) — валимо job
  // з ненульовим кодом. Раніше скрипт мовчки "succeeded" навіть коли
  // всі виклики Groq падали, і поломка непомітно тривала два тижні,
  // поки articles.json просто переставав поповнюватись.
  // Рахуємо провалом лише випадок, коли БУЛИ спроби (з будь-якого джерела)
  // і ЖОДНА не вдалась — якщо просто не було нових статей, це не помилка.
  const totalAttempts = newArticles.length * LEVELS.length + (tsnResult.processed + tsnResult.failed);
  if (processed === 0 && tsnResult.processed === 0 && totalAttempts > 0) {
    console.error("💥 All articles failed to process — failing the job so it's visible in Actions.");
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
