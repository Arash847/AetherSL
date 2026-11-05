// config-generator.ts — تولید خالص کانفیگ Xray و Zeptun از رول‌های کاربر
// خالص و تست‌پذیر است: هیچ IO یا spawn اینجا نیست. فقط JSON در، JSON/TOML بیرون.
// قراردادها (خلافشان نکن):
//  - نقطه ورود واحد Xray: inbound mixed روی 127.0.0.1:10808
//  - Aether جداگانه روی 127.0.0.1:1819 با outbound با tag «aether-out»
//  - Zeptun: TUN -> SOCKS5 به 127.0.0.1:10808 (یعنی به Xray)
//  - مرجع رول‌ها فایل configs/rules.user.json است (formatVersion 1، چهار گروه
//    Discord / Telegram / Youtube / Downloads — کپی دقیق فایل خود کاربر).
//    نگاشت قطعی: mode "frag" = Serverless ، mode "tunnel" = Aether.
//  - ترتیب رول‌ها first-match wins: بلاک تبلیغات، رول‌های گروه کاربر،
//    رول‌های داخلی Serverless (direct)، رول‌های DNS، پیش‌فرض (catch-all).
//  - منطق no-filter-dns: اگر حداقل یک رول frag فعال باشد (hasFrag=true)،
//    رول inboundTag «no-filter-dns» به tcp-fragment-tls می‌رود تا DoH فرانت‌شده
//    دوباره outbound محافظت‌شده بگیرد؛ اگر هیچ frag فعالی نباشد، آن رول
//    کلاً حذف می‌شود (غیرفعال). اگر resolver با frag هنوز EOF بدهد، frag روی
//    آن شبکه غیرقابل‌استفاده است و گروه باید برگردد به تانل.
//  - transport "both" یعنی tcp+udp هر دو به همان target می‌روند (دو رول جدا).

export type Target = 'aether' | 'serverless' | 'direct' | 'block';
export type MatchType = 'domain-suffix' | 'domain-keyword' | 'geosite' | 'geoip' | 'cidr' | 'port';
export type DefaultTarget = 'serverless' | 'aether' | 'direct';
export type Mode = 'hybrid' | 'serverless-only' | 'aether-only';

/** mode گروه‌های کاربر — همان دو اسمی که در UI هم نشان داده می‌شود */
export type RuleMode = 'frag' | 'tunnel';
export type RuleTransport = 'both' | 'tcp' | 'udp';

/** یک گروه رول — دقیقاً شکل فایل rules.user.json */
export interface RuleGroup {
  name: string;
  mode: RuleMode;
  transport: RuleTransport;
  enabled: boolean;
  domains: string[];
  note?: string;
}

/** فرمت فایل رول‌ها (ایمپورت/اکسپورت) */
export interface RuleFile {
  formatVersion: 1;
  rules: RuleGroup[];
}

/** رول تکی (فرم داخلی و قدیمی) — هر گروه به چند رول تکی باز می‌شود */
export interface UserRule {
  id: string;
  enabled: boolean;
  name: string;
  matchType: MatchType;
  match: string;
  target: Target;
  /** هرچه کوچک‌تر، اولویت بالاتر. پیش‌فرض 100 */
  priority?: number;
  /** 'tcp' | 'udp' | 'tcp+udp' — پیش‌فرض tcp */
  network?: string;
}

export interface AppSettings {
  mode: Mode;
  defaultTarget: DefaultTarget;
  /** پروفایل Serverless: fragB (پیش‌فرض) | fragA | oob */
  serverlessProfile: string;
  aetherProtocol: 'masque' | 'wireguard' | 'gool' | 'mim';
  aetherScan: string;
  /** نسخه IP اسکن/اتصال Aether: 'both' | '4' | '6' → فلگ -4 / -6 */
  aetherIpVersion: string;
  aetherH2: boolean;
  aetherNoize: string;
  aetherPeer: string;
  /** اتصال سریع به آخرین اندپوینت خوب بدون اسکن دوباره (--quick-reconnect) */
  aetherQuickReconnect: boolean;
  /** آخرین اندپوینت خوب (last known-good) + زمانش — برای Quick Reconnect */
  lastGoodEndpoint: string;
  lastGoodAt: string;
  tunEnabled: boolean;
  systemProxyEnabled: boolean;
  tunName: string;
  tunMtu: number;
  tunAddress: string;
  subscriptionUrl: string;
}

