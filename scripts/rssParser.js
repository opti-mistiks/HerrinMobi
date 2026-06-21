const https = require("https");
const http = require("http");
const { XMLParser } = require("fast-xml-parser");

const RSS_SOURCES = [
  { name: "20min Schweiz",    url: "https://partner-feeds.20min.ch/rss/20minuten/schweiz" },
  { name: "20min Sport",      url: "https://partner-feeds.20min.ch/rss/20minuten/sport" },
  { name: "20min Wirtschaft", url: "https://partner-feeds.20min.ch/rss/20minuten/wirtschaft" },
  { name: "20min People",     url: "https://partner-feeds.20min.ch/rss/20minuten/people" },
  { name: "SRF News",         url: "https://www.srf.ch/news/bnf/rss/1646" },
];

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

module.exports = { parseRSSFeeds, fetchOgImage };