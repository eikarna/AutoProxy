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

// Hard ceilings keep Free-Tier wall-time sane: every candidate check can take
// up to CHECK_TIMEOUT_MS, and browsers walk the PAC chain in order — so
// enormous values cost latency without adding reliability.
const MAX_TARGET = 20;
const MAX_CANDIDATES = 150;

// Source types that yield usable forward proxies. `tor_exit` is excluded: those
// are Tor exit relays, not HTTP/SOCKS proxies, so they can't serve a PAC and
// would otherwise flood the candidate pool (one list returned 3000+ of them).
const USABLE_SOURCE_TYPES = ['github_raw', 'generic_text', 'subscription_base64'];

function enabledSources() {
  const all = Array.isArray(sourcesConfig.sources) ? sourcesConfig.sources : [];
  return all.filter(
    (s) =>
      s &&
      s.enabled &&
      s.url &&
      SUPPORTED_PROTOCOLS.includes(s.protocol) &&
      USABLE_SOURCE_TYPES.includes(s.type),
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
    if (!res.ok) return { source, ok: false, error: `HTTP ${res.status}`, bytes: 0, cands: [] };
    let text = await res.text();
    // Bound CPU on huge lists (some hold 10k+ proxies): we only ever take a few
    // dozen candidates per source, so parsing past ~128 KB is wasted work.
    // (Base64 subscriptions need the whole body to decode — never truncate those.)
    if (source.type !== 'subscription_base64' && text.length > 128 * 1024) {
      text = text.slice(0, 128 * 1024);
    }
    return { source, ok: true, bytes: text.length, cands: parseSource(source, text) };
  } catch (e) {
    return { source, ok: false, error: String((e && e.message) || e), bytes: 0, cands: [] };
  }
}

// Pull candidate proxies from a handful of enabled, supported sources until we
// have enough distinct candidates to health-check.
async function gatherCandidates(env, log, wanted) {
  const target = Math.min(wanted, MAX_CANDIDATES);
  if (wanted > MAX_CANDIDATES) {
    log.info({ event: 'candidates_capped', wanted, cappedTo: target });
  }
  const sources = shuffle(enabledSources());
  const bag = [];

  // Cap any single source so one giant list can't dominate the pool and starve
  // the others (a single source once supplied 95%+ of candidates).
  const PER_SOURCE_CAP = Math.max(8, Math.floor(target / 4));

  // Fetch a few sources at a time to stay responsive.
  const window = 4;
  for (let i = 0; i < sources.length && bag.length < target; i += window) {
    const slice = sources.slice(i, i + window);
    const results = await Promise.all(slice.map((s) => fetchSource(s, 3500)));
    for (let k = 0; k < results.length; k++) {
      const r = results[k];
      if (!r.ok || r.cands.length === 0) continue;
      bag.push(...r.cands.slice(0, PER_SOURCE_CAP));
      log.info({
        event: 'source_fetched',
        source: slice[k].name,
        candidates: r.cands.length,
        taken: Math.min(r.cands.length, PER_SOURCE_CAP),
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
  const target = Math.min(num(env.PROXY_TARGET, 5), MAX_TARGET);
  const timeoutMs = num(env.CHECK_TIMEOUT_MS, 2500);
  const bypass = env.PAC_ROUTE_BYPASS !== 'false';
  if (num(env.PROXY_TARGET, 5) > MAX_TARGET) {
    log.info({ event: 'target_capped', wanted: num(env.PROXY_TARGET, 5), cappedTo: target });
  }

  const candidates = await gatherCandidates(env, log, num(env.PROXY_CANDIDATES, 30));
  log.info({ event: 'candidates_gathered', count: candidates.length });

  // filterAlive returns survivors sorted fastest-first (each carries latencyMs).
  const alive = await filterAlive(candidates, { timeoutMs, limit: 16 });
  const chosen = alive.slice(0, target);
  log.info({
    event: 'check_complete',
    checked: candidates.length,
    alive: alive.length,
    served: chosen.length,
    fastestMs: chosen.length ? chosen[0].latencyMs : null,
    slowestMs: chosen.length ? chosen[chosen.length - 1].latencyMs : null,
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

// Live pipeline diagnostics: fetch every usable source, sample candidates,
// run real checks against a sample, and report it all as JSON. Never cached.
async function handleDebug(env) {
  const started = Date.now();
  const timeoutMs = num(env.CHECK_TIMEOUT_MS, 2500);
  const sources = enabledSources();
  const perSource = [];
  const sample = [];

  const window = 4;
  for (let i = 0; i < sources.length; i += window) {
    const slice = sources.slice(i, i + window);
    const results = await Promise.all(slice.map((s) => fetchSource(s, 3500)));
    for (const r of results) {
      perSource.push({
        name: r.source.name,
        type: r.source.type,
        protocol: r.source.protocol,
        ok: r.ok,
        error: r.error ?? null,
        bytes: r.bytes,
        candidates: r.cands.length,
      });
      sample.push(...r.cands.slice(0, 10));
    }
  }

  const candidates = dedupe(sample).slice(0, 25);
  const alive = await filterAlive(candidates, { timeoutMs, limit: 16 });

  const body = {
    ok: true,
    ms: Date.now() - started,
    sources: perSource,
    checks: { sampled: candidates.length, alive: alive.length, timeoutMs },
    alive: alive.map((a) => `${a.protocol} ${a.hostPort} (${a.latencyMs}ms)`),
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
GET /debug      -> live pipeline diagnostics (sources, candidates, check results)

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

    if (path === '/debug') return handleDebug(env);

    return new Response(HELP, {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
