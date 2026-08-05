import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, dedupe } from '../src/parsers.js';

const src = (over = {}) => ({
  id: 1,
  url: 'https://example.com/x.txt',
  type: 'github_raw',
  protocol: 'http',
  enabled: true,
  name: 't',
  validated: true,
  ...over,
});

test('parses "ip:port" lines', () => {
  const out = parseSource(src(), '1.2.3.4:8080\n5.6.7.8:3128\n');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { host: '1.2.3.4', port: 8080, protocol: 'http', hostPort: '1.2.3.4:8080' });
});

test('skips blank lines and comments', () => {
  const out = parseSource(src(), '\n# comment\n1.2.3.4:80\n  \n');
  assert.equal(out.length, 1);
  assert.equal(out[0].hostPort, '1.2.3.4:80');
});

test('rejects impossible ips and ports', () => {
  const out = parseSource(src(), '300.1.1.1:80\n1.2.3.4:0\n1.2.3.4:99999\n1.2.3.4:8080');
  assert.deepEqual(out.map((c) => c.hostPort), ['1.2.3.4:8080']);
});

test('rejects private/loopback/CGNAT/multicast junk IPs', () => {
  const body = [
    '10.0.0.1:80',
    '127.0.0.1:80',
    '192.168.1.1:80',
    '172.16.5.5:80',
    '169.254.10.10:80',
    '100.64.0.1:80',
    '224.0.0.1:80',
    '0.0.0.0:80',
    '8.8.8.8:80', // only public one — survives
  ].join('\n');
  const out = parseSource(src(), body);
  assert.deepEqual(out.map((c) => c.hostPort), ['8.8.8.8:80']);
});

test('honours declared socks protocol', () => {
  const out = parseSource(src({ protocol: 'socks4' }), '1.2.3.4:1080');
  assert.equal(out[0].protocol, 'socks4');
});

test('skips HTML bodies (GitHub repo pages served as generic_text)', () => {
  const html = '<!DOCTYPE html>\n<html><body>1.2.3.4:8080</body></html>';
  assert.deepEqual(parseSource(src({ type: 'generic_text' }), html), []);
});

test('handles comma-separated lists', () => {
  const out = parseSource(src(), '1.2.3.4:80, 5.6.7.8:8080,9.10.11.12:3128');
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((c) => c.hostPort), ['1.2.3.4:80', '5.6.7.8:8080', '9.10.11.12:3128']);
});

test('handles mixed-protocol lines with schemes', () => {
  const body = 'socks5://1.2.3.4:1080\nsocks4://5.6.7.8:4145\nhttp://9.10.11.12:8080';
  const out = parseSource(src(), body);
  assert.deepEqual(
    out.map((c) => [c.protocol, c.hostPort]),
    [['socks5', '1.2.3.4:1080'], ['socks4', '5.6.7.8:4145'], ['http', '9.10.11.12:8080']],
  );
});

test('decodes base64 subscriptions', () => {
  const inner = 'socks5://1.2.3.4:1080\nhttp://5.6.7.8:8080';
  const body = Buffer.from(inner).toString('base64');
  const out = parseSource(src({ type: 'subscription_base64', protocol: 'http' }), body);
  assert.equal(out.length, 2);
  assert.equal(out[0].protocol, 'socks5'); // sniffed from scheme
  assert.equal(out[0].hostPort, '1.2.3.4:1080');
  assert.equal(out[1].protocol, 'http');
});

test('dedupe keeps first occurrence', () => {
  const a = { hostPort: '1.2.3.4:80' };
  const b = { hostPort: '1.2.3.4:80' };
  const c = { hostPort: '9.9.9.9:80' };
  assert.equal(dedupe([a, b, c]).length, 2);
});
