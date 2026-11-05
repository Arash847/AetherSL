// scanner.ts — اسکنر اندپوینت Aether (Endpoint Scanner)
// مبنا: Docs رسمی Aether (CluvexStudio/Aether — DOCS.en.md بخش «Finding an endpoint»):
//  - Aether دستور scan جداگانه ندارد؛ اسکن موقع استارت اتفاق می‌افتد. پس Scanner
//    یک پروسس جداگانه Aether را با همان فلگ‌های اسکن اجرا می‌کند (روی پورت 1820 تا
//    با هسته اصلی روی 1819 تداخل نکند)، stdout/stderr را زنده parse می‌کند.
//  - modeها: turbo (اولین جواب‌دهنده)، balanced (پیش‌فرض؛ چندتا جمع می‌کند و
//    سریع‌ترین را نگه می‌دارد)، thorough (کل رنج را می‌گردد)، stealth (پروب کم)،
//    ironclad (تانل کامل + ریکوئست واقعی برای هر کاندید).
//  - handshake به‌تنهایی کافی نیست: کاندید باید data-plane را هم پاس کند تا
//    پروکسی شروع به کار کند. اندپوینتی که تازه fail شده روی cooldown می‌ماند.
//  - با --peer اسکن رد می‌شود؛ آخرین اندپوینت خوب ذخیره می‌شود و
//    --quick-reconnect آن را بدون sweep دوباره استفاده می‌کند.
//  - پورت‌هایی که اسکن امتحان می‌کند: 443، 500، 1701، 4500، 4443، 8443، 8095.
// اگر فرمت لاگ Aether قابل‌اعتماد نبود، fallback: پروب ساده رنج‌های مستند
// Cloudflare WARP با TCP connect (+ پروب UDP). اولویت با parse لاگ واقعی است.
// هشدار صادقانه درباره fallback: اندپوینت‌های WARP سرویس UDP هستند و به پروب
// بدون handshake معتبر جواب نمی‌دهند؛ پس TCP connect فقط «reachability» را
// می‌سنجد، نه سالم‌بودن تانل را — اعتبارسنجی واقعی همان data-plane خود Aether است.
import { connect } from 'node:net';
import { createSocket } from 'node:dgram';

export type ScanMode = 'turbo' | 'balanced' | 'thorough' | 'stealth' | 'ironclad';
export type ScanIpVersion = 'both' | '4' | '6';
export type ScanProtocol = 'masque' | 'masque-h2' | 'wg' | 'gool';

export const SCAN_MODES: { value: ScanMode; fa: string }[] = [
  { value: 'turbo', fa: 'turbo — اولین جواب‌دهنده را برمی‌دارد (سریع‌ترین شروع)' },
  { value: 'balanced', fa: 'balanced — پیش‌فرض؛ چندتا جمع می‌کند و سریع‌ترین را نگه می‌دارد' },
  { value: 'thorough', fa: 'thorough — کل رنج را می‌گردد (وقتی همه‌چیز بسته به نظر می‌رسد)' },
  { value: 'stealth', fa: 'stealth — پروب کم (برای شبکه‌هایی که اسکن را حس می‌کنند)' },
  { value: 'ironclad', fa: 'ironclad — تانل کامل + ریکوئست واقعی برای هر کاندید (کند ولی مطمئن)' },
];

export const SCAN_MODE_TIMEOUT_MS: Record<ScanMode, number> = {
  turbo: 60_000,
  balanced: 90_000,
  thorough: 240_000,
  stealth: 180_000,
  ironclad: 240_000,
};

/** پورت اسکنر Aether — جدا از هسته اصلی (1819) تا تداخل نکند */
export const SCANNER_BIND_PORT = 1820;
export const SCANNER_BIND_HOST = '127.0.0.1';

/** رنج‌های مستند Cloudflare WARP (IPv4) */
export const WARP_RANGES: string[] = [
  '162.159.192.0/24',
  '162.159.193.0/24',
  '162.159.195.0/24',
  '162.159.196.0/24',
  '162.159.204.0/24',
  '188.114.96.0/24',
  '188.114.97.0/24',
  '188.114.98.0/24',
  '188.114.99.0/24',
];

/** پورت‌هایی که Aether در اسکن امتحان می‌کند (از DOCS رسمی) */
export const MASQUE_SCAN_PORTS = [443, 500, 1701, 4500, 4443, 8443, 8095];
export const WG_SCAN_PORTS = [2408, 500, 1701, 4500];

export function scanPortsFor(protocol: ScanProtocol): number[] {
  return protocol === 'wg' ? WG_SCAN_PORTS : MASQUE_SCAN_PORTS;
}

export interface ScanOptions {
  mode: ScanMode;
  ipVersion: ScanIpVersion;
  protocol: ScanProtocol;
  /** noize از تنظیمات Aether */
  noize?: string;
  /** فقط fallback probe اجرا شود (بدون Aether) */
  fallbackOnly?: boolean;
  /** تعداد کاندید در fallback */
  fallbackCount?: number;
}

