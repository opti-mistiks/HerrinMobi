const https = require("https");
const http = require("http");
const { XMLParser } = require("fast-xml-parser");

const RSS_SOURCES = [
  { name: "20min Schweiz",       url: "https://partner-feeds.20min.ch/rss/20minuten/schweiz" },
  { name: "20min Sport",         url: "https://partner-feeds.20min.ch/rss/20minuten/sport" },
  { name: "20min Entertainment", url: "https://partner-feeds.20min.ch/rss/20minuten/entertainment" },
  { name: "20min Lifestyle",     url: "https://partner-feeds.20min.ch/rss/20minuten/lifestyle" },
  { name: "20min Wissen",        url: "https://partner-feeds.20min.ch/rss/20minuten/wissen" },
  { name: "SRF News",            url: "https://www.srf.ch/news/bnf/rss/1646" },
];

// TSN.ua — окрема (українська) стрічка новин, розібрана окремою функцією
// нижче (parseTsnFeed), бо формат RSS-елементів відрізняється (повний
// текст статті лежить у власному тегу <fulltxt>, а не в
// description/content:encoded, як у швейцарських джерел).
const TSN_RSS_URL = "https://tsn.ua/rss/full.rss";

// TSN's full feed has no per-section RSS (confirmed against llms.txt), so
// we take the single general feed and filter by the <category> tag every
// <item> already carries. Only these 5 sections (as requested) pass
// through; everything else (glamour, horoscopes, name-day greetings,
// recipes, sports, etc.) is dropped here, before any Groq call is spent
// on it. Keys are the TSN category strings seen in the feed; several map
// to the same app-facing section.
const TSN_ALLOWED_CATEGORIES = new Set([
  // Україна
  "Україна", "Київ", "Львів", "Події",
  // Світ
  "Світ", "За кордоном",
  // Туризм
  "Туризм",
  // Наука і ІТ
  "Наука та IT", "Наука та ІТ", "Технології", "Технологія",
  // Цікавинки
  "Цікавинки", "Різне",
]);

// ── ITC.ua ("Статті") ────────────────────────────────────────────
// Довгі пояснювальні матеріали (історія технологій, українські винахідники,
// як щось працює) — це саме те, що потрібно для граматичної практики.
// Сторінка розділу для читачів: https://itc.ua/ua/statti/ ; самі статті
// живуть за адресами /ua/articles/<slug>/ (новини — /ua/novini/).
//
// Підтверджена адреса RSS (з футера сайту) — загальна стрічка
// https://itc.ua/ua/feed/, де статті змішані з десятками новин на день.
// Тому пробуємо ще й "розділові" адреси (WordPress віддає /feed/ для
// будь-якого архіву — але це припущення, не підтверджено). Беремо всі, що
// відповіли справжнім RSS, зливаємо без дублікатів і лишаємо тільки
// посилання /ua/articles/. Змінна ITC_RSS_URL (одна адреса) переозначає список.
const ITC_FEED_URLS = process.env.ITC_RSS_URL
  ? [process.env.ITC_RSS_URL]
  : [
      "https://itc.ua/ua/statti/feed/",
      "https://itc.ua/ua/articles/feed/",
      "https://itc.ua/ua/feed/",
    ];
const ITC_ARTICLE_PATH = "/ua/articles/";

// Формати, які ITC публікує в розділі "Статті", але вони погано підходять
// для граматики: щомісячні добірки ігор/фільмів/серіалів (суцільні власні
// назви), огляди пристроїв, рейтинги "ТОП N". Легко прибрати/змінити тут.
const ITC_SKIP_TITLE = [
  // Кирилиця + \b не працює в JS (\b бачить лише латиницю), тому замість
  // межі слова — початок рядка й явний пробіл/двокрапка після слова.
  /^огляд(\s|:|$)/i,
  /найцікавіші нові/i,
  /ps plus і game pass/i,
  /пк місяця/i,
  /^топ[\s-]*\d+/i,
  /^перш(ий|і)\s+(погляд|враження)/i,
];

