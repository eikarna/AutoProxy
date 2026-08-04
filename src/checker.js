// Health-checks candidate proxies from inside a Cloudflare Worker.
//
// Workers' fetch() cannot route through arbitrary proxies, so we open raw TCP
// connections with `cloudflare:sockets` and speak each proxy protocol natively:
//
//   - http       -> absolute-form request through the proxy (RFC 7230 #5.3.2)
//   - socks5(h)  -> SOCKS5 greeting + CONNECT, then HTTP through the tunnel
//   - socks4     -> SOCKS4 CONNECT, then HTTP through the tunnel
//
// Every check fetches http://www.gstatic.com/generate_204 *through the proxy*
// and requires a real 2xx/3xx response back — proving the proxy actually
// forwards traffic, not merely that its port is open. Each result carries the
// measured latency so the PAC can list the fastest proxies first.

const PROBE_HOST = 'www.gstatic.com';
const PROBE_PORT = 80;

const enc = (s) => new TextEncoder().encode(s);
const dec = new TextDecoder();
const U8 = (arr) => Uint8Array.from(arr);

// ---- socket plumbing --------------------------------------------------------

let connectImpl = null;
async function getConnect() {
  if (!connectImpl) ({ connect: connectImpl } = await import('./tcp.js'));
  return connectImpl;
}
// Tests inject a fake socket factory so Node can run without workerd.
export function setConnectForTesting(fn) {
  connectImpl = fn;
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function indexOfBytes(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// Buffered reader over a socket's ReadableStream.
class StreamReader {
  constructor(readable) {
    this.reader = readable.getReader();
    this.buf = new Uint8Array(0);
  }
  async fill() {
    const { done, value } = await this.reader.read();
    if (done) throw new Error('connection closed early');
    this.buf = concatBytes(this.buf, value);
  }
  async readN(n) {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async readHead(maxBytes = 8192) {
    const sep = [13, 10, 13, 10]; // \r\n\r\n
    for (;;) {
      const idx = indexOfBytes(this.buf, sep);
      if (idx >= 0) return dec.decode(this.buf.subarray(0, idx + sep.length));
      if (this.buf.length > maxBytes) throw new Error('headers too large');
      await this.fill();
    }
  }
}

// Open a raw TCP connection and run `session(reader, writer)` against a
// hard timeout. Returns { ok, latencyMs }.
async function tcpExchange(host, port, timeoutMs, session) {
  const startedAt = Date.now();
  const connect = await getConnect();
  let socket;
  try {
    socket = connect({ hostname: host, port: Number(port) }, { secureTransport: 'none' });
  } catch {
    return { ok: false, latencyMs: Date.now() - startedAt };
  }

  const sr = new StreamReader(socket.readable);
  const writer = socket.writable.getWriter();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('check timeout')), timeoutMs);
  });

  try {
    const ok = await Promise.race([session(sr, writer), timeout]);
    return { ok: ok === true, latencyMs: Date.now() - startedAt };
  } catch {
    return { ok: false, latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
}

// ---- protocol sessions ------------------------------------------------------

const ABSOLUTE_FORM_REQUEST =
  `GET http://${PROBE_HOST}/generate_204 HTTP/1.1\r\n` +
  `Host: ${PROBE_HOST}\r\n` +
  `User-Agent: AutoProxy-Checker/1.0\r\n` +
  `Connection: close\r\n\r\n`;

const ORIGIN_FORM_REQUEST =
  `GET /generate_204 HTTP/1.1\r\n` +
  `Host: ${PROBE_HOST}\r\n` +
  `User-Agent: AutoProxy-Checker/1.0\r\n` +
  `Connection: close\r\n\r\n`;

function statusOk(head) {
  const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(head);
  if (!m) return false;
  const code = Number(m[1]);
  return code >= 200 && code < 400;
}

// Through an established tunnel, request the probe page and verify the answer.
async function expectProbe(sr, writer) {
  await writer.write(enc(ORIGIN_FORM_REQUEST));
  const head = await sr.readHead();
  return statusOk(head);
}

// HTTP forward proxy: absolute-form request line goes straight to the proxy.
async function httpSession(sr, writer) {
  await writer.write(enc(ABSOLUTE_FORM_REQUEST));
  const head = await sr.readHead();
  return statusOk(head);
}

// SOCKS5: no-auth greeting, CONNECT by domain name, then plain HTTP.
async function socks5Session(sr, writer) {
  await writer.write(U8([0x05, 0x01, 0x00]));
  const greet = await sr.readN(2);
  if (greet[0] !== 0x05 || greet[1] !== 0x00) return false; // no acceptable auth method

  const dom = enc(PROBE_HOST);
  await writer.write(U8([0x05, 0x01, 0x00, 0x03, dom.length, ...dom, PROBE_PORT >>> 8, PROBE_PORT & 0xff]));
  const resp = await sr.readN(4);
  if (resp[0] !== 0x05 || resp[1] !== 0x00) return false; // CONNECT refused

  // Consume the bound address so the stream is aligned for the tunneled HTTP.
  const atyp = resp[3];
  if (atyp === 0x01) await sr.readN(6);
  else if (atyp === 0x04) await sr.readN(18);
  else if (atyp === 0x03) {
    const [len] = await sr.readN(1);
    await sr.readN(len + 2);
  } else return false;

  return expectProbe(sr, writer);
}

// SOCKS4: fixed 9-byte CONNECT request with the destination IP.
async function socks4Session(sr, writer, ip) {
  const o = ip.split('.').map(Number);
  await writer.write(U8([0x04, 0x01, PROBE_PORT >>> 8, PROBE_PORT & 0xff, o[0], o[1], o[2], o[3], 0x00]));
  const resp = await sr.readN(8);
  if (resp[1] !== 0x5a) return false; // 0x5A = request granted
  return expectProbe(sr, writer);
}

// ---- public API -------------------------------------------------------------

export async function checkProxy(proxy, timeoutMs) {
  const { host, port, protocol } = proxy;
  if (protocol === 'http') return tcpExchange(host, port, timeoutMs, httpSession);
  if (protocol === 'socks5' || protocol === 'socks5h') {
    return tcpExchange(host, port, timeoutMs, socks5Session);
  }
  if (protocol === 'socks4') {
    return tcpExchange(host, port, timeoutMs, (sr, w) => socks4Session(sr, w, host));
  }
  return { ok: false, latencyMs: 0 };
}

// Check candidates with a concurrency cap. Returns the survivors — each
// annotated with latencyMs and sorted fastest-first — so the PAC chain lists
// the snappiest proxies up front.
export async function filterAlive(candidates, { timeoutMs = 2500, limit = 12 } = {}) {
  const alive = [];
  let idx = 0;

  async function worker() {
    while (idx < candidates.length) {
      const c = candidates[idx++];
      const r = await checkProxy(c, timeoutMs);
      if (r.ok) alive.push({ ...c, latencyMs: r.latencyMs });
    }
  }

  const n = Math.min(limit, Math.max(1, candidates.length));
  await Promise.all(Array.from({ length: n }, worker));
  alive.sort((a, b) => a.latencyMs - b.latencyMs);
  return alive;
}