export type CandidateStatus = 'ok' | 'failed' | 'cooldown' | 'testing';
export type CandidateSource = 'aether-log' | 'fallback-probe';

export interface ScanCandidate {
  endpoint: string; // IP:port
  ip: string;
  port: number;
  status: CandidateStatus;
  latencyMs?: number;
  source: CandidateSource;
  detail?: string;
  selected?: boolean;
}

export interface ScanEvent {
  type: 'started' | 'line' | 'candidate' | 'selected' | 'progress' | 'done' | 'error' | 'stopped';
  line?: string;
  candidate?: ScanCandidate;
  candidates?: ScanCandidate[];
  selected?: string;
  tested?: number;
  message?: string;
  source?: CandidateSource;
}

/** آرگومان‌های پروسس اسکنر Aether — بدون --peer (اسکن خودکار) */
export function buildAetherScanArgs(opts: ScanOptions, noize?: string): string[] {
  const args: string[] = [];
  if (opts.protocol === 'masque' || opts.protocol === 'masque-h2') args.push('--masque');
  else if (opts.protocol === 'wg') args.push('--wg');
  else if (opts.protocol === 'gool') args.push('--gool');
  if (opts.ipVersion === '4') args.push('-4');
  else if (opts.ipVersion === '6') args.push('-6');
  args.push('--scan', opts.mode);
  if (opts.protocol === 'masque-h2') args.push('--h2');
  if (noize ?? opts.noize) args.push('--noize', (noize ?? opts.noize) as string);
  args.push('--bind', `${SCANNER_BIND_HOST}:${SCANNER_BIND_PORT}`);
  return args;
}

// ---------- parse لاگ Aether ----------

const IPV4_PORT_RE = /\b((?:\d{1,3}\.){3}\d{1,3}):(\d{2,5})\b/;
const IPV6_PORT_RE = /\[([0-9a-fA-F:]+)\]:(\d{2,5})/;
const LATENCY_RE = /(\d+(?:\.\d+)?)\s?ms\b/i;
const RTT_RE = /\brtt[:=]?\s*(\d+(?:\.\d+)?)/i;

function endpointFromLine(line: string): { ip: string; port: number; endpoint: string } | null {
  const v6 = IPV6_PORT_RE.exec(line);
  if (v6) return { ip: v6[1], port: Number(v6[2]), endpoint: `[${v6[1]}]:${v6[2]}` };
  const v4 = IPV4_PORT_RE.exec(line);
  if (v4) return { ip: v4[1], port: Number(v4[2]), endpoint: `${v4[1]}:${v4[2]}` };
  return null;
}

function latencyFromLine(line: string): number | undefined {
  const m = LATENCY_RE.exec(line) ?? RTT_RE.exec(line);
  return m ? Number(m[1]) : undefined;
}

/** یک خط لاگ Aether → کاندید (یا null اگر خط ربطی به اندپوینت ندارد) */
export function parseAetherLogLine(line: string): ScanCandidate | null {
  const ep = endpointFromLine(line);
  if (!ep) return null;
  const low = line.toLowerCase();
  const latencyMs = latencyFromLine(line);
  const selected =
    /\b(selected|chosen|best endpoint|using endpoint|using gateway|connected to|established)\b/.test(low) ||
    (/proxy.*(listening|ready|started)/.test(low) && /selected|using/.test(low));
  let status: CandidateStatus = 'testing';
  if (/cooldown/.test(low)) status = 'cooldown';
  else if (/\b(fail|failed|failure|timeout|timed out|refused|blocked|unreachable|no route|denied)\b/.test(low)) status = 'failed';
  else if (/\b(handshake|data-plane|data plane|verified|passed|success|ok|reachable|working)\b/.test(low)) status = 'ok';
  else if (selected) status = 'ok';
  return {
    endpoint: ep.endpoint, ip: ep.ip, port: ep.port,
    status, latencyMs, source: 'aether-log',
    detail: line.trim().slice(0, 200), selected: selected || undefined,
  };
}

/** چند خط لاگ → لیست یکتا + اندپوینت انتخاب‌شده (ok بر failed غلبه می‌کند) */
export function parseAetherLog(lines: string[]): { candidates: ScanCandidate[]; selected?: string } {
  const map = new Map<string, ScanCandidate>();
  let selected: string | undefined;
  const rank: Record<CandidateStatus, number> = { ok: 3, testing: 2, cooldown: 1, failed: 0 };
  for (const line of lines) {
    const c = parseAetherLogLine(line);
    if (!c) continue;
    const prev = map.get(c.endpoint);
    if (!prev || rank[c.status] > rank[prev.status]) {
      map.set(c.endpoint, { ...c, selected: prev?.selected || c.selected });
    } else if (c.selected) {
      map.set(c.endpoint, { ...prev, selected: true, status: prev.status === 'failed' ? 'ok' : prev.status });
    }
    if (c.selected) selected = c.endpoint;
  }
  const candidates = [...map.values()].sort((a, b) => {
    if (a.selected !== b.selected) return a.selected ? -1 : 1;
    if (a.status !== b.status) return rank[b.status] - rank[a.status];
    return (a.latencyMs ?? 999999) - (b.latencyMs ?? 999999);
  });
  if (!selected) selected = candidates.find((c) => c.selected)?.endpoint;
  return { candidates, selected };
}

