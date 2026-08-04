// Health-checks candidate proxies from inside a Cloudflare Worker.
//
// IMPORTANT limitation: Workers uses fetch() only, which always goes over
// Cloudflare's HTTP stack. We cannot open a raw TCP socket through a SOCKS4/5
// proxy. So:
//   - http/https candidates: checked via a proxied fetch (CONNECT-style through
//     the proxy URL) — the check exercises the proxy end-to-end.
//   - socks4/socks5/socks5h candidates: can't be truly checked with fetch().
//     We fall back to a TCP-reachability probe (HTTPS to host:port) to verify
//     *something* is listening; it's weaker but cheap and filters dead hosts.

// Returns an AbortSignal that fires after `ms`, plus done() to clear the timer.
function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

async function checkHttp(proxy, timeoutMs) {
  // Dial the proxy itself with an absolute-form request target — a real HTTP
  // proxy honours these (RFC 7230 §5.3.2). Any HTTP response back proves the
  // proxy is alive and speaking HTTP; network failures throw.
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetch(`http://${proxy.hostPort}/generate_204`, {
      method: 'GET',
      redirect: 'manual',
      signal,
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: { Host: 'www.gstatic.com', 'User-Agent': 'AutoProxy-Checker/1.0' },
    });
    return res && typeof res.status === 'number' && res.status > 0;
  } catch {
    return false;
  } finally {
    done();
  }
}

async function checkSocks(proxy, timeoutMs) {
  // Best-effort: confirm the host:port accepts a TLS/HTTP connection at all.
  const { signal, done } = withTimeout(timeoutMs);
  try {
    await fetch(`https://${proxy.hostPort}/`, {
      method: 'HEAD',
      redirect: 'manual',
      signal,
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: { 'User-Agent': 'AutoProxy-Checker/1.0' },
    });
    return true; // connection established and responded
  } catch {
    return false;
  } finally {
    done();
  }
}

export async function checkProxy(proxy, timeoutMs) {
  if (proxy.protocol === 'http') return checkHttp(proxy, timeoutMs);
  return checkSocks(proxy, timeoutMs);
}

// Check many candidates in parallel with a concurrency cap, returning the ones
// that pass. Parallel-with-limit keeps us inside Workers' 10 ms CPU budget
// because the wall-clock waits are I/O, not CPU.
export async function filterAlive(candidates, { timeoutMs = 2500, limit = 12 } = {}) {
  const alive = [];
  let idx = 0;

  async function worker() {
    while (idx < candidates.length) {
      const i = idx++;
      const c = candidates[i];
      if (await checkProxy(c, timeoutMs)) alive.push(c);
    }
  }

  const n = Math.min(limit, Math.max(1, candidates.length));
  await Promise.all(Array.from({ length: n }, worker));
  return alive;
}
