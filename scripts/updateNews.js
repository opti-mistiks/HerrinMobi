const fs   = require("fs");
const path = require("path");
const { parseRSSFeeds, fetchOgImage } = require("./rssParser");
const { simplifyArticle, toSwiss } = require("./groqService");

const DB_PATH       = path.join(__dirname, "..", "data", "articles.json");
const LEVELS        = ["A1", "A2", "B1"];
const MAX_PER_LEVEL = 30;

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
      const before = JSON.stringify([a.originalTitle, a.simplifiedText, a.vocabularyHints]);
      a.originalTitle   = toSwiss(a.originalTitle);
      a.simplifiedText  = toSwiss(a.simplifiedText);
      a.vocabularyHints = (a.vocabularyHints || []).map(toSwiss);
      if (Array.isArray(a.vocabularyWords)) {
        a.vocabularyWords = a.vocabularyWords.map(w => ({ surface: toSwiss(w.surface), hint: toSwiss(w.hint) }));
      }
      if (JSON.stringify([a.originalTitle, a.simplifiedText, a.vocabularyHints]) !== before) fixed++;
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
  const newArticles = rawArticles.filter(a => !existingTitles.has(toSwiss(a.title))).slice(0, 30);
  console.log(`🆕 ${newArticles.length} new articles to process`);

  // Фолбек на картинки: RSS дав imageUrl не для всіх статей (особливо SRF).
  // Для решти заходимо на сторінку статті й беремо og:image/twitter:image.
  // Best-effort — якщо сторінка не відповіла чи там немає og:image, просто
  // лишаємо imageUrl = null, на обробку це не впливає.
  let imagesFetched = 0;
  for (const article of newArticles) {
    if (!article.imageUrl && article.link) {
      const og = await fetchOgImage(article.link);
      if (og) {
        article.imageUrl = og;
        imagesFetched++;
      }
    }
  }
  console.log(`🖼️  Догенеровано og:image для ${imagesFetched} статей`);

  if (newArticles.length === 0) {
    console.log("✅ Nothing new. Done.");
    // Оновлюємо updatedAt навіть якщо нічого нового
    db.updatedAt = new Date().toISOString();
    saveDB(db);
    return;
  }

  let processed = 0;
  let failed    = 0;

  for (const article of newArticles) {
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
      } catch (err) {
        console.error(`❌ [${level}] "${article.title.slice(0, 30)}": ${err.message}`);
        failed++;
      }

      // Пауза між запитами щоб не бити rate limit
      await sleep(2000);
    }
  }

  db.updatedAt = new Date().toISOString();
  saveDB(db);

  console.log(`\n✅ Done! Processed: ${processed}, Failed: ${failed}`);
  console.log(`📊 DB: A1=${db.A1?.length||0}, A2=${db.A2?.length||0}, B1=${db.B1?.length||0}`);

  // Якщо ЖОДНА стаття не оброблена успішно (наприклад модель Groq
  // decommissioned, квота вичерпана, чи ключ невалідний) — валимо job
  // з ненульовим кодом. Раніше скрипт мовчки "succeeded" навіть коли
  // всі виклики Groq падали, і поломка непомітно тривала два тижні,
  // поки articles.json просто переставав поповнюватись.
  const totalAttempts = newArticles.length * LEVELS.length;
  if (processed === 0 && totalAttempts > 0) {
    console.error("💥 All articles failed to process — failing the job so it's visible in Actions.");
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
