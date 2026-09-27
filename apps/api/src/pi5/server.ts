import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { logger } from "../lib/logger";
import { CostTracking } from "../lib/cost-tracking";
import { scrapeOptions } from "../controllers/v2/types";
import { search } from "../search/v2";
import { scrapeURL } from "../scraper/scrapeURL";
import type { Engine } from "../scraper/scrapeURL/engines";
import { TtlLru } from "./cache";
import { Semaphore, TokenBucket } from "./limits";

const UPSTREAM = config.PI5_UPSTREAM_REPO;
const SOURCE = config.PI5_SOURCE_REPO;

const keys = new Set(
  (config.PI5_API_KEYS ?? "")
    .split(",")
    .map(key => key.trim())
    .filter(key => key.length > 0),
);

if (!config.PI5_PROFILE) {
  logger.error("Pi 5 server requires PI5_PROFILE=true");
  process.exit(1);
}

if (keys.size === 0) {
  logger.error("Pi 5 server requires PI5_API_KEYS");
  process.exit(1);
}

const cache = new TtlLru<unknown>(config.PI5_CACHE_MAX_ENTRIES);
const buckets = new TokenBucket();
const fetchSlots = new Semaphore(config.PI5_FETCH_CONCURRENCY);
const searchSlots = new Semaphore(config.PI5_SEARCH_CONCURRENCY);

const sourceBody = {
  name: "Firecrawl",
  statement:
    "Modified Firecrawl, AGPL-3.0, optimized to run search and fetch on a Raspberry Pi 5.",
  license: "AGPL-3.0",
  upstream: UPSTREAM,
  source: SOURCE,
};

function sendSource(res: Response): void {
  res.setHeader("X-Source-Repo", SOURCE);
  res.json(sourceBody);
}

function bearer(req: Request): string | null {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? null;
}

function requireKey(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Source-Repo", SOURCE);
  const key = bearer(req);
  if (!key || !keys.has(key)) {
    res.status(401).json({
      success: false,
      error: "A valid API key is required.",
    });
    return;
  }
  if (!buckets.take(key, config.PI5_PER_KEY_RPM, 60_000)) {
    res.status(429).json({
      success: false,
      error: "Per-key rate limit exceeded.",
    });
    return;
  }
  next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use((_req, res, next) => {
  res.setHeader("X-Source-Repo", SOURCE);
  next();
});

app.get("/", (_req, res) => {
  sendSource(res);
});

app.get("/source", (_req, res) => {
  sendSource(res);
});

app.get("/pi5/browser", requireKey, async (_req, res) => {
  try {
    const response = await fetch("http://127.0.0.1:3000/stats");
    const body = await response.json();
    res.status(response.status).json(body);
  } catch (error) {
    logger.warn("Chromium stats unavailable", { error });
    res.status(503).json({
      success: false,
      error: "Chromium stats unavailable",
    });
  }
});

app.post("/v2/search", requireKey, async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    res.status(400).json({ success: false, error: "query is required" });
    return;
  }

  const limit =
    typeof req.body?.limit === "number" && req.body.limit > 0
      ? Math.min(100, Math.floor(req.body.limit))
      : 10;
  const lang = typeof req.body?.lang === "string" ? req.body.lang : "en";
  const country =
    typeof req.body?.country === "string" ? req.body.country : "us";
  const tbs = typeof req.body?.tbs === "string" ? req.body.tbs : undefined;
  const cacheKey = `s:${query.toLowerCase()}|${limit}|${lang}|${country}|${tbs ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  try {
    const data = await searchSlots.use(() =>
      search({
        query,
        logger,
        num_results: limit,
        lang,
        country,
        tbs,
        timeout: 8000,
      }),
    );
    const body = { success: true, data };
    cache.set(cacheKey, body, config.PI5_SEARCH_TTL_MS);
    res.json(body);
  } catch (error) {
    logger.warn("Search failed", { error });
    res.status(502).json({
      success: false,
      error: error instanceof Error ? error.message : "Search failed",
    });
  }
});

app.post("/v2/scrape", requireKey, async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!url) {
    res.status(400).json({ success: false, error: "url is required" });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    res.status(400).json({ success: false, error: "url is invalid" });
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    res.status(400).json({ success: false, error: "url must be http or https" });
    return;
  }

  const forceBrowser = req.body?.forceBrowser === true;
  const formats = Array.isArray(req.body?.formats) ? req.body.formats : ["markdown"];
  const waitFor =
    typeof req.body?.waitFor === "number" ? req.body.waitFor : undefined;
  const cacheKey = `f:${url}|${JSON.stringify(formats)}|${forceBrowser ? "browser" : "auto"}|${waitFor ?? 0}`;
  if (!forceBrowser) {
    const cached = cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }
  }

  let options;
  try {
    options = scrapeOptions.parse({
      formats,
      ...(waitFor !== undefined ? { waitFor } : {}),
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: "Invalid scrape options",
      details: error instanceof Error ? error.message : error,
    });
    return;
  }

  const forceEngine: Engine | undefined = forceBrowser ? "playwright" : undefined;

  try {
    const result = await fetchSlots.use(() =>
      scrapeURL(
        `pi5:${Date.now()}`,
        url,
        options,
        {
          teamId: "pi5",
          orgId: null,
          bypassBilling: true,
          ...(forceEngine ? { forceEngine } : {}),
        },
        new CostTracking(),
      ),
    );

    if (!result.success) {
      res.status(502).json({
        success: false,
        error: "Scrape failed",
      });
      return;
    }

    const body = { success: true, data: result.document };
    if (!forceBrowser) {
      cache.set(cacheKey, body, config.PI5_FETCH_TTL_MS);
    }
    res.json(body);
  } catch (error) {
    logger.warn("Scrape failed", { error });
    res.status(502).json({
      success: false,
      error: error instanceof Error ? error.message : "Scrape failed",
    });
  }
});

const port = config.PORT;
const host = config.HOST;

app.listen(port, host, () => {
  logger.warn(
    `Pi 5 Firecrawl listening on ${host}:${port}. Upstream ${UPSTREAM}. Source ${SOURCE}`,
  );
});
