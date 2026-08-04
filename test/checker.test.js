import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProxy, filterAlive, setConnectForTesting } from '../src/checker.js';
import {
  fakeSocket,
  protocolProxy,
  HTTP_OK_HEAD,
  HTTP_400_HEAD,
  SOCKS5_GREET_NO_METHOD,
  SOCKS5_CONN_REFUSED,
  SOCKS4_REJECT,
  enc,
} from './helpers.js';

const httpProxy = { host: '198.51.100.9', port: 8080, protocol: 'http', hostPort: '198.51.100.9:8080' };
const socksProxy = { host: '198.51.100.10', port: 1080, protocol: 'socks5', hostPort: '198.51.100.10:1080' };
const socks4Proxy = { host: '198.51.100.11', port: 4145, protocol: 'socks4', hostPort: '198.51.100.11:4145' };

test('HTTP proxy that forwards the probe is alive', async () => {
  setConnectForTesting(() => protocolProxy(HTTP_OK_HEAD));
  const r = await checkProxy(httpProxy, 1000);
  assert.equal(r.ok, true);
  assert.ok(r.latencyMs >= 0);
});

test('HTTP proxy that answers 400 (not forwarding) is dead', async () => {
  setConnectForTesting(() => protocolProxy(HTTP_400_HEAD));
  const r = await checkProxy(httpProxy, 1000);
  assert.equal(r.ok, false);
});

test('connection refused is dead', async () => {
  setConnectForTesting(() => {
    throw new Error('connect refused');
  });
  const r = await checkProxy(httpProxy, 1000);
  assert.equal(r.ok, false);
});

test('unresponsive proxy times out as dead', async () => {
  // Socket opens but never sends anything back.
  setConnectForTesting(() => fakeSocket(async () => {}));
  const r = await checkProxy(httpProxy, 120);
  assert.equal(r.ok, false);
});

test('SOCKS5 proxy that completes handshake + probe is alive', async () => {
  setConnectForTesting(() => protocolProxy(HTTP_OK_HEAD));
  const r = await checkProxy(socksProxy, 1000);
  assert.equal(r.ok, true);
});

test('SOCKS5 with no acceptable auth method is dead', async () => {
  setConnectForTesting(() =>
    fakeSocket(async (chunk, push, writes) => {
      if (writes.length === 1) push(SOCKS5_GREET_NO_METHOD);
    }),
  );
  const r = await checkProxy(socksProxy, 1000);
  assert.equal(r.ok, false);
});

test('SOCKS5 CONNECT refused is dead', async () => {
  setConnectForTesting(() =>
    fakeSocket(async (chunk, push, writes) => {
      if (writes.length === 1) push([0x05, 0x00]);
      else if (writes.length === 2) push(SOCKS5_CONN_REFUSED);
    }),
  );
  const r = await checkProxy(socksProxy, 1000);
  assert.equal(r.ok, false);
});

test('SOCKS4 granted + probe is alive', async () => {
  setConnectForTesting(() => protocolProxy(HTTP_OK_HEAD));
  const r = await checkProxy(socks4Proxy, 1000);
  assert.equal(r.ok, true);
});

test('SOCKS4 rejected is dead', async () => {
  setConnectForTesting(() =>
    fakeSocket(async (chunk, push, writes) => {
      if (writes.length === 1) push(SOCKS4_REJECT);
    }),
  );
  const r = await checkProxy(socks4Proxy, 1000);
  assert.equal(r.ok, false);
});

test('filterAlive returns only survivors, fastest first', async () => {
  // Slow proxy delays its probe response; fast proxy answers immediately.
  const slow = { host: '203.0.113.60', port: 80, protocol: 'http', hostPort: '203.0.113.60:80' };
  const fast = { host: '203.0.113.61', port: 80, protocol: 'http', hostPort: '203.0.113.61:80' };
  const dead = { host: '203.0.113.62', port: 80, protocol: 'http', hostPort: '203.0.113.62:80' };

  setConnectForTesting((addr) => {
    if (addr.hostname === slow.host) {
      return fakeSocket(async (chunk, push) => {
        await new Promise((r) => setTimeout(r, 80));
        push(enc(HTTP_OK_HEAD), true);
      });
    }
    if (addr.hostname === dead.host) throw new Error('refused');
    return protocolProxy(HTTP_OK_HEAD); // fast
  });

  const alive = await filterAlive([slow, fast, dead], { timeoutMs: 1000, limit: 3 });
  assert.equal(alive.length, 2);
  assert.deepEqual(
    alive.map((c) => c.host),
    [fast.host, slow.host],
  );
});
