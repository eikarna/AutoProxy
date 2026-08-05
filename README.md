# AutoProxy

Auto proxy checker on **Cloudflare Workers** that serves every visitor a **PAC (Proxy Auto-Config) profile** built from freshly health-checked public proxies.

This is a Worker-native port of the original `main.php` — instead of trusting the first N entries of one GitHub proxy list, it:

1. Reads every enabled source from `proxy-sources.json` (82 sources, types `github_raw`, `generic_text`, `subscription_base64`, `tor_exit`; protocols `http`, `socks4`, `socks5`, `socks5h`).
2. Parses them into `host:port` candidates and drops private/loopback/CGNAT/multicast junk.
3. **Health-checks candidates in parallel over raw TCP sockets** (`cloudflare:sockets`) — speaking each proxy's real protocol and requiring a genuine response from a probe page *through* the proxy. Survivors are sorted by measured latency.
4. Serves the fastest surviving proxies as a PAC profile with fail-over (browser tries the first proxy, falls back to the next, ends with `DIRECT` so traffic never hangs).
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
- `GET /debug` — live pipeline diagnostics: per-source fetch results, candidate counts, and real check outcomes (never cached)

The response has the proper PAC content type (`application/x-ns-proxy-autoconfig`), so browsers accept it directly.

## Configuration

Tunables in `wrangler.toml` `[vars]` (no rebuild needed — change and redeploy):

| Var | Default | Meaning |
|-----|---------|---------|
| `PROXY_TARGET` | `100`* | how many live proxies to put in the PAC (fastest first) |
| `PROXY_CANDIDATES` | `1000`* | how many candidates to sample & health-check per refresh |
| `CHECK_TIMEOUT_MS` | `2500` | per-proxy health-check timeout |
| `CACHE_TTL` | `300` | seconds the edge cache keeps one pooled PAC (0 disables) |
| `PAC_ROUTE_BYPASS` | `true` | bypass proxy for plain hostnames, localhost, private IPs |
| `LOG_JSON` | `true` | emit structured JSON logs visible via `wrangler tail` |

\* **Capped in code:** `PROXY_TARGET` at **20** and `PROXY_CANDIDATES` at **150**. Every real health check can take up to `CHECK_TIMEOUT_MS`, so unbounded values would blow past Free-Tier wall-time before answering. Also note the PAC chain is walked *in order* by the browser — all entries are pre-verified alive, so entries beyond the first few only kick in when earlier ones die; more entries mostly adds PAC weight, not reliability. **5–10 is the sweet spot.**

To manage sources, edit `proxy-sources.json` (each entry: `id, url, type, protocol, enabled, name, validated`). Only entries with `"enabled": true`, a supported protocol, and a usable type are used. Notes:

- `tor_exit` sources are **always skipped** — Tor exit relays are not forward proxies and would flood the candidate pool.
- Bodies that look like HTML are skipped (some `generic_text` URLs point at GitHub repo *pages* instead of raw files — they can never yield `ip:port` lines). Point such sources at raw file URLs instead.
- One giant list can't dominate: each source contributes at most `PROXY_CANDIDATES / 4` candidates to the pool.

## Why this fits the Free Tier

- **100k requests/day** is more than typical PAC-pull traffic; the default `CACHE_TTL=300s` means visitors share one cached PAC, so your billable fetches are ~1 per 5 minutes, not per visitor.
- **10 ms CPU time** per request is respected: parsing is a few regex passes over ≤ a few hundred KB of text, and the parallel health checks are I/O-bound, not CPU-bound.
- **No KV/D1/R2 bindings** — those cost extra on the Free Tier and aren't needed; the Worker fetches and checks proxies on the fly per refresh.

## How a check actually works

The earlier design used `fetch()`, which can't route through an arbitrary proxy — so it could only prove a port was *open*, not that the proxy *forwarded* traffic. That let dead/slow public-list proxies into the PAC and caused browsers to hang on subresources. The checker now opens **raw TCP connections** with `cloudflare:sockets` and speaks each protocol natively, then fetches `http://www.gstatic.com/generate_204` **through the proxy** and demands a real `2xx/3xx` back:

```
┌─────────────┐   fetch source urls    ┌─────────────┐
│ proxy-      │ ─────────────────────► │ github_raw / │
│ sources.json│   sample 4 at a time   │ generic_text │
│  (enabled,  │                        │ base64 subs  │
│  supported) │ ◄──── candidate IPs ── │ tor_exit     │
└──────┬──────┘                        └─────────────┘
       │ parse ip:port, sniff protocol, drop junk IPs
       ▼
  dedupe → sample PROXY_CANDIDATES (30)
       │
       ▼  parallel real check over raw TCP (timeout 2.5s, 12 in flight)
  http:        absolute-form GET through the proxy
  socks5(h):   SOCKS5 greeting + CONNECT + HTTP through the tunnel
  socks4:      SOCKS4 CONNECT + HTTP through the tunnel
  all require: HTTP/1.x 2xx|3xx from www.gstatic.com/generate_204
       │
       ▼
  survivors sorted by latency → top PROXY_TARGET (5)
       │
       ▼
  build PAC:  "PROXY 1.2.3.4:80; SOCKS5 5.6:1080; …; DIRECT"
       │
       ▼
  Response: application/x-ns-proxy-autoconfig, Cache-Control
  + caches.default.put() for edge caching
```

Only a proxy that actually forwards the probe and returns a success status makes it into the PAC — and faster proxies are listed first so browsers hit the snappiest ones before falling back.

## Local development & tests

```sh
npm run dev     # wrangler dev — local Worker with real fetch
npm test        # node --test — parser, PAC, checker & handler tests (29 passing)
npm run deploy  # ship to Cloudflare
```

The checker is unit-tested against fake sockets (see `test/checker.test.js`), so the protocol handshakes are verified without needing workerd or live proxies.

## Limitations to know

- **Free proxies are inherently unstable** — a proxy alive at check time can die minutes later. The PAC chain's built-in failover plus the trailing `DIRECT` protects clients, and the 5-minute cache keeps rotation gentle. If you still see `Failed resources`, lower `PROXY_TARGET` (fewer, better entries) or enable only the most reliable sources in `proxy-sources.json`.
- **HTTP proxies are checked via plaintext `generate_204`.** A proxy that forwards HTTP but breaks HTTPS (rare) would still pass. This is the cheapest reliable signal available on the Free Tier.
- **First request after a cache miss takes ~2–6s** (source fetch + parallel real checks). Subsequent visitors are served instantly from the edge cache.
