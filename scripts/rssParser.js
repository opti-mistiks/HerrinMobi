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
  const media = item["media:content"];
  if (media) {
    const url = media["@_url"] || (Array.isArray(media) ? media[0]?.["@_url"] : null);
    if (url) return url;
  }
  const enc = item["enclosure"];
  if (enc) {
    const url = enc["@_url"] || (Array.isArray(enc) ? enc[0]?.["@_url"] : null);
    if (url) return url;
  }
  return null;
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

module.exports = { parseRSSFeeds };