/** خط یعنی پروکسی آماده است (اسکن تمام شده)؟ */
export function isProxyReadyLine(line: string): boolean {
  const low = line.toLowerCase();
  return /socks5?.*(listening|ready|started)|proxy.*(listening|ready|started)|listening on 127\.0\.0\.1/.test(low);
}

// ---------- fallback probe ----------

function hostsInRange(cidr: string): string[] {
  const [base, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  const parts = base.split('.').map(Number);
  const baseNum = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const count = 2 ** (32 - prefix);
  const out: string[] = [];
  for (let i = 1; i < Math.min(count - 1, 256); i++) {
    const n = (baseNum + i) >>> 0;
    out.push(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
  }
  return out;
}

/** نمونه‌برداری قطعی از رنج‌ها + پورت‌ها (بدون تصادفی‌بودن برای تست‌پذیری) */
export function sampleFallbackCandidates(protocol: ScanProtocol, count = 24): ScanCandidate[] {
  const ports = scanPortsFor(protocol);
  const out: ScanCandidate[] = [];
  let ri = 0;
  while (out.length < count) {
    const range = WARP_RANGES[ri % WARP_RANGES.length];
    const hosts = hostsInRange(range);
    const host = hosts[Math.floor(out.length / WARP_RANGES.length) % hosts.length];
    const port = ports[out.length % ports.length];
    const endpoint = `${host}:${port}`;
    if (!out.some((c) => c.endpoint === endpoint)) {
      out.push({ endpoint, ip: host, port, status: 'testing', source: 'fallback-probe' });
    }
    ri++;
    if (ri > count * 4) break;
  }
  return out.slice(0, count);
}

function tcpProbe(ip: string, port: number, timeoutMs: number): Promise<{ ok: boolean; latencyMs?: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = connect(port, ip);
    const done = (ok: boolean) => {
      try { s.destroy(); } catch {}
      resolve({ ok, latencyMs: ok ? Date.now() - t0 : undefined });
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

function udpProbe(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const sock = createSocket('udp4');
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once('error', () => { clearTimeout(timer); finish(false); });
    sock.once('message', () => { clearTimeout(timer); finish(true); });
    try {
      sock.send(Buffer.from([0x00]), port, ip, (err) => { if (err) { clearTimeout(timer); finish(false); } });
    } catch { clearTimeout(timer); finish(false); }
  });
}

/**
 * پروب fallback: برای هر کاندید اول TCP connect می‌زند (latency)، بعد پروب UDP.
 * ok = TCP وصل شد. failed = TCP نشد و UDP هم جوابی نداد.
 * (یادآوری: UDP ساکت ≠ قطعی خراب؛ WireGuard بدون handshake جواب نمی‌دهد.)
 */
export async function probeCandidates(
  candidates: ScanCandidate[],
  opts: { timeoutMs?: number; concurrency?: number; onCandidate?: (c: ScanCandidate) => void } = {},
): Promise<ScanCandidate[]> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const concurrency = opts.concurrency ?? 8;
  const results: ScanCandidate[] = [];
  let idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      const c = candidates[idx++];
      const tcp = await tcpProbe(c.ip, c.port, timeoutMs);
      let status: CandidateStatus;
      let detail: string;
      if (tcp.ok) {
        status = 'ok';
        detail = `TCP connect ${tcp.latencyMs}ms (reachability — نه تضمین تانل)`;
      } else {
        const udp = await udpProbe(c.ip, c.port, timeoutMs);
        status = udp ? 'ok' : 'failed';
        detail = udp
          ? 'UDP جواب داد (TCP بسته است)'
          : 'TCP نشد و UDP ساکت ماند — توجه: WireGuard بدون handshake جواب نمی‌دهد';
      }
      const out: ScanCandidate = { ...c, status, latencyMs: tcp.latencyMs, detail };
      results.push(out);
      opts.onCandidate?.(out);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));
  return results.sort((a, b) => {
    const rank: Record<CandidateStatus, number> = { ok: 3, testing: 2, cooldown: 1, failed: 0 };
    if (a.status !== b.status) return rank[b.status] - rank[a.status];
    return (a.latencyMs ?? 999999) - (b.latencyMs ?? 999999);
  });
}
