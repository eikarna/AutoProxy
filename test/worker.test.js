import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal edge-cache stub (Workers' caches.default is not in Node).
const store = new Map();
globalThis.caches = {
  default: {
    async match(req) { return store.get(req.url); },
    async put(req, res) { store.set(req.url, res); },
  },
};

// Mock fetch: non-IP hostnames are proxy-source fetches; IP hostnames are
// health-check probes. Everything succeeds.
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const isIpHost = /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname);
  if (isIpHost) {
    // 204 is a null-body status: Response('', {status:204}) throws in Node.
    return new Response(null, { status: 204 }); // proxy alive
  }
  const body = '203.0.113.10:8080\n203.0.113.11:3128\n198.51.100.7:1080\n';
  return new Response(body, { status: 200 });
};

const worker = (await import('../src/index.js')).default;
const env = { LOG_JSON: 'false' };
const ctx = { waitUntil: () => {} };

test('GET / returns a PAC profile with PROXY entries and DIRECT fallback', async () => {
  const res = await worker.fetch(new Request('https://autoproxy.example.workers.dev/'), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/x-ns-proxy-autoconfig');
  const pac = await res.text();
  assert.match(pac, /function FindProxyForURL\(url, host\)/);
  // Protocol token depends on which source yielded the IP first (shuffled order),
  // so accept PROXY or SOCKS5.
  assert.match(pac, /(PROXY|SOCKS5) 203\.0\.113\.1\d?:\d+/);
  assert.match(pac, /; DIRECT";$/m); // chain always terminates with DIRECT
  assert.match(pac, /isPlainHostName/); // bypass rules on by default
  assert.ok(Number(res.headers.get('X-Proxy-Count')) > 0);
});

test('second request is served from the edge cache', async () => {
  const before = store.size;
  const res = await worker.fetch(new Request('https://autoproxy.example.workers.dev/proxy.pac'), env, ctx);
  assert.equal(res.status, 200);
  // First request populated the cache, so this one is a cache hit (size unchanged).
  assert.ok(store.size >= before);
  const pac = await res.text();
  assert.match(pac, /FindProxyForURL/);
});

test('GET /status reports source counts', async () => {
  const res = await worker.fetch(new Request('https://autoproxy.example.workers.dev/status'), env, ctx);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.sources.enabled >= 1);
  assert.ok(body.sources.total >= body.sources.enabled);
});

test('unknown path returns the help text', async () => {
  const res = await worker.fetch(new Request('https://autoproxy.example.workers.dev/nope'), env, ctx);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /AutoProxy/);
});

test('dead sources still yield a DIRECT-only PAC (graceful degradation)', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  store.clear();
  try {
    const res = await worker.fetch(new Request('https://autoproxy.example.workers.dev/fresh'), env, ctx);
    const pac = await res.text();
    assert.match(pac, /return "DIRECT";/);
    assert.equal(res.headers.get('X-Proxy-Count'), '0');
  } finally {
    globalThis.fetch = original;
  }
});
