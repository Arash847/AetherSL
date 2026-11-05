// تست یونیت config-generator + rules — با node:test
// اجرا: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildXrayConfig,
  buildXrayConfigFromGroups,
  buildZeptunConfig,
  buildAetherArgs,
  defaultSettings,
  expandRuleGroups,
  hasFrag,
  hasFragGroups,
  ruleModeToTarget,
  XRAY_INBOUND_PORT,
  AETHER_SOCKS_PORT,
} from '../electron/config-generator.ts';
import { parseRuleFile, parseRuleFileText, serializeRuleFile, toggleGroupMode } from '../electron/rules.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseJsonc(path) {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'));
}
const baseB = parseJsonc(join(root, 'configs', 'serverless-fragB.base.jsonc'));
const baseA = parseJsonc(join(root, 'configs', 'serverless-fragA.base.jsonc'));
const baseOob = parseJsonc(join(root, 'configs', 'serverless-oob.base.jsonc'));
const userFile = parseRuleFileText(readFileSync(join(root, 'configs', 'rules.user.json'), 'utf-8'));

const rulesOf = (cfg) => cfg.routing?.rules ?? [];
const findRule = (cfg, pred) => rulesOf(cfg).find(pred);
const tcpCatchAll = (cfg) =>
  [...rulesOf(cfg)].reverse().find((r) => r.network === 'tcp' && Array.isArray(r.ip) && r.ip.includes('0.0.0.0/0') && !r.domain && !r.port && !r.protocol);
const noFilterRule = (cfg) =>
  rulesOf(cfg).find((r) => Array.isArray(r.inboundTag) && r.inboundTag.includes('no-filter-dns'));

test('base پیش‌فرض fragB است (v58) و outboundهای لازم را دارد', () => {
  assert.equal(defaultSettings().serverlessProfile, 'fragB');
  assert.equal(baseB.remarks, 'Serverless-v58-fragB');
  const tags = baseB.outbounds.map((o) => o.tag);
  for (const t of ['block', 'tcp-direct', 'udp-direct', 'dns-out', 'tcp-fragment', 'tcp-fragment-tls', 'tls-repack-dns', 'udp-noises']) {
    assert.ok(tags.includes(t), `outbound ${t} نیست`);
  }
  assert.equal(rulesOf(baseB).length, 17);
});

test('fragA و fragB فقط در remarks و دو خط fragment lengths فرق دارند', () => {
  const fragLengths = (base, tag) => {
    const ob = base.outbounds.find((o) => o.tag === tag);
    const frags = ob.streamSettings.finalmask.tcp.filter((f) => f.type === 'fragment' && f.settings.packets === 'tlshello');
    return frags.map((f) => f.settings.lengths);
  };
  assert.deepEqual(fragLengths(baseA, 'tcp-fragment-tls'), [['6', '99', '1']]);
  assert.deepEqual(fragLengths(baseB, 'tcp-fragment-tls'), [['0', '105', '1']]);
  assert.deepEqual(fragLengths(baseA, 'tls-repack-dns'), [['6', '99', '1']]);
  assert.deepEqual(fragLengths(baseB, 'tls-repack-dns'), [['0', '105', '1']]);
  // کل فایل‌ها جز remarks و همین lengths یکی هستند (JSON.stringify بدون فاصله می‌سازد)
  const norm = (b) => JSON.parse(JSON.stringify(b).replaceAll('"6","99","1"', '"0","105","1"').replace(/Serverless-v58-frag[AB]/g, 'Serverless-v58-fragX'));
  assert.deepEqual(norm(baseA), norm(baseB));
  assert.ok(baseOob.outbounds.some((o) => o.tag === 'tcp-oob'), 'oob باید outbound اضافه tcp-oob داشته باشد');
});

