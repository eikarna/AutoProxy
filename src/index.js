// AutoProxy — Cloudflare Worker that fetches public proxy lists, checks which
// proxies are alive, and returns the good ones to visitors as a PAC profile.

import { parseSource, dedupe, SUPPORTED_PROTOCOLS } from './parsers.js';
import { filterAlive } from './checker.js';
import { buildPac } from './pac-template.js';
import sourcesConfig from './proxy-sources.json' with { type: 'json' };

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

function enabledSources() {
  const all = Array.isArray(sourcesConfig.sources) ? sourcesConfig.sources : [];
  return all.filter(
    (s) => s && s.enabled && s.url && SUPPORTED_PROTOCOLS.includes(s.protocol),
  );
}

// Fisher–Yates shuffle (partial shuffles are fine — we just need randomness so
// we don't hammer the first source every time).
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function fetchSource(source, timeoutMs) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(source.url, {
      signal: ctrl.signal,
      cf: { cacheTtl: 300, cacheEverything: true },
      headers: { 'User-Agent': 'AutoProxy/1.0 (+github.com)' },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const text = await res.text();
    return parseSource(source, text);
  } catch {
    return null;
  }
}

// Pull candidate proxies from a handful of enabled, supported sources until we
// have enough distinct candidates to health-check.
async function gatherCandidates(env, log) {
  const target = num(env.PROXY_CANDIDATES, 40);
  const sources = shuffle(enabledSources());
  const bag = [];

  // Fetch a few sources at a time to stay responsive.
  const window = 4;
  for (let i = 0; i < sources.length && bag.length < target; i += window) {
    const slice = sources.slice(i, i + window);
    const results = await Promise.all(slice.map((s) => fetchSource(s, 3500)));
    for (let k = 0; k < results.length; k++) {
      const cands = results[k];
      if (!cands || cands.length === 0) continue;
      bag.push(...cands);
      log.info({
        event: 'source_fetched',
        source: slice[k].name,
        candidates: cands.length,
      });
    }
  }

  return dedupe(bag).slice(0, target * 3); // check a few extra to survive failures
}

function makeLogger(enabled) {
  const write = (level, obj) => {
    if (!enabled) return;
    console.log(JSON.stringify({ level, ts: new Date().toISOString(), ...obj }));
  };
  return {
    info: (o) => write('info', o),
    error: (o) => write('error', o),
  };
}

function cacheKey(request) {
  // Key on the PAC URL only — strip query noise so all visitors share one cached PAC.
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  return new Request(url.toString(), { method: 'GET' });
}

async function handlePac(request, env, ctx) {
  const log = makeLogger(env.LOG_JSON !== 'false');
  const started = Date.now();
  const target = num(env.PROXY_TARGET, 8);
  const timeoutMs = num(env.CHECK_TIMEOUT_MS, 2500);
  const bypass = env.PAC_ROUTE_BYPASS !== 'false';

  const candidates = await gatherCandidates(env, log);
  log.info({ event: 'candidates_gathered', count: candidates.length });

  const alive = await filterAlive(candidates, { timeoutMs, limit: 12 });
  const chosen = shuffle(alive).slice(0, target);
  log.info({
    event: 'check_complete',
    checked: candidates.length,
    alive: alive.length,
    served: chosen.length,
    ms: Date.now() - started,
  });

  const pac = buildPac(chosen, { bypass });
  const ttl = num(env.CACHE_TTL, 300);

  const res = new Response(pac, {
    headers: {
      'Content-Type': 'application/x-ns-proxy-autoconfig',
      'Cache-Control': `public, max-age=${ttl}`,
      'X-Proxy-Count': String(chosen.length),
      'X-Generated': new Date().toISOString(),
    },
  });

  // Edge-cache the result so subsequent visitors are served from cache and we
  // stay comfortably inside the free-tier request quota. Cache writes happen
  // off the critical path.
  if (ttl > 0) ctx.waitUntil(caches.default.put(cacheKey(request), res.clone()));
  return res;
}

async function handleStatus() {
  const sources = enabledSources();
  const body = {
    ok: true,
    service: 'autoproxy',
    time: new Date().toISOString(),
    sources: { enabled: sources.length, total: (sourcesConfig.sources || []).length },
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}

const HELP = `AutoProxy
=========
Serves a PAC (Proxy Auto-Config) profile built from freshly health-checked public proxies.

GET /           -> PAC file (application/x-ns-proxy-autoconfig), edge-cached
GET /proxy.pac  -> alias of /
GET /fresh      -> bypass edge cache and regenerate now
GET /status     -> JSON health info

Point your browser/OS "Automatic proxy configuration URL" at https://<your-worker>.workers.dev/
`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // /fresh skips the edge cache so callers can force a fresh check pass.
    const skipCache = path === '/fresh';

    if (path === '/' || path === '/proxy.pac' || path === '/fresh') {
      if (!skipCache) {
        const hit = await caches.default.match(cacheKey(request));
        if (hit) return hit;
      }
      return handlePac(request, env, ctx);
    }

    if (path === '/status') return handleStatus();

    return new Response(HELP, {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
