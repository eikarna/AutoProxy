import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPac, buildReturnString, toPacEntry } from '../src/pac-template.js';

test('toPacEntry maps protocols to PAC tokens', () => {
  assert.equal(toPacEntry('http', '1.2.3.4:80'), 'PROXY 1.2.3.4:80');
  assert.equal(toPacEntry('socks4', '1.2.3.4:1080'), 'SOCKS4 1.2.3.4:1080');
  assert.equal(toPacEntry('socks5', '1.2.3.4:1080'), 'SOCKS5 1.2.3.4:1080');
  assert.equal(toPacEntry('socks5h', '1.2.3.4:1080'), 'SOCKS5 1.2.3.4:1080');
});

test('buildReturnString always ends with DIRECT', () => {
  const chain = buildReturnString([
    { protocol: 'http', hostPort: '1.2.3.4:80' },
    { protocol: 'socks5', hostPort: '5.6.7.8:1080' },
  ]);
  assert.equal(chain, 'PROXY 1.2.3.4:80; SOCKS5 5.6.7.8:1080; DIRECT');
});

test('buildPac with no proxies still directs', () => {
  const pac = buildPac([]);
  assert.match(pac, /return "DIRECT";/);
});

test('buildPac includes bypass rules by default', () => {
  const pac = buildPac([{ protocol: 'http', hostPort: '1.2.3.4:80' }]);
  assert.match(pac, /isPlainHostName/);
  assert.match(pac, /PROXY 1\.2\.3\.4:80; DIRECT/);
});

test('buildPac can disable bypass', () => {
  const pac = buildPac([{ protocol: 'http', hostPort: '1.2.3.4:80' }], { bypass: false });
  assert.doesNotMatch(pac, /isPlainHostName/);
});
