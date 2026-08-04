# AutoProxy

Auto proxy checker on **Cloudflare Workers** that serves every visitor a **PAC (Proxy Auto-Config) profile** built from freshly health-checked public proxies.

This is a Worker-native port of the original `main.php` — instead of trusting the first N entries of one GitHub proxy list, it:

1. Reads every enabled source from `proxy-sources.json` (82 sources, types `github_raw`, `generic_text`, `subscription_base64`, `tor_exit`; protocols `http`, `socks4`, `socks5`, `socks5h`).
2. Parses them into `host:port` candidates.
3. **Health-checks candidates in parallel** from the Worker (HTTP proxies via an absolute-form request through the proxy, SOCKS via a reachability probe).
4. Serves the surviving proxies as a PAC profile with fail-over (browser tries the first proxy, falls back to the next, ends with `DIRECT` so traffic never hangs).
5. **Edge-caches** the result so repeat visitors are served from cache and you stay comfortably inside the **Workers Free Tier** (100k requests/day).

## Deploy

Prerequisites: Node 18+, a free Cloudflare account, `wrangler` CLI.

```sh
cd AutoProxy
npm install
npx wrangler login        # once, opens the browser
npm run deploy            # wrangler deploy
```

Wrangler prints your URL, typically `https://autoproxy.<your-subdomain>.workers.dev`.

## Use it

Point your browser / OS *Automatic proxy configuration URL* (WPAD/PAC setting) at any of:

- `https://autoproxy.<your-subdomain>.workers.dev/`
- `https://autoproxy.<your-subdomain>.workers.dev/proxy.pac`
- `https://autoproxy.<your-subdomain>.workers.dev/fresh` — bypass cache and regenerate now

Health/telemetry:

- `GET /status` — JSON `{ ok, sources: { enabled, total } }`

The response has the proper PAC content type (`application/x-ns-proxy-autoconfig`), so browsers accept it directly.

## Configuration

Tunables in `wrangler.toml` `[vars]` (no rebuild needed — change and redeploy):

| Var | Default | Meaning |
|-----|---------|---------|
| `PROXY_TARGET` | `8` | how many live proxies to put in the PAC |
| `PROXY_CANDIDATES` | `40` | how many candidates to sample & health-check per refresh |
| `CHECK_TIMEOUT_MS` | `2500` | per-proxy health-check timeout |
| `CACHE_TTL` | `300` | seconds the edge cache keeps one pooled PAC (0 disables) |
| `PAC_ROUTE_BYPASS` | `true` | bypass proxy for plain hostnames, localhost, private IPs |
| `LOG_JSON` | `true` | emit structured JSON logs visible via `wrangler tail` |

To manage sources, edit `proxy-sources.json` (each entry: `id, url, type, protocol, enabled, name, validated`). Only entries with `"enabled": true` and a supported protocol are used. Set other sources to `true` to widen the pool.

## Why this fits the Free Tier

- **100k requests/day** is more than typical PAC-pull traffic; the default `CACHE_TTL=300s` means visitors share one cached PAC, so your billable fetches are ~1 per 5 minutes, not per visitor.
- **10 ms CPU time** per request is respected: parsing is a few regex passes over ≤ a few hundred KB of text, and the parallel health checks are I/O-bound, not CPU-bound.
- **No KV/D1/R2 bindings** — those cost extra on the Free Tier and aren't needed; the Worker fetches and checks proxies on the fly per refresh.

## How a check actually works

```
┌─────────────┐   fetch source urls    ┌─────────────┐
│ proxy-      │ ─────────────────────► │ github_raw / │
│ sources.json│   sample 4 at a time   │ generic_text │
│  (enabled,  │                        │ base64 subs  │
│  supported) │ ◄──── candidate IPs ── │ tor_exit     │
└──────┬──────┘                        └─────────────┘
       │ parse ip:port, sniff protocol
       ▼
  dedupe → sample PROXY_CANDIDATES (40)
       │
       ▼  parallel health-check (timeout 2.5s, 12 in flight)
  http proxies:  absolute-form request through the proxy
  socks4/5(h):   TCP-reachability probe (fetch limit: no raw SOCKS)
       │
       ▼
  top PROXY_TARGET (8) shuffled live proxies
       │
       ▼
  build PAC:  "PROXY 1.2.3.4:80; SOCKS5 5.6:1080; …; DIRECT"
       │
       ▼
  Response: application/x-ns-proxy-autoconfig, Cache-Control
  + caches.default.put() for edge caching
```

## Local development & tests

```sh
npm run dev     # wrangler dev — local Worker with real fetch
npm test        # node --test — parser + PAC unit tests (13 passing)
npm run deploy  # ship to Cloudflare
```

## Limitations to know

- **HTTP/S proxies checked end-to-end; SOCKS4/5 only TCP-reachability-checked.** Workers' `fetch()` can't speak SOCKS, so the SOCKS path just confirms the port accepts a connection. That's usually enough because most false entries are dead hosts, but a PAC chain ending in `DIRECT` protects clients when a SOCKS entry lies.
- **Free proxies are unstable** — expect PAC chains to lose entries quickly; the browser's built-in failover covers this, and the cache TTL keeps rotations gentle.
- **First request after a cache miss takes ~2–5s** (source fetch + parallel checks). Subsequent visitors are served instantly from the edge cache.