export const XRAY_INBOUND_PORT = 10808;
export const XRAY_INBOUND_HOST = '127.0.0.1';
export const AETHER_SOCKS_PORT = 1819;
export const AETHER_SOCKS_HOST = '127.0.0.1';
export const NO_FILTER_DNS_TAG = 'no-filter-dns';

// دامنه‌هایی که Serverless به‌صورت داخلی/مستقیم می‌فرستد (از Serverless-fragB.jsonc)
export const SERVERLESS_DIRECT_DOMAINS: string[] = [
  'domain:ir',
  'geosite:private',
  'geosite:category-ir',
  'geosite:xai',
  'geosite:openai',
  'geosite:google-deepmind',
  'geosite:anthropic',
  'geosite:github',
  'geosite:microsoft',
  'geosite:golang',
  'geosite:python',
  'geosite:rust',
];

// IPهای Cloudflare WARP که Aether استفاده می‌کند — باید از TUN مستثنا شوند تا لوپ نخورد
export const WARP_EXCLUDE_CIDRS: string[] = [
  '162.159.192.0/24',
  '162.159.193.0/24',
  '162.159.204.0/24',
  '188.114.96.0/24',
];

export const TUN_EXCLUDE_CIDRS: string[] = [
  '192.168.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '127.0.0.0/8',
  ...WARP_EXCLUDE_CIDRS,
];

export function defaultSettings(): AppSettings {
  return {
    mode: 'hybrid',
    defaultTarget: 'serverless',
    // پیش‌فرض fragB است — طبق note دیسکورد در فایل رول کاربر (fragB آدرس واقعی
    // ایرانی را حفظ می‌کند و با DNS/DoH مشکل DNS hijacking را حل می‌کند).
    // توجه: خروجی Aether هم فعلاً IP ایران است، پس Aether فیلتر ISP را دور
    // می‌زند ولی برای سرویس‌های تحریمی (که IP ایران را بلاک کرده‌اند) راه‌حل نیست.
    // fragA/fragB فقط در fragment lengths فرق دارند.
    serverlessProfile: 'fragB',
    aetherProtocol: 'masque',
    aetherScan: 'balanced',
    aetherIpVersion: 'both',
    aetherH2: false,
    aetherNoize: 'balanced',
    aetherPeer: '',
    aetherQuickReconnect: false,
    lastGoodEndpoint: '',
    lastGoodAt: '',
    tunEnabled: false,
    systemProxyEnabled: false,
    tunName: 'zeptun0',
    tunMtu: 8500,
    tunAddress: '172.19.0.1/30',
    subscriptionUrl:
      'https://raw.githubusercontent.com/patterniha/Serverless-for-Iran/refs/heads/main/Subscription/Serverless-for-Iran.json',
  };
}

/** نگاشت قطعی mode گروه → target داخلی: frag = Serverless ، tunnel = Aether */
export function ruleModeToTarget(mode: RuleMode): Target {
  return mode === 'frag' ? 'serverless' : 'aether';
}
export function targetToRuleMode(target: Target): RuleMode {
  return target === 'serverless' ? 'frag' : 'tunnel';
}

/** هر گروه را به رول‌های تکی (یکی به‌ازای هر دامنه) باز کن؛ ترتیب گروه‌ها = اولویت */
export function expandRuleGroups(groups: RuleGroup[]): UserRule[] {
  const out: UserRule[] = [];
  groups.forEach((g, gi) => {
    const priority = (gi + 1) * 10;
    const network = g.transport === 'both' ? 'tcp+udp' : g.transport;
    for (const d of g.domains ?? []) {
      const domain = String(d).trim();
      if (!domain) continue;
      out.push({
        id: `${g.name}:${domain}`,
        enabled: g.enabled !== false,
        name: g.name,
        matchType: 'domain-suffix',
        match: domain,
        target: ruleModeToTarget(g.mode),
        priority,
        network,
      });
    }
  });
  return out;
}

/** hasFrag: حداقل یک رول frag (Serverless) فعال وجود دارد؟ */
export function hasFrag(rules: UserRule[]): boolean {
  return rules.some((r) => r?.enabled !== false && r.target === 'serverless');
}
export function hasFragGroups(groups: RuleGroup[]): boolean {
  return hasFrag(expandRuleGroups(groups));
}

