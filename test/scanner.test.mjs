// تست یونیت scanner — با node:test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAetherScanArgs,
  parseAetherLogLine,
  parseAetherLog,
  isProxyReadyLine,
  sampleFallbackCandidates,
  probeCandidates,
  SCANNER_BIND_PORT,
  WARP_RANGES,
} from '../electron/scanner.ts';
import { buildAetherArgs, defaultSettings } from '../electron/config-generator.ts';

test('آرگومان‌های اسکن: masque + turbo + -4 روی پورت 1820، بدون --peer', () => {
  const args = buildAetherScanArgs({ mode: 'turbo', ipVersion: '4', protocol: 'masque' }, 'balanced');
  assert.ok(args.includes('--masque'));
  assert.ok(args.includes('--scan'));
  assert.equal(args[args.indexOf('--scan') + 1], 'turbo');
  assert.ok(args.includes('-4'));
  assert.ok(!args.includes('--peer'));
  assert.ok(args.includes('--bind'));
  assert.equal(args[args.indexOf('--bind') + 1], `127.0.0.1:${SCANNER_BIND_PORT}`);
  assert.equal(SCANNER_BIND_PORT, 1820);
});

test('آرگومان‌های اسکن: masque-h2 یعنی --masque + --h2؛ wg یعنی --wg بدون --h2', () => {
  const h2 = buildAetherScanArgs({ mode: 'balanced', ipVersion: 'both', protocol: 'masque-h2' });
  assert.ok(h2.includes('--masque') && h2.includes('--h2'));
  assert.ok(!h2.includes('-4') && !h2.includes('-6'));
  const wg = buildAetherScanArgs({ mode: 'thorough', ipVersion: '6', protocol: 'wg' });
  assert.ok(wg.includes('--wg') && wg.includes('-6'));
  assert.ok(!wg.includes('--h2'));
  const gool = buildAetherScanArgs({ mode: 'stealth', ipVersion: 'both', protocol: 'gool' });
  assert.ok(gool.includes('--gool'));
});

test('parse لاگ: اندپوینت انتخاب‌شده با latency', () => {
  const c = parseAetherLogLine('selected endpoint 162.159.192.1:443 latency 42ms');
  assert.ok(c);
  assert.equal(c.endpoint, '162.159.192.1:443');
  assert.equal(c.status, 'ok');
  assert.equal(c.latencyMs, 42);
  assert.equal(c.selected, true);
});

test('parse لاگ: failed و cooldown و data-plane', () => {
  assert.equal(parseAetherLogLine('candidate 188.114.96.1:4500 handshake failed')?.status, 'failed');
  assert.equal(parseAetherLogLine('endpoint 162.159.193.5:443 on cooldown, skipping')?.status, 'cooldown');
  const ok = parseAetherLogLine('endpoint 162.159.204.1:443 data-plane verified 87ms');
  assert.equal(ok?.status, 'ok');
  assert.equal(ok?.latencyMs, 87);
  assert.equal(parseAetherLogLine('some unrelated log line without ip'), null);
  assert.equal(parseAetherLogLine('scanning ranges, please wait...'), null);
});

test('parseAetherLog: ادغام چند خط، ok بر failed غلبه می‌کند، selected پیدا می‌شود', () => {
  const { candidates, selected } = parseAetherLog([
    'candidate 162.159.192.1:443 handshake failed',
    'candidate 162.159.192.1:443 data-plane verified 55ms',
    'candidate 188.114.96.1:443 handshake failed',
    'selected endpoint 162.159.192.1:443 latency 55ms',
  ]);
  assert.equal(selected, '162.159.192.1:443');
  assert.equal(candidates[0].endpoint, '162.159.192.1:443');
  assert.equal(candidates[0].status, 'ok');
  assert.equal(candidates.find((c) => c.endpoint === '188.114.96.1:443')?.status, 'failed');
});

test('isProxyReadyLine: خط آماده‌شدن پروکسی را می‌شناسد', () => {
  assert.equal(isProxyReadyLine('SOCKS5 proxy listening on 127.0.0.1:1820'), true);
  assert.equal(isProxyReadyLine('proxy ready'), true);
  assert.equal(isProxyReadyLine('scanning candidate 1.2.3.4:443'), false);
});

test('fallback sampling: کاندیدها داخل رنج‌های مستند WARP و پورت‌های معتبرند', () => {
  const samples = sampleFallbackCandidates('masque', 24);
  assert.equal(samples.length, 24);
  assert.ok(samples.every((c) => c.source === 'fallback-probe'));
  const inRange = (ip) => WARP_RANGES.some((r) => {
    const [base] = r.split('/');
    const prefix = base.split('.').slice(0, 3).join('.');
    return ip.startsWith(prefix + '.');
  });
  assert.ok(samples.every((c) => inRange(c.ip)), 'همه IPها باید داخل رنج‌های WARP باشند');
  assert.ok(samples.every((c) => [443, 500, 1701, 4500, 4443, 8443, 8095].includes(c.port)));
  assert.equal(new Set(samples.map((c) => c.endpoint)).size, 24, 'بدون تکرار');
});

test('probeCandidates روی localhost: پورت بسته failed می‌شود (بدون هنگ)', async () => {
  const results = await probeCandidates(
    [{ endpoint: '127.0.0.1:1', ip: '127.0.0.1', port: 1, status: 'testing', source: 'fallback-probe' }],
    { timeoutMs: 500, concurrency: 2 },
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'failed');
});

test('buildAetherArgs: peer و quick-reconnect و -4', () => {
  const s = { ...defaultSettings(), aetherPeer: '162.159.192.1:443', aetherQuickReconnect: true, aetherIpVersion: '4' };
  const args = buildAetherArgs(s);
  assert.ok(args.includes('--peer'));
  assert.equal(args[args.indexOf('--peer') + 1], '162.159.192.1:443');
  assert.ok(args.includes('--quick-reconnect'));
  assert.ok(args.includes('-4'));
  const plain = buildAetherArgs(defaultSettings());
  assert.ok(!plain.includes('--peer') && !plain.includes('--quick-reconnect') && !plain.includes('-4') && !plain.includes('-6'));
});