test('فایل رول کاربر: ۴ گروه با mode و دامنه‌های دقیق', () => {
  assert.equal(userFile.formatVersion, 1);
  assert.deepEqual(userFile.rules.map((g) => g.name), ['Discord', 'Telegram', 'Youtube', 'Downloads']);
  assert.deepEqual(userFile.rules.map((g) => g.mode), ['frag', 'tunnel', 'tunnel', 'frag']);
  assert.deepEqual(userFile.rules.map((g) => g.domains.length), [10, 14, 9, 2]);
  assert.ok(userFile.rules.every((g) => g.transport === 'both' && g.enabled));
  // round-trip
  assert.deepEqual(parseRuleFile(JSON.parse(serializeRuleFile(userFile))), userFile);
});

test('noteهای اصلاح‌شده: تلگرام فیلتر ISP است نه بلاک IP ایرانی؛ دیسکورد DNS hijacking', () => {
  const byName = Object.fromEntries(userFile.rules.map((g) => [g.name, g]));
  assert.match(byName.Telegram.note, /ISP/);
  assert.match(byName.Telegram.note, /no problem with an Iranian IP/);
  assert.doesNotMatch(byName.Telegram.note, /refuses/);
  assert.match(byName.Discord.note, /DNS hijacking/);
  assert.match(byName.Discord.note, /no-filter-dns/);
});

test('inbound همیشه mixed روی 127.0.0.1:10808 است و sniffing upstream حفظ می‌شود', () => {
  const cfg = buildXrayConfig(baseB, [], defaultSettings());
  const inbound = cfg.inbounds.find((i) => i.protocol === 'mixed');
  assert.equal(inbound.port, 10808);
  assert.equal(inbound.port, XRAY_INBOUND_PORT);
  assert.equal(inbound.listen, '127.0.0.1');
  assert.equal(inbound.settings.ip, '127.0.0.1');
  assert.ok(inbound.sniffing.destOverride.includes('fakedns'), 'destOverride باید fakedns را حفظ کند');
});

test('aether-out همیشه به 127.0.0.1:1819 اشاره می‌کند', () => {
  const cfg = buildXrayConfig(baseB, [], defaultSettings());
  const out = cfg.outbounds.find((o) => o.tag === 'aether-out');
  assert.ok(out, 'aether-out باید وجود داشته باشد');
  assert.equal(out.protocol, 'socks');
  assert.deepEqual(out.settings.servers, [{ address: '127.0.0.1', port: 1819, version: 5 }]);
  assert.equal(out.settings.servers[0].port, AETHER_SOCKS_PORT);
});

test('گروه‌ها: frag → serverless ، tunnel → aether؛ transport both = دو رول tcp+udp', () => {
  assert.equal(ruleModeToTarget('frag'), 'serverless');
  assert.equal(ruleModeToTarget('tunnel'), 'aether');
  const cfg = buildXrayConfigFromGroups(baseB, userFile.rules, defaultSettings());
  const discordTcp = findRule(cfg, (r) => r.domain?.includes('domain:discord.com') && r.network === 'tcp');
  const discordUdp = findRule(cfg, (r) => r.domain?.includes('domain:discord.com') && r.network === 'udp');
  assert.equal(discordTcp?.outboundTag, 'tcp-fragment-tls');
  assert.equal(discordUdp?.outboundTag, 'udp-noises');
  const tgTcp = findRule(cfg, (r) => r.domain?.includes('domain:telegram.org') && r.network === 'tcp');
  const tgUdp = findRule(cfg, (r) => r.domain?.includes('domain:telegram.org') && r.network === 'udp');
  assert.equal(tgTcp?.outboundTag, 'aether-out');
  assert.equal(tgUdp?.outboundTag, 'aether-out');
  const yt = findRule(cfg, (r) => r.domain?.includes('domain:googlevideo.com') && r.network === 'tcp');
  assert.equal(yt?.outboundTag, 'aether-out');
});

