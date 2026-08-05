// Local end-to-end diagnostic for the AutoProxy pipeline.
//
// Mirrors src/index.js exactly, but runs in Node with:
//   - real fetch() for source lists,
//   - a Node net.Socket shim standing in for cloudflare:sockets connect(),
// so we can see where "0 live proxy" comes from.
//
//   node scripts/local-check.mjs [maxCandidates] [timeoutMs]

import net from 'node:net';
import { Readable, Writable } from 'node:stream';
import { parseSource, dedupe, SUPPORTED_PROTOCOLS } from '../src/parsers.js';
import { filterAlive, setConnectForTesting } from '../src/checker.js';
import cfg from '../src/proxy-sources.json' with { type: 'json' };

const MAX_CANDIDATES = Number(process.argv[2] || 40);
const TIMEOUT_MS = Number(process.argv[3] || 2500);
// Must match src/index.js USABLE_SOURCE_TYPES (tor_exit excluded).
const USABLE_SOURCE_TYPES = ['github_raw', 'generic_text', 'subscription_base64'];

// ---- Node net.Socket -> cloudflare:sockets connect() shim ------------------
function connect(address) {
  const sock = net.connect({ host: address.hostname, port: address.port });
  sock.setNoDelay(true);
  return {
    readable: Readable.toWeb(sock),
    writable: Writable.toWeb(sock),
    ready: new Promise((res, rej) => {
      sock.once('connect', res);
      sock.once('error', rej);
    }),
    close: () => sock.destroy(),
    closed: new Promise((res) => sock.once('close', res)),
  };
}
setConnectForTesting(connect);

// ---- gather candidates exactly like the worker -----------------------------
const enabled = cfg.sources.filter(
  (s) =>
    s &&
    s.enabled &&
    s.url &&
    SUPPORTED_PROTOCOLS.includes(s.protocol) &&
    USABLE_SOURCE_TYPES.includes(s.type),
);
console.log(`enabled+supported sources: ${enabled.length}\n`);

async function fetchSource(source) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(source.url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'AutoProxy/1.0 (+local-check)' },
    });
    if (!res.ok) return { source, error: `HTTP ${res.status}`, cands: [] };
    const text = await res.text();
    const cands = parseSource(source, text);
    return { source, bytes: text.length, cands };
  } catch (e) {
    return { source, error: e.message || String(e), cands: [] };
  } finally {
    clearTimeout(t);
  }
}

const bag = [];
const report = [];
for (let i = 0; i < enabled.length && bag.length < MAX_CANDIDATES * 3; i++) {
  const r = await fetchSource(enabled[i]);
  report.push(r);
  bag.push(...r.cands);
  const tag = r.error
    ? `ERR  ${r.error}`
    : `ok   ${String(r.bytes).padStart(7)}B -> ${r.cands.length} cands`;
  console.log(`  [${String(r.source.id).padStart(2)}] ${r.source.name.padEnd(28)} ${tag}`);
}

const candidates = dedupe(bag).slice(0, MAX_CANDIDATES);
console.log(`\ncandidates gathered: ${bag.length} raw -> ${candidates.length} after dedupe/cap`);
if (candidates.length === 0) {
  console.log('No candidates — the pipeline stops before health checks. Check source errors above.');
  process.exit(0);
}
console.log('sample:', candidates.slice(0, 8).map((c) => `${c.protocol} ${c.hostPort}`).join(' | '));

// ---- health-check with the real checker code -------------------------------
console.log(`\nchecking ${candidates.length} candidates (timeout ${TIMEOUT_MS}ms, limit 16)...\n`);
const started = Date.now();
const alive = await filterAlive(candidates, { timeoutMs: TIMEOUT_MS, limit: 16 });
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`ALIVE: ${alive.length} / ${candidates.length}\n`);
for (const a of alive) console.log(`  ✓ ${a.protocol.padEnd(8)} ${a.hostPort.padEnd(22)} ${a.latencyMs}ms`);