// ── Антивоєнний фільтр (TSN та ITC) ─────────────────────────────
// Відкидає новини про війну, удари, загиблих — ще ДО виклику Groq,
// тож токени на них не витрачаються. Перевіряється заголовок + перші
// ~600 символів тексту, щоб не спрацьовувати на випадкову згадку
// в кінці довгої статті. Основи слів (без закінчень), регістр не важливий.
const WAR_STEMS = [
  // прямі бойові дії
  "війна в україні", "війна з росі", "російсько-українськ", "повномасштабн", "під час війни", "через війну", "війна триває", "воєнн", "військов", "фронт", "окупац", "окупант", "окупов",
  "обстр", "прильот", "приліт", "ракетн удар", "ракетн атак", "ракетн обстр", "ракетний удар", "ракетна атака", "ракетного удару", "ракетної атаки", "ракетами по", "ракети по", "запуск ракет по",
  "дрон", "шахед", "безпілот", "бпла", "кабами", "авіаудар", "авіаналіт",
  "вибух", "вибуч", "удар по", "удари по", "ударів", "атакув", "атака рф",
  "штурм", "наступ ", "контрнаступ", "оборон", "деокупац", "мобілізац",
  "тцк", "зсу", "збройних сил", "ппо", "протиповітр", "повітряна тривога",
  "тривог", "укритт", "евакуац", "блекаут", " реб ", "реб \"", "засоби реб", "радіоелектронн", "сирен", "сирена",
  // сторони й політика війни
  "рф ", " рф", "росі", "російськ", "кремл", "путін", "лавров", "рашист",
  "ворог", "загарбник", "переговори про мир", "перемир", "капітуляц",
  "санкці", "зброя", "зброї", "озброєн", "гаубиц", "хімарс", "himars",
  "patriot", "f-16", "ataсms", "танк", "бронетехнік",
  // наслідки
  "загинул", "загибл", "загинув", "убит", "вбит", "вбивств", "є жертви", "жертв атак", "жертв удар",
  "поранен", "постраждал", "тіла загиблих", "поховання", "полонен", "полон ",
  "зруйнов", "руйнуван", "знищен", "терорист", "теракт", "розстріляв", "розстрілян",
  "масовий обстріл", "трагеді", "катастроф", "аварі", "нещасний випад",
  "зґвалт", "розбещ", "педофіл", "насильств", "самогубств",
  // країни-фронти/тематика
  "курщин", "бєлгород", "крим", "донбас", "маріуполь", "бахмут", "авдіївк",
  "покровськ", "куп'янськ", "вугледар", "херсонщин", "запоріж",
  "ізраїл", "хамас", "газа ", "сектор газа", "іран", "близькому сході",
];

function isWarRelated(title, text) {
  const hay = `${title || ""} ${String(text || "").slice(0, 600)}`.toLowerCase();
  return WAR_STEMS.some(w => hay.includes(w));
}

function extractCategory(item) {
  const cat = item.category;
  if (!cat) return null;
  const node = Array.isArray(cat) ? cat[0] : cat;
  if (typeof node === "string") return node.trim();
  if (node && typeof node === "object") return String(node["#text"] || "").trim();
  return null;
}

function fetchURL(urlStr) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith("https") ? https : http;
    const req = lib.get(urlStr, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WortsFeed/1.0)" },
      timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function stripHTML(str) {
  if (!str) return "";
  return String(str)
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}

