// تست یونیت ip-check — با node:test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTrace,
  interpretWarp,
  buildSocks5ConnectRequest,
  buildHttpConnectRequest,
} from '../electron/ip-check.ts';

const SAMPLE_TRACE = `fl=42f1
h=www.cloudflare.com
ip=185.220.10.5
ts=1762370000.1
visit_scheme=https
uag=Mozilla/5.0
colo=THR
sliver=none
http=http/2
loc=IR
tls=TLSv1.3
sni=plaintext
warp=on
gateway=off
`;

test('parseTrace: ip و loc و warp را از trace می‌خواند', () => {
  const t = parseTrace(SAMPLE_TRACE);
  assert.equal(t.ip, '185.220.10.5');
  assert.equal(t.loc, 'IR');
  assert.equal(t.warp, 'on');
});

test('parseTrace با warp=off و فیلدهای خالی', () => {
  const t = parseTrace('ip=1.2.3.4\nloc=DE\nwarp=off\n');
  assert.equal(t.warp, 'off');
  assert.equal(parseTrace('').ip, '');
  assert.equal(parseTrace('').warp, '');
});

test('interpretWarp: IP یکسان + warp=on یعنی egress در ایران است', () => {
  const direct = parseTrace('ip=185.220.10.5\nloc=IR\nwarp=off\n');
  const via = parseTrace('ip=185.220.10.5\nloc=IR\nwarp=on\n');
  assert.equal(interpretWarp(direct, via), 'warp-on-same-ip');
});

test('interpretWarp: warp=on با IP متفاوت، warp=off یعنی نشت، بدون Aether یعنی no-aether', () => {
  const direct = parseTrace('ip=1.1.1.1\nloc=IR\nwarp=off\n');
  assert.equal(interpretWarp(direct, parseTrace('ip=2.2.2.2\nloc=DE\nwarp=on\n')), 'warp-on-different-ip');
  assert.equal(interpretWarp(direct, parseTrace('ip=1.1.1.1\nloc=IR\nwarp=off\n')), 'warp-off');
  assert.equal(interpretWarp(direct, null), 'no-aether');
  assert.equal(interpretWarp(null, parseTrace('ip=2.2.2.2\nloc=DE\nwarp=on\n')), 'warp-on-different-ip');
  assert.equal(interpretWarp(direct, parseTrace('ip=2.2.2.2\nloc=DE\n')), 'unknown');
});

test('buildSocks5ConnectRequest: بایت‌های درست SOCKS5 CONNECT', () => {
  const buf = buildSocks5ConnectRequest('www.cloudflare.com', 443);
  assert.equal(buf[0], 0x05);
  assert.equal(buf[1], 0x01);
  assert.equal(buf[3], 0x03);
  assert.equal(buf[4], 'www.cloudflare.com'.length);
  assert.equal(buf.readUInt16BE(buf.length - 2), 443);
});

test('buildHttpConnectRequest: متن درست HTTP CONNECT', () => {
  assert.equal(
    buildHttpConnectRequest('www.cloudflare.com', 443),
    'CONNECT www.cloudflare.com:443 HTTP/1.1\r\nHost: www.cloudflare.com:443\r\n\r\n',
  );
});