// نگاشت target به outbound؛ network مشخص می‌کند TCP است یا UDP
export function outboundForTarget(target: Target, rule?: UserRule, network?: string, profile?: string): string {
  if (target === 'aether') return 'aether-out';
  if (target === 'direct') return network === 'udp' ? 'udp-direct' : 'tcp-direct';
  if (target === 'block') return 'block';
  // serverless
  const net = network ?? rule?.network;
  const isUdp =
    net === 'udp' ||
    (rule?.matchType === 'port' && /udp/i.test(rule?.match ?? ''));
  if (isUdp) return 'udp-noises';
  if (rule?.matchType === 'port') {
    const m = (rule.match || '').trim();
    if (m === '443' || m.endsWith(':443') || m === 'tcp:443') {
      return profile === 'oob' ? 'tcp-oob' : 'tcp-fragment-tls';
    }
    return profile === 'oob' ? 'tcp-oob' : 'tcp-fragment';
  }
  // در پروفایل oob ترافیک TCP/TLS گروه‌های frag به tcp-oob می‌رود
  return profile === 'oob' ? 'tcp-oob' : 'tcp-fragment-tls';
}

/** یک رول تکی → یک یا دو رول routing (transport both = دو رول tcp + udp) */
export function ruleToRoutingRules(rule: UserRule, profile?: string): Record<string, unknown>[] {
  const match = (rule.match || '').trim();
  const base: Record<string, unknown> = { type: 'field' };
  switch (rule.matchType) {
    case 'domain-suffix':
      base.domain = [match.startsWith('domain:') ? match : `domain:${match}`];
      break;
    case 'domain-keyword':
      base.domain = [`keyword:${match}`];
      break;
    case 'geosite':
      base.domain = [match.startsWith('geosite:') ? match : `geosite:${match}`];
      break;
    case 'geoip':
      base.ip = [match.startsWith('geoip:') ? match : `geoip:${match}`];
      break;
    case 'cidr':
      base.ip = [match];
      break;
    case 'port': {
      const m = match.match(/^(tcp|udp)?:?(\d+(?:-\d+)?)$/i);
      if (m) {
        base.port = m[2];
        if (m[1]) base.network = m[1].toLowerCase();
        else if (rule.network && rule.network !== 'tcp+udp') base.network = rule.network;
      } else {
        base.port = match;
      }
      break;
    }
  }
  // بلاک بدون network هر دو را می‌گیرد؛ بقیه transport را صریح می‌خواهند
  if (rule.target === 'block') {
    return [{ ...base, outboundTag: 'block' }];
  }
  const net = rule.network ?? 'tcp';
  if (net === 'tcp+udp' || net === 'both') {
    return [
      { ...base, network: 'tcp', outboundTag: outboundForTarget(rule.target, rule, 'tcp', profile) },
      { ...base, network: 'udp', outboundTag: outboundForTarget(rule.target, rule, 'udp', profile) },
    ];
  }
  const network = net === 'udp' ? 'udp' : 'tcp';
  return [{ ...base, network, outboundTag: outboundForTarget(rule.target, rule, network, profile) }];
}

function catchAllOutbound(settings: AppSettings): string {
  // در حالت‌های serverless-only / aether-only فقط defaultTarget عوض می‌شود؛
  // هسته دیگر خاموش نمی‌شود تا سوییچ فوری باشد.
  const effective: DefaultTarget =
    settings.mode === 'serverless-only'
      ? 'serverless'
      : settings.mode === 'aether-only'
        ? 'aether'
        : settings.defaultTarget;
  if (effective === 'aether') return 'aether-out';
  if (effective === 'direct') return 'tcp-direct';
  return settings.serverlessProfile === 'oob' ? 'tcp-oob' : 'tcp-fragment-tls';
}

function ensureAetherOutbound(config: Record<string, any>): void {
  const outbounds: any[] = Array.isArray(config.outbounds) ? config.outbounds : [];
  if (!outbounds.some((o) => o?.tag === 'aether-out')) {
    outbounds.push({
      tag: 'aether-out',
      protocol: 'socks',
      settings: {
        servers: [{ address: AETHER_SOCKS_HOST, port: AETHER_SOCKS_PORT, version: 5 }],
      },
    });
  }
  config.outbounds = outbounds;
}

function ensureInbound(config: Record<string, any>): void {
  const inbounds: any[] = Array.isArray(config.inbounds) ? config.inbounds : [];
  const mixed = inbounds.find((i) => i?.protocol === 'mixed' || i?.protocol === 'socks' || i?.protocol === 'http');
  if (mixed) {
    mixed.protocol = 'mixed';
    mixed.listen = XRAY_INBOUND_HOST;
    mixed.port = XRAY_INBOUND_PORT;
    // upstream از settings.ip استفاده می‌کند؛ هر دو را هم‌زمان ست می‌کنیم
    mixed.settings = { ...(mixed.settings ?? {}), udp: true, ip: XRAY_INBOUND_HOST };
    // sniffing upstream (با destOverride شامل fakedns) را دست نمی‌زنیم؛
    // اگر نبود، مقدار پیش‌فرض را می‌گذاریم.
    if (!mixed.sniffing) {
      mixed.sniffing = {
        enabled: true,
        destOverride: ['fakedns', 'tls', 'http', 'quic'],
        metadataOnly: false,
        routeOnly: false,
      };
    }
  } else {
    inbounds.unshift({
      tag: 'mixed-in',
      protocol: 'mixed',
      listen: XRAY_INBOUND_HOST,
      port: XRAY_INBOUND_PORT,
      sniffing: {
        enabled: true,
        destOverride: ['fakedns', 'tls', 'http', 'quic'],
        metadataOnly: false,
        routeOnly: false,
      },
      settings: { udp: true, ip: XRAY_INBOUND_HOST },
    });
  }
  config.inbounds = inbounds;
}

function isTcpCatchAll(rule: Record<string, any>): boolean {
  return (
    rule?.network === 'tcp' &&
    Array.isArray(rule?.ip) &&
    rule.ip.includes('0.0.0.0/0') &&
    !rule?.domain &&
    !rule?.port &&
    !rule?.protocol
  );
}

/** رول inboundTag «no-filter-dns» در لیست رول‌ها */
function findNoFilterDnsRule(rules: Record<string, any>[]): number {
  return rules.findIndex(
    (r) => Array.isArray(r?.inboundTag) && r.inboundTag.includes(NO_FILTER_DNS_TAG),
  );
}

/** ساخت کانفیگ نهایی Xray از کانفیگ پایه + رول‌های کاربر + تنظیمات */
export function buildXrayConfig(
  baseConfig: Record<string, any>,
  userRules: UserRule[],
  settings: AppSettings,
): Record<string, any> {
  const config: Record<string, any> = JSON.parse(JSON.stringify(baseConfig ?? {}));
  ensureInbound(config);
  ensureAetherOutbound(config);
  const profile = settings.serverlessProfile;

  const enabled = userRules
    .filter((r) => r?.enabled !== false)
    .slice()
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  const frag = hasFrag(enabled);

  const baseRules: Record<string, any>[] = Array.isArray(config.routing?.rules)
    ? [...config.routing.rules]
    : [];

  if (baseRules.length > 0) {
    // مسیر upstream (fragA/fragB/oob v58): رول‌های پایه حفظ می‌شوند؛ رول کاربر
    // بلافاصله بعد از بلاک تبلیغات (رول اول) درج می‌شود تا بر direct داخلی
    // و catch-allها اولویت داشته باشد.
    const userRouting: Record<string, unknown>[] = [];
    for (const r of enabled) userRouting.push(...ruleToRoutingRules(r, profile));
    const insertAt = baseRules.length > 0 ? 1 : 0;
    baseRules.splice(insertAt, 0, ...(userRouting as Record<string, any>[]));

    // منطق no-filter-dns (با hasFrag)
    const nfIdx = findNoFilterDnsRule(baseRules);
    if (nfIdx >= 0) {
      if (frag) baseRules[nfIdx].outboundTag = 'tcp-fragment-tls';
      else baseRules.splice(nfIdx, 1);
    }

    // catch-all پیش‌فرض (TCP) را با تنظیمات کاربر هماهنگ کن
    for (let i = baseRules.length - 1; i >= 0; i--) {
      if (isTcpCatchAll(baseRules[i])) {
        baseRules[i].outboundTag = catchAllOutbound(settings);
        break;
      }
    }
    // در حالت aether-only، رول‌های fragment برای TLS/443 هم باید به Aether بروند
    if (settings.mode === 'aether-only') {
      for (const r of baseRules) {
        if (
          r?.network === 'tcp' &&
          r?.outboundTag === 'tcp-fragment-tls' &&
          Array.isArray(r?.ip) &&
          r.ip.includes('0.0.0.0/0')
        ) {
          r.outboundTag = 'aether-out';
        }
      }
    }
    config.routing = {
      ...(config.routing ?? {}),
      domainStrategy: config.routing?.domainStrategy ?? 'AsIs',
      rules: baseRules,
    };
    return config;
  }

  // مسیر قدیمی (base ساده بدون رول): کل لیست را خودمان می‌سازیم
  const rules: Record<string, unknown>[] = [];
  rules.push({ type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'block' });
  for (const r of enabled) rules.push(...ruleToRoutingRules(r, profile));
  rules.push({ type: 'field', domain: [...SERVERLESS_DIRECT_DOMAINS], outboundTag: 'tcp-direct' });
  rules.push({ type: 'field', domain: [...SERVERLESS_DIRECT_DOMAINS], network: 'udp', outboundTag: 'udp-direct' });
  rules.push({ type: 'field', network: 'udp', port: '53', outboundTag: 'dns-out' });
  rules.push({ type: 'field', port: '53', outboundTag: 'dns-out' });
  rules.push({ type: 'field', network: 'tcp', outboundTag: catchAllOutbound(settings) });
  rules.push({ type: 'field', network: 'udp', outboundTag: 'udp-noises' });

  config.routing = {
    ...(config.routing ?? {}),
    domainStrategy: config.routing?.domainStrategy ?? 'AsIs',
    rules,
  };
  return config;
}

