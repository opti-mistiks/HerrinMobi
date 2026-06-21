const fs   = require("fs");
const path = require("path");
const { parseRSSFeeds }   = require("./rssParser");
const { simplifyArticle } = require("./groqService");

const DB_PATH     = path.join(__dirname, "..", "data", "articles.json");
const LEVELS      = ["A1", "A2", "B1"];
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

  // Збираємо заголовки що вже є в базі
  const existingTitles = new Set();
  LEVELS.forEach(l => {
    (db[l] || []).forEach(a => existingTitles.add(a.originalTitle));
  });

  // Тільки нові статті
  const newArticles = rawArticles.filter(a => !existingTitles.has(a.title)).slice(0, 30);
  console.log(`🆕 ${newArticles.length} new articles to process`);

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
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});