function extractImageUrl(item) {
  // 1. media:content
  const media = item["media:content"];
  if (media) {
    const node = Array.isArray(media) ? media[0] : media;
    const url = node?.["@_url"];
    if (url) return url;
  }

  // 2. media:thumbnail (SRF та деякі інші джерела використовують саме цей тег)
  const thumb = item["media:thumbnail"];
  if (thumb) {
    const node = Array.isArray(thumb) ? thumb[0] : thumb;
    const url = node?.["@_url"];
    if (url) return url;
  }

  // 3. enclosure — але тільки якщо це справді картинка (type="image/..."),
  // деякі фіди кладуть туди аудіо/відео-вкладення
  const enc = item["enclosure"];
  if (enc) {
    const node = Array.isArray(enc) ? enc[0] : enc;
    const url  = node?.["@_url"];
    const type = node?.["@_type"] || "";
    if (url && (!type || type.startsWith("image"))) return url;
  }

  // 4. перше <img src="..."> прямо в HTML-вмісті статті — рятує фіди без
  // окремих медіа-тегів (картинка йде "вшита" в опис/content:encoded)
  const html = item["content:encoded"] || item.description || "";
  const imgMatch = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return null;
}

function extractLink(item) {
  const link = item.link;
  if (typeof link === "string") return link;
  if (link && typeof link === "object") return link["#text"] || link["@_href"] || null;
  return null;
}

function extractOgImage(html) {
  const match =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
    html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

// Резервний варіант: якщо RSS взагалі не дав картинку — заходимо на сторінку
// статті й беремо og:image / twitter:image з її <head>. Best-effort: будь-яка
// помилка (таймаут, 404, бот-захист) просто повертає null, не валить весь run.
async function fetchOgImage(pageUrl) {
  if (!pageUrl) return null;
  try {
    const html = await fetchURL(pageUrl);
    return extractOgImage(html);
  } catch {
    return null;
  }
}

function parsePubDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function parseFeed(source) {
  let xml;
  try {
    xml = await fetchURL(source.url);
  } catch (err) {
    console.warn(`[rss] Failed ${source.name}: ${err.message}`);
    return [];
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true,
  });

  let result;
  try { result = parser.parse(xml); }
  catch { return []; }

  const items = result?.rss?.channel?.item || [];
  const arr = Array.isArray(items) ? items : [items];

  return arr.map((item, index) => ({
    title:       stripHTML(item.title || ""),
    description: stripHTML(item.description || item["content:encoded"] || ""),
    imageUrl:    extractImageUrl(item),
    link:        extractLink(item),
    pubDate:     parsePubDate(item.pubDate),
    feedOrder:   index,
    source:      source.name,
  })).filter(a => a.title && a.description);
}

async function parseRSSFeeds() {
  const results = await Promise.allSettled(RSS_SOURCES.map(parseFeed));
  const all = [];
  const seen = new Set();

  results.forEach(r => {
    if (r.status === "fulfilled") {
      r.value.forEach(a => {
        if (!seen.has(a.title)) { seen.add(a.title); all.push(a); }
      });
    }
  });

  all.sort((a, b) => {
    if (a.pubDate && b.pubDate) return new Date(b.pubDate) - new Date(a.pubDate);
    return a.feedOrder - b.feedOrder;
  });

  return all;
}

// TSN.ua's RSS uses <fulltxt> (CDATA, full HTML article body) instead of
// content:encoded, and no media:content/thumbnail — only <enclosure>. Kept
// as its own parser (not folded into parseFeed/RSS_SOURCES) so the Swiss
// feeds' dedupe-by-title-across-all-sources logic in parseRSSFeeds isn't
// affected by a completely different-language source.
async function parseTsnFeed() {
  let xml;
  try {
    xml = await fetchURL(TSN_RSS_URL);
  } catch (err) {
    console.warn(`[rss] Failed TSN.ua: ${err.message}`);
    return [];
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true,
  });

  let result;
  try { result = parser.parse(xml); }
  catch { return []; }

  const items = result?.rss?.channel?.item || [];
  const arr = Array.isArray(items) ? items : [items];

  return arr
    .map((item, index) => ({
      title:       stripHTML(item.title || ""),
      // fulltxt has the real article body; description is just a teaser.
      // Prefer fulltxt (falls back to description for any item missing it).
      description: stripHTML(item.fulltxt || item.description || ""),
      imageUrl:    extractImageUrl(item),
      link:        extractLink(item),
      pubDate:     parsePubDate(item.pubDate),
      feedOrder:   index,
      source:      "TSN.ua",
      category:    extractCategory(item),
    }))
    .filter(a => a.title && a.description)
    .filter(a => a.category && TSN_ALLOWED_CATEGORIES.has(a.category))
    // без війни, ударів, загиблих, катастроф тощо — не витрачаємо токени
    .filter(a => !isWarRelated(a.title, a.description));
}

// ITC.ua "Статті" — WordPress RSS. Повний текст лежить у <content:encoded>
// (fallback: description). Категорію віддаємо як "Наука та ІТ", бо саме
// такий розділ уже є в апці для TSN. Той самий антивоєнний фільтр.
async function parseItcFeed() {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true,
  });

  const byLink = new Map();      // link -> item (дедуп між адресами)
  let workingFeeds = 0;

  for (const url of ITC_FEED_URLS) {
    let xml;
    try {
      xml = await fetchURL(url);
    } catch (err) {
      console.warn(`[rss] ITC ${url}: ${err.message}`);
      continue;
    }
    // Якщо замість RSS прийшла HTML-сторінка (403/блок/редірект) — не парсимо.
    if (!/<rss[\s>]|<feed[\s>]/i.test(xml.slice(0, 2000))) {
      console.warn(`[rss] ITC ${url}: не RSS (початок: ${JSON.stringify(xml.slice(0, 60))})`);
      continue;
    }
    let result;
    try { result = parser.parse(xml); }
    catch { console.warn(`[rss] ITC ${url}: XML не розібрався`); continue; }

    const items = result?.rss?.channel?.item || [];
    const arr = Array.isArray(items) ? items : [items];
    let inSection = 0;
    for (const item of arr) {
      const link = extractLink(item);
      if (!link || !link.includes(ITC_ARTICLE_PATH)) continue;
      inSection++;
      if (!byLink.has(link)) byLink.set(link, item);
    }
    workingFeeds++;
    console.log(`   ITC feed OK: ${url} → ${arr.length} items, ${inSection} у ${ITC_ARTICLE_PATH}`);
  }

  if (workingFeeds === 0) {
    console.warn("[rss] ITC.ua: жодна адреса не віддала RSS — задай робочу через ITC_RSS_URL");
    return [];
  }

  let tooShort = 0, skippedFormat = 0, war = 0;
  const out = [];
  let index = 0;
  for (const item of byLink.values()) {
    const title = stripHTML(item.title || "");
    const description = stripHTML(item["content:encoded"] || item.description || "");
    if (!title || !description) continue;
    if (ITC_SKIP_TITLE.some(re => re.test(title))) { skippedFormat++; continue; }
    if (description.length < 400) { tooShort++; continue; }
    if (isWarRelated(title, description)) { war++; continue; }
    out.push({
      title,
      description,
      imageUrl:  extractImageUrl(item),
      link:      extractLink(item),
      pubDate:   parsePubDate(item.pubDate),
      feedOrder: index++,
      source:    "ITC.ua",
      category:  "Наука та ІТ",
    });
  }
  console.log(`   ITC: ${byLink.size} статей у стрічках → ${out.length} придатних (відсіяно: війна ${war}, формат-добірка/огляд ${skippedFormat}, закороткі ${tooShort})`);
  if (tooShort > 0 && out.length === 0) {
    console.warn("   ⚠️  ITC: усі статті закороткі — стрічка, схоже, віддає лише анонси (excerpt) без повного тексту.");
  }
  return out;
}

module.exports = { parseRSSFeeds, fetchOgImage, parseTsnFeed, parseItcFeed, isWarRelated };
