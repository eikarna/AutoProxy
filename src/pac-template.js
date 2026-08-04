// Builds the PAC (Proxy Auto-Config) file served to visitors.
// PAC spec: https://developer.mozilla.org/en-US/docs/Web/HTTP/Proxy_servers_and_tunneling/Proxy_Auto-Configuration_PAC_file

const PAC_ENTRY = {
  http:   (hp) => `PROXY ${hp}`,
  socks4: (hp) => `SOCKS4 ${hp}`,
  socks5: (hp) => `SOCKS5 ${hp}`,
  socks5h: (hp) => `SOCKS5 ${hp}`,
};

export function toPacEntry(protocol, hostPort) {
  const fn = PAC_ENTRY[protocol];
  return fn ? fn(hostPort) : null;
}

// Build the fallback chain inside the PAC return string.
// PAC fails over left-to-right: if the first proxy is dead the client
// silently moves to the next one within the same string.
export function buildReturnString(live) {
  const entries = live.map((p) => toPacEntry(p.protocol, p.hostPort)).filter(Boolean);
  // Always terminate with DIRECT so traffic never hangs when every proxy is dead.
  entries.push('DIRECT');
  return entries.join('; ');
}

// Full PAC script. `bypass` toggles the DIRECT rules for local/private traffic.
export function buildPac(live, { bypass = true } = {}) {
  const chain = buildReturnString(live);
  const generated = new Date().toISOString();
  const count = live.length;

  const bypassRules = bypass
    ? `
  // Direct for plain hostnames, localhost, and private IPs
  if (isPlainHostName(host) ||
      shExpMatch(host, "localhost*") ||
      shExpMatch(host, "*.local") ||
      isInNet(host, "10.0.0.0", "255.0.0.0") ||
      isInNet(host, "172.16.0.0", "255.240.0.0") ||
      isInNet(host, "192.168.0.0", "255.255.0.0") ||
      isInNet(host, "127.0.0.0", "255.0.0.0")) {
    return "DIRECT";
  }
`
    : '';

  return `// AutoProxy — generated ${generated} — ${count} live proxy(ies)
function FindProxyForURL(url, host) {
${bypassRules}
  return "${chain}";
}
`;
}