test('ترتیب گروه‌ها حفظ می‌شود و رول کاربر بعد از بلاک تبلیغات و قبل از direct داخلی می‌آید', () => {
  const cfg = buildXrayConfigFromGroups(baseB, userFile.rules, defaultSettings());
  const rs = rulesOf(cfg);
  const adsIdx = rs.findIndex((r) => r.domain?.includes('geosite:category-ads-all'));
  const discordIdx = rs.findIndex((r) => r.domain?.includes('domain:discord.com'));
  const tgIdx = rs.findIndex((r) => r.domain?.includes('domain:telegram.org'));
  const directIdx = rs.findIndex((r) => r.domain?.includes('domain:ir') && r.outboundTag === 'tcp-direct');
  assert.ok(adsIdx === 0 && adsIdx < discordIdx && discordIdx < tgIdx && tgIdx < directIdx);
  // گروه غیرفعال نادیده گرفته می‌شود
  const off = userFile.rules.map((g) => (g.name === 'Discord' ? { ...g, enabled: false } : g));
  const cfg2 = buildXrayConfigFromGroups(baseB, off, defaultSettings());
  assert.equal(findRule(cfg2, (r) => r.domain?.includes('domain:discord.com')), undefined);
});

test('no-filter-dns: با hasFrag=true به tcp-fragment-tls می‌رود، بدون frag حذف می‌شود', () => {
  const cfgFrag = buildXrayConfigFromGroups(baseB, userFile.rules, defaultSettings());
  assert.ok(hasFragGroups(userFile.rules));
  assert.equal(noFilterRule(cfgFrag)?.outboundTag, 'tcp-fragment-tls');

  const allTunnel = userFile.rules.map((g) => ({ ...g, mode: 'tunnel' }));
  assert.equal(hasFragGroups(allTunnel), false);
  const cfgNoFrag = buildXrayConfigFromGroups(baseB, allTunnel, defaultSettings());
  assert.equal(noFilterRule(cfgNoFrag), undefined);

  const none = buildXrayConfig(baseB, [], defaultSettings());
  assert.equal(hasFrag([]), false);
  assert.equal(noFilterRule(none), undefined);
});

test('تغییر mode دیسکورد با یک کلیک (frag → tunnel) رول‌هایش را به aether-out می‌برد', () => {
  const discord = userFile.rules.find((g) => g.name === 'Discord');
  const toggled = userFile.rules.map((g) => (g.name === 'Discord' ? toggleGroupMode(g) : g));
  assert.equal(toggled.find((g) => g.name === 'Discord').mode, 'tunnel');
  const cfg = buildXrayConfigFromGroups(baseB, toggled, defaultSettings());
  assert.equal(findRule(cfg, (r) => r.domain?.includes('domain:discord.com') && r.network === 'tcp')?.outboundTag, 'aether-out');
  // Downloads هنوز frag است، پس hasFrag و no-filter-dns سر جایشان هستند
  assert.equal(hasFragGroups(toggled), true);
  assert.equal(noFilterRule(cfg)?.outboundTag, 'tcp-fragment-tls');
  assert.equal(discord.mode, 'frag', 'toggle نباید آبجکت اصلی را تغییر دهد');
});

test('پیش‌فرض serverless → catch-all روی tcp-fragment-tls؛ حالت aether-only → aether-out', () => {
  const cfg = buildXrayConfig(baseB, [], { ...defaultSettings(), defaultTarget: 'serverless', mode: 'hybrid' });
  assert.equal(tcpCatchAll(cfg)?.outboundTag, 'tcp-fragment-tls');
  const cfgA = buildXrayConfig(baseB, [], { ...defaultSettings(), mode: 'aether-only', defaultTarget: 'serverless' });
  assert.equal(tcpCatchAll(cfgA)?.outboundTag, 'aether-out');
  // در aether-only رول‌های TLS/443 هم به aether-out می‌روند
  const tlsRule = findRule(cfgA, (r) => r.network === 'tcp' && Array.isArray(r.protocol) && r.protocol.includes('tls'));
  assert.equal(tlsRule?.outboundTag, 'aether-out');
  assert.ok(cfgA.outbounds.some((o) => o.tag === 'aether-out'));
  assert.ok(cfgA.inbounds.some((i) => i.port === 10808));
});

