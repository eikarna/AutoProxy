// Parses raw source bodies into candidate proxies and extracts host:port
// addresses that can be checked and put into a PAC file.
//
// Candidate shape: { host: "1.2.3.4", port: 8080, protocol: "http", hostPort: "1.2.3.4:8080" }

const IP_PORT = /\b((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})\b/g;

// Protocols we can express in a PAC file and health-check directly.
export const SUPPORTED_PROTOCOLS = ['http', 'socks4', 'socks5', 'socks5h'];

function isPlausibleIp(octets) {
  return octets.every((o) => +o >= 0 && +o <= 255);
}

function makeCandidate(ip, port, protocol) {
  const p = +port;
  if (!ip || !(p > 0 && p <= 65535)) return null;
  // Reject quad-zero / over-long octets and out-of-range numbers.
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || !isPlausibleIp(octets)) return null;
  return { host: ip, port: p, protocol, hostPort: `${ip}:${p}` };
}

function mapProtocol(sourceProtocol, line) {
  // Scheme sniffing beats the source's declared protocol when a scheme is present,
  // because subscription lines are self-describing. Plain "ip:port" lines fall
  // back to the declared protocol.
  if (/^socks5h:\/\//i.test(line)) return 'socks5h';
  if (/^socks5:\/\//i.test(line)) return 'socks5';
  if (/^socks4:\/\//i.test(line)) return 'socks4';
  if (/^https?:\/\//i.test(line)) return 'http';
  if (sourceProtocol && SUPPORTED_PROTOCOLS.includes(sourceProtocol)) return sourceProtocol;
  return 'http';
}

// URIs like trojan://, vless://, vmess://, ss:// can't be PAC entries, so we
// skip them by design (PAC only understands PROXY/SOCKS).

// Decode a base64 subscription body: each decoded line is a scheme URI or ip:port.
function parseSubscription(text, sourceProtocol) {
  let decoded = '';
  try {
    const b64 = String(text).replace(/\s+/g, '');
    // atob is available in both Workers and Node 18+; fall back to Buffer if not.
    decoded = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return [];
  }
  return parsePlainLines(decoded.split(/\r?\n/), sourceProtocol);
}

function parseWholeBody(body, protocol) {
  const out = [];
  IP_PORT.lastIndex = 0;
  let m;
  while ((m = IP_PORT.exec(body)) !== null) {
    const cand = makeCandidate(m[1], m[2], protocol || 'http');
    if (cand) out.push(cand);
  }
  return dedupe(out);
}

function parsePlainLines(lines, sourceProtocol) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = [...line.matchAll(IP_PORT)];
    if (m.length === 0) continue; // no usable ip:port token on this line
    const proto = mapProtocol(sourceProtocol, line);
    // A line may hold several tuples ("1.2.3.4:80, 5.6.7.8:8080") — take them
    // all, sharing the line's protocol.
    for (const [, ip, port] of m) {
      const cand = makeCandidate(ip, port, proto);
      if (cand) out.push(cand);
    }
  }
  return out;
}

// Entry: parse one source body into candidate objects based on the source's type.
export function parseSource(source, body) {
  if(!body) return [];
  const protocol = SUPPORTED_PROTOCOLS.includes(source.protocol) ? source.protocol : null;
  switch (source.type) {
    case 'subscription_base64':
      return parseSubscription(body, protocol || 'http');
    case 'github_raw':
    case 'generic_text':
    case 'tor_exit': // tor exit lists are just IPs on port 443-ish; treat per source protocol
    default: {
      // Newline-separated first so scheme sniffing works per line; fall back to
      // comma/space-separated tuples when the body carries no line breaks.
      const byLine = parsePlainLines(body.split(/\r?\n/), protocol);
      if (byLine.length > 0) return dedupe(byLine);
      return parseWholeBody(body, protocol);
    }
  }
}

// Deduplicate by host:port, preserving first-seen protocol.
export function dedupe(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c || seen.has(c.hostPort)) continue;
    seen.add(c.hostPort);
    out.push(c);
  }
  return out;
}
