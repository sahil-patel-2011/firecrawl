# Firecrawl on a Raspberry Pi 5

This tree is modified [Firecrawl](https://github.com/firecrawl/firecrawl), licensed under the GNU Affero General Public License v3.0. The original copyright remains in `LICENSE`.

- Upstream: https://github.com/firecrawl/firecrawl
- This fork: https://github.com/sahil-patel-2011/firecrawl

Modified Firecrawl, AGPL-3.0, optimized to run search and fetch on a Raspberry Pi 5. If you run this API on a network, offer this source to its users. The process serves the same links from `GET /` and `GET /source`, and sends them in the `X-Source-Repo` header.

## What runs

One container. One Node API process and Chromium on localhost. Search and single-URL scrape run inside the request. Postgres, Redis, RabbitMQ, FoundationDB, SearXNG, and the extract, index, and queue workers are not started.

Search uses Firecrawl's built-in DuckDuckGo path. Fetch runs first and uses the same Go HTML-to-markdown library. A Chromium tab opens when the fetched page has almost no text, up to 16 tabs, with a renderer heap cap so the browser stays near 5GB. Images, fonts, and video are not downloaded into those tabs. Article text is not truncated; the HTML safety cap is 5MB.

The comfortable rate is 2000 requests per minute of `/v2/search` and `/v2/scrape` on the fetch path. Sixteen full browser renders at that rate are not the target.

## Host

Use 64-bit Raspberry Pi OS on a Pi 5 with 8GB of RAM. Use Ethernet. Set the CPU governor to `performance`. Keep swap off, or very small, so a burst cannot stall the box in swap.

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git
echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
```

Build on the Pi so the Go library and Chromium are `linux/arm64`:

```bash
docker compose -f docker-compose.pi5.yaml up --build
```

Set `PI5_API_KEYS` in `.env.pi5` before anyone else can reach port 3002. Send `Authorization: Bearer <key>`.

```bash
curl -s http://127.0.0.1:3002/source
curl -s http://127.0.0.1:3002/v2/search \
  -H "Authorization: Bearer pi5-local-key" \
  -H "content-type: application/json" \
  -d '{"query":"raspberry pi","limit":3}'
curl -s http://127.0.0.1:3002/v2/scrape \
  -H "Authorization: Bearer pi5-local-key" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com"}'
```

## Bench

On the Pi, after the API is up:

```bash
node apps/api/scripts/pi5-bench.mjs --strict
```

`--strict` requires 2000 requests per minute for two minutes on the fetch path, then checks that 16 Chromium tabs can be open together. Without `--strict` the script only prints the numbers.