test('رول تکی: CIDR به block و پورت 443 به serverless', () => {
  const cfg = buildXrayConfig(baseB, [
    { id: '2', enabled: true, name: 'بلاک رنج', matchType: 'cidr', match: '10.0.0.0/8', target: 'block', priority: 5 },
    { id: 'p', enabled: true, name: 'پورت 443', matchType: 'port', match: '443', target: 'serverless', priority: 10 },
  ], defaultSettings());
  assert.equal(findRule(cfg, (r) => r.ip?.includes('10.0.0.0/8'))?.outboundTag, 'block');
  assert.equal(findRule(cfg, (r) => r.port === '443')?.outboundTag, 'tcp-fragment-tls');
});

test('پروفایل oob: ترافیک TCP گروه‌های frag به tcp-oob می‌رود', () => {
  const cfg = buildXrayConfigFromGroups(baseOob, userFile.rules, { ...defaultSettings(), serverlessProfile: 'oob' });
  assert.equal(findRule(cfg, (r) => r.domain?.includes('domain:discord.com') && r.network === 'tcp')?.outboundTag, 'tcp-oob');
  assert.equal(findRule(cfg, (r) => r.domain?.includes('domain:discord.com') && r.network === 'udp')?.outboundTag, 'udp-noises');
  assert.equal(tcpCatchAll(cfg)?.outboundTag, 'tcp-oob');
});

test('base ساده قدیمی (بدون رول) هنوز مسیر legacy را می‌سازد', () => {
  const legacyBase = { inbounds: [], outbounds: [{ tag: 'block', protocol: 'blackhole' }], routing: { rules: [] } };
  const cfg = buildXrayConfig(legacyBase, expandRuleGroups(userFile.rules), defaultSettings());
  assert.equal(findRule(cfg, (r) => r.domain?.includes('domain:discord.com') && r.network === 'tcp')?.outboundTag, 'tcp-fragment-tls');
  assert.equal(tcpCatchAll(cfg), undefined); // در legacy catch-all بدون ip است
  const lastTcp = [...rulesOf(cfg)].reverse().find((r) => r.network === 'tcp' && !r.domain && !r.ip && !r.port);
  assert.equal(lastTcp?.outboundTag, 'tcp-fragment-tls');
});

test('Zeptun: TUN به 127.0.0.1:10808 وصل می‌شود و IPهای WARP مستثنا هستند', () => {
  const toml = buildZeptunConfig(defaultSettings());
  assert.match(toml, /server = "127\.0\.0\.1:10808"/);
  assert.match(toml, /162\.159\.192\.0\/24/);
  assert.match(toml, /188\.114\.96\.0\/24/);
  assert.match(toml, /auto_route = true/);
});

test('آرگومان‌های Aether شامل bind به 1819 است', () => {
  const args = buildAetherArgs({ ...defaultSettings(), aetherProtocol: 'masque', aetherScan: 'balanced' });
  assert.ok(args.includes('--masque'));
  assert.ok(args.includes('--bind'));
  assert.equal(args[args.indexOf('--bind') + 1], '127.0.0.1:1819');
});

test('parseRuleFile ورودی نامعتبر را رد می‌کند', () => {
  assert.throws(() => parseRuleFile({ formatVersion: 2, rules: [] }), /formatVersion/);
  assert.throws(() => parseRuleFile({ formatVersion: 1, rules: [{ name: 'X', mode: 'bogus', transport: 'both', enabled: true, domains: ['a.com'] }] }), /mode/);
  assert.throws(() => parseRuleFile({ formatVersion: 1, rules: [{ name: 'X', mode: 'frag', transport: 'both', enabled: true, domains: ['not a domain!!'] }] }), /دامنه/);
});