/** ساخت کانفیگ از روی گروه‌های کاربر (فرمت فایل rules.user.json) */
export function buildXrayConfigFromGroups(
  baseConfig: Record<string, any>,
  groups: RuleGroup[],
  settings: AppSettings,
): Record<string, any> {
  return buildXrayConfig(baseConfig, expandRuleGroups(groups), settings);
}

/** ساخت کانفیگ Zeptun (TOML) — TUN همیشه به SOCKS5 خود Xray وصل می‌شود */
export function buildZeptunConfig(settings: AppSettings): string {
  const lines: string[] = [];
  lines.push('# Zeptun — ساخته‌شده توسط AetherSL؛ TUN -> SOCKS5 به Xray (127.0.0.1:10808)');
  lines.push('[tun]');
  lines.push(`name = "${settings.tunName}"`);
  lines.push(`mtu = ${settings.tunMtu}`);
  lines.push(`address = "${settings.tunAddress}"`);
  lines.push('');
  lines.push('[handler.socks5]');
  lines.push(`server = "${XRAY_INBOUND_HOST}:${XRAY_INBOUND_PORT}"`);
  lines.push('');
  lines.push('[route]');
  lines.push('auto_route = true');
  lines.push(`exclude = [${TUN_EXCLUDE_CIDRS.map((c) => `"${c}"`).join(', ')}]`);
  lines.push('');
  lines.push('[dns]');
  lines.push('hijack = true');
  lines.push('fake_ip = true');
  return lines.join('\n') + '\n';
}

/** آرگومان‌های خط فرمان Aether از روی تنظیمات */
export function buildAetherArgs(settings: AppSettings): string[] {
  const args: string[] = [];
  if (settings.aetherProtocol === 'masque') args.push('--masque');
  else if (settings.aetherProtocol === 'wireguard') args.push('--wg');
  else if (settings.aetherProtocol === 'gool') args.push('--gool');
  else if (settings.aetherProtocol === 'mim') args.push('--mim');
  // نسخه IP: فقط وقتی مشخص است فلگ می‌خورد (-4 در README رسمی مثال زده شده؛
  // -6 همتای متقارن آن است — برای اطمینان `aether --help` را ببین)
  if (settings.aetherIpVersion === '4') args.push('-4');
  else if (settings.aetherIpVersion === '6') args.push('-6');
  if (settings.aetherScan) args.push('--scan', settings.aetherScan);
  if (settings.aetherH2) args.push('--h2');
  if (settings.aetherNoize) args.push('--noize', settings.aetherNoize);
  if (settings.aetherPeer) args.push('--peer', settings.aetherPeer);
  if (settings.aetherQuickReconnect) args.push('--quick-reconnect');
  args.push('--bind', `${AETHER_SOCKS_HOST}:${AETHER_SOCKS_PORT}`);
  return args;
}
