import express, { json } from "express";
import cors from "cors";
import { chromium } from "playwright";
import pLimit from "p-limit";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { getTVSubtitleVTT } from "./utils/tvSubtitles.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
export const OPENSUB_API_KEY = process.env.OPENSUB_API_KEY;
export const TMDB_API_KEY = process.env.TMDB_API_KEY;
export const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;

export const headers = {
  Authorization: `Bearer ${TMDB_BEARER_TOKEN}`,
  "Content-Type": "application/json;charset=utf-8",
};

app.use(cors());
app.use(json());

// 🎯 مصفوفة السيرفرات المحدثة (VidSrc + VidLink فقط)
const PROVIDERS = [
  // --- شبكة VidSrc ---
  {
    name: "vidsrc.pm",
    getMovieUrl: (id) => `https://vidsrc.pm/embed/movie/${id}`,
    getTvUrl: (id, s, e) => `https://vidsrc.pm/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  
  {
    name: "watchout",
    getMovieUrl: (id) => `https://watchout-player.netlify.app/movie/${id}`,
    getTvUrl: (id, s, e) => `https://watchout-player.netlify.app/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    name: "watchout",
    getMovieUrl: (id) => `https://401473fc.vidrift.pages.dev/embed/movie/${id}`,
    getTvUrl: (id, s, e) => `https://401473fc.vidrift.pages.dev/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    name: "vidlink.pro",
    getMovieUrl: (id) => `https://vidlink.pro/movie/${id}`,
    getTvUrl: (id, s, e) => `https://vidlink.pro/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    name: "videasy.net",
    getMovieUrl: (id) => `https://player.videasy.net/movie/${id}`,
    getTvUrl: (id, s, e) => `https://player.videasy.net/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    name: "vidsrc.to",
    getMovieUrl: (id) => `https://vidsrc.to/embed/movie/${id}`,
    getTvUrl: (id, s, e) => `https://vidsrc.to/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    name: "primesrc.me",
    getMovieUrl: (id) => `https://primesrc.me/embed/movie/${id}`,
    getTvUrl: (id, s, e) => `https://primesrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    name: "vidsrc.io",
    getMovieUrl: (id) => `https://vidsrc.io/embed/movie/${id}`,
    getTvUrl: (id, s, e) => `https://vidsrc.io/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },

  // --- شبكة VidLink والسيرفرات السريعة ---
  {
    name: "vidlink.pro",
    getMovieUrl: (id) => `https://vidlink.pro/movie/${id}`,
    getTvUrl: (id, s, e) => `https://vidlink.pro/tv/${id}/${s}/${e}`,
  },
  {
    name: "vidsrc.me",
    getMovieUrl: (id) => `https://vidsrc.me/embed/movie/${id}`,
    getTvUrl: (id, s, e) => `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
];

export const LANGUAGE_NAMES = {
  en: "English",
};

export const COMMON_LANGUAGES = Object.keys(LANGUAGE_NAMES);

// Global browser instance, launched once
let browser;

// Simple in-memory cache to avoid scraping same query repeatedly (15 minutes)
const cache = new Map();

// 🧠 Scraper util function
async function scrapeProvider(domain, url) {
  console.log(`\n[${domain}] Starting scrape for URL:${url}`);

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const page = await context.newPage();

  let mediaUrl = null;
  const subtitles = [];

  // 🎯 دالة فحص الترجمة
  const isSubtitle = (url) => {
    const cleanUrl = url.toLowerCase();

    if (
      cleanUrl.includes("thumbnail") ||
      cleanUrl.includes("preview") ||
      cleanUrl.includes("sprite")
    ) {
      return false;
    }

    return (
      /\.(vtt|srt|ass|ssa|ttml|dfxp|xml)(\?.*)?$/i.test(cleanUrl) ||
      cleanUrl.includes(".vtt") ||
      cleanUrl.includes(".srt") ||
      cleanUrl.includes("subtitle")
    );
  };

  // 🎯 دالة فحص البث المباشر
  const isVideoStream = (url) => {
    const cleanUrl = url.toLowerCase();

    const hasVideoExtension =
      /\.(m3u8|mpd|mp4|m4v|webm|mkv|ts)(\?.*)?$/i.test(cleanUrl);

    const hasStreamKeyword =
      cleanUrl.includes(".m3u8") ||
      cleanUrl.includes(".mpd") ||
      cleanUrl.includes("/hls/") ||
      cleanUrl.includes("index.m3u8") ||
      cleanUrl.includes("/manifest") ||
      cleanUrl.includes(".ism/");

    return hasVideoExtension || hasStreamKeyword;
  };

  try {
    // 1. الاعتراض والتنصت على الشبكة
    page.on("request", (request) => {
      const reqUrl = request.url();

      if (!mediaUrl && isVideoStream(reqUrl)) {
        mediaUrl = reqUrl;
        console.log(`[${domain}] 🎯 Found Stream URL: ${mediaUrl}`);
      }

      if (isSubtitle(reqUrl) && !subtitles.includes(reqUrl)) {
        subtitles.push(reqUrl);
        console.log(`[${domain}] Found Subtitle:${reqUrl}`);
      }
    });

    // 2. الانتقال إلى الصفحة مع حماية الـ DNS
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch((e) => {
      throw new Error(`Navigation failed: ${e.message}`);
    });

    console.log(`[${domain}] Page loaded, searching frames...`);
    await page.waitForTimeout(2500);

    // 3. التفاعل مع المشغلات و الأطر داخل الصفحة
    for (const frame of page.frames()) {
      try {
        await frame.hover("body").catch(() => {});

        const playSelectors = [
          "#player",
          ".play",
          "video",
          "button",
          "div[class*='play']",
          "div[id*='player']",
        ];

        for (const selector of playSelectors) {
          const el = await frame.$(selector);
          if (el) {
            await el.click({ force: true, timeout: 1500 }).catch(() => {});
            break;
          }
        }
      } catch (e) {
        // تجاهل أي أطر لا يمكن فتحها
      }
    }

    // 4. حلقة الانتظار لتوليد روابط الشبكة
    let retries = 0;
    while (!mediaUrl && retries < 10) {
      await page.waitForTimeout(1000);
      retries++;
    }

    await page.close().catch(() => {});
    await context.close().catch(() => {});

    if (!mediaUrl) throw new Error("Media Stream URL not found");

    return { hls_url: mediaUrl, subtitles, error: null };
  } catch (error) {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    console.error(`[${domain}] Error:${error.message}`);
    return { hls_url: null, subtitles: [], error: error.message };
  }
}

// 🎯 Endpoint الأصلي Extract
app.get("/extract", async (req, res) => {
  const type = req.query.type || "movie";
  const tmdb_id = req.query.tmdb_id;
  const season = req.query.season ? parseInt(req.query.season) : undefined;
  const episode = req.query.episode ? parseInt(req.query.episode) : undefined;

  if (!tmdb_id) {
    return res.status(400).json({
      success: false,
      error: "tmdb_id query param is required",
      results: {},
    });
  }

  if (type === "tv" && (season == null || episode == null)) {
    return res.status(400).json({
      success: false,
      error: "season and episode query params are required for TV shows",
      results: {},
    });
  }

  const cacheKey = JSON.stringify(req.query);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 1000 * 60 * 15) {
    console.log("Serving from cache");
    return res.json(cached.response);
  }

  // 🎯 تركيبة الروابط الديناميكية بناءً على المزود
  const urls = PROVIDERS.map((provider) => ({
    domain: provider.name,
    url:
      type === "tv"
        ? provider.getTvUrl(tmdb_id, season, episode)
        : provider.getMovieUrl(tmdb_id),
  }));

  try {
    console.log(`🔍 جاري فحص السيرفرات المتنوعة بالتوازي...`);

    const limit = pLimit(5);
    const scrapePromises = urls.map(({ domain, url }) =>
      limit(async () => {
        const result = await scrapeProvider(domain, url);
        return { domain, result };
      })
    );

    const providerResults = await Promise.all(scrapePromises);

    const results = {};
    let atLeastOneSuccess = false;

    providerResults.forEach(({ domain, result }) => {
      results[domain] = result;
      if (result.hls_url) {
        atLeastOneSuccess = true;
      }
    });

    const response = {
      success: atLeastOneSuccess,
      results,
    };

    cache.set(cacheKey, {
      timestamp: Date.now(),
      response,
    });

    return res.json(response);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Unexpected server error",
      results: {},
    });
  }
});

// 🎯 دعم مسار /scrape لتجنب خطأ Cannot GET /scrape
app.get("/scrape", async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({
      success: false,
      error: "url query parameter is required (e.g. /scrape?url=https://vidsrc.to/...)",
    });
  }

  try {
    // استخراج اسم الدومين
    const domain = new URL(targetUrl).hostname;
    const result = await scrapeProvider(domain, targetUrl);

    return res.json({
      success: !!result.hls_url,
      results: {
        [domain]: result,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to scrape URL",
    });
  }
});

/**
 * 🎯 TMDB -> IMDb (for movies only)
 */
async function getIMDbIdFromTMDB(tmdb_id, type = "movie") {
  const url = `https://api.themoviedb.org/3/${type}/${tmdb_id}/external_ids?api_key=${TMDB_API_KEY}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error("Failed to fetch IMDb ID from TMDB");
  const json = await response.json();
  return json.imdb_id || null;
}

/**
 * 🧠 Unified Subtitle Search (for movies only)
 */
async function searchSubtitles(imdb_id) {
  const res = await fetch(
    `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${imdb_id}&per_page=100&page=1`,
    {
      headers: {
        "Api-Key": OPENSUB_API_KEY,
        "User-Agent": "Cinemi v1.0.0",
      },
    }
  );

  if (!res.ok) {
    console.error("[OpenSubtitles] Request failed");
    return [];
  }

  const json = await res.json();
  if (json.data.length === 0) {
    return [];
  }

  return (json.data || [])
    .filter(
      (item) =>
        item.attributes?.files?.[0]?.file_id &&
        COMMON_LANGUAGES.includes(item.attributes.language)
    )
    .map((item) => {
      const file = item.attributes.files[0];
      const lang = item.attributes.language;
      return {
        language: lang,
        language_name: LANGUAGE_NAMES[lang] || lang,
        file_id: file.file_id,
        download_count: item.attributes.download_count || 0,
      };
    })
    .sort((a, b) => b.download_count - a.download_count)
    .slice(0, 2);
}

/**
 * 🧠 Get Download URL from OpenSubtitles (for Movies only)
 */
async function getSubtitleDownloadUrl(file_id) {
  const res = await fetch("https://api.opensubtitles.com/api/v1/download", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": OPENSUB_API_KEY,
      "User-Agent": "Cinemi v1.0.0",
    },
    body: JSON.stringify({ file_id }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[OpenSubtitles] Failed to get download link:", text);
    throw new Error("Subtitle download URL fetch failed");
  }

  const json = await res.json();
  return json.link;
}

/**
 * 🔥 Subtitles Endpoint (for movies only)
 */
app.get("/movie-subtitles", async (req, res) => {
  const { tmdb_id, type = "movie" } = req.query;

  if (!tmdb_id) {
    return res
      .status(400)
      .json({ success: false, error: "tmdb_id is required" });
  }

  try {
    const imdb_id = await getIMDbIdFromTMDB(tmdb_id, type);
    if (!imdb_id) {
      return res
        .status(404)
        .json({ success: false, error: "IMDb ID not found" });
    }

    const baseList = await searchSubtitles(imdb_id);

    const subtitles = await Promise.all(
      baseList.map(async (sub) => {
        if (sub.url) return sub;
        try {
          const url = await getSubtitleDownloadUrl(sub.file_id);
          return {
            language: sub.language,
            language_name: sub.language_name,
            url,
          };
        } catch {
          return null;
        }
      })
    );

    res.json({
      success: true,
      subtitles: subtitles.filter(Boolean),
      meta: {
        tmdb_id,
        imdb_id,
        type,
      },
    });
  } catch (err) {
    console.error("[/subtitles] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Subtitles Endpoint (for TV Shows only)
 */
app.get("/tv-subtitles", async (req, res) => {
  const { title, season, episode, type } = req.query;

  try {
    if (type === "tv") {
      const vtt = await getTVSubtitleVTT(title, season, episode);
      if (!vtt) return res.status(404).send("No subtitle found");
      return res.set("Content-Type", "text/vtt").send(vtt);
    }

    res.status(400).send("Invalid type provided");
  } catch (err) {
    console.error("❌ Subtitle API Error:", err.message);
    res.status(500).send("Internal server error");
  }
});

/**
 * 📦 Subtitle Proxy to Convert .srt → .vtt (for movies only)
 */
app.get("/subtitle-proxy", async (req, res) => {
  const fileUrl = req.query.url;
  if (!fileUrl) return res.status(400).send("Missing subtitle URL");

  try {
    const subtitleRes = await fetch(fileUrl);
    const srt = await subtitleRes.text();

    const vtt =
      "WEBVTT\n\n" +
      srt
        .replace(/\r+/g, "")
        .replace(/^\s+|\s+$/g, "")
        .split("\n")
        .map((line) =>
          line.replace(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g, "$1:$2:$3.$4")
        )
        .join("\n");

    res.setHeader("Content-Type", "text/vtt");
    res.send(vtt);
  } catch (err) {
    console.error("Subtitle Proxy Error:", err.message);
    res.status(500).send("Failed to convert subtitle");
  }
});

app.get("/", (req, res) => {
  res.send(
    "🎬 Multi-Server Scraper API is running. Visit /extract or /scrape to use."
  );
});

// Launch browser once before server starts listening
(async () => {
  browser = await chromium.launch({
    headless: true,
  });
  app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
  });
})();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Closing browser...");
  if (browser) await browser.close();
  process.exit();
});
process.on("SIGTERM", async () => {
  console.log("Closing browser...");
  if (browser) await browser.close();
  process.exit();
});
