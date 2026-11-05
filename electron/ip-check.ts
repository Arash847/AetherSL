// ip-check.ts — بررسی IP خروجی و وضعیت WARP (تست‌پذیر، بدون وابستگی به Electron)
// نکته مهم (گفته آرش، 2026-11-05):
//  - تازگی‌ها WARP و MASQUE IP ایران می‌دهند؛ قبلاً با همین نت ایران IP آلمان می‌داد.
//  - IPای که الان می‌دهد همان IP نت عادی خودش است (با حالت بدون تانل فرقی نمی‌کند)
//    — فقط فیلترینگ رفع می‌شود.
//  - سایت‌هایی که از خارج ایران را تحریم کرده‌اند با این IP دیگر کار نمی‌کنند؛
//    برای آرش این مورد زیاد مهم نیست (هشدار اطلاع‌رسانی است، نه بلاک‌کننده).
// چرا سه مسیر را جدا می‌سنجیم؟
//  - مستقیم (بدون تانل) = IP عادی نت کاربر → مبنای مقایسه (قبل).
//  - از Aether (SOCKS5 روی 1819) = IP خروجی واقعی تانل + warp=on/off.
//    اگر IP همان IP عادی است ولی warp=on است → egress کلادفلر در ایران است.
//    اگر warp=off است → تانل وصل نشده و ترافیک نشت می‌کند.
//  - از Xray (HTTP CONNECT به 10808) = IP مسیر پیش‌فرض فعلی (رول‌ها چه می‌گویند).
import { connect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export const TRACE_HOST = 'www.cloudflare.com';
export const TRACE_PATH = '/cdn-cgi/trace';
export const TRACE_TIMEOUT_MS = 10000;

export interface TraceInfo {
  ip: string;
  loc: string;
  warp: string; // 'on' | 'off' | ''
  country?: string;
  raw: string;
}

export interface ExitIpReport {
  /** بدون تانل (مستقیم) — مبنای مقایسه */
  direct: TraceInfo | null;
  /** از مسیر پیش‌فرض Xray (HTTP CONNECT به 127.0.0.1:10808) */
  viaXray: TraceInfo | null;
  /** از Aether (SOCKS5 به 127.0.0.1:1819) */
  viaAether: TraceInfo | null;
  /** کشور IP مستقیم (از ip-api) */
  country: string;
  countryCode: string;
}

/** پارس خروجی cdn-cgi/trace (خط‌های key=value) */
export function parseTrace(text: string): TraceInfo {
  const fields: Record<string, string> = {};
  for (const line of String(text ?? '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    ip: fields.ip ?? '',
    loc: fields.loc ?? '',
    warp: fields.warp ?? '',
    raw: String(text ?? ''),
  };
}

/** بایت‌های درخواست SOCKS5 CONNECT (برای تست) */
export function buildSocks5ConnectRequest(host: string, port: number): Buffer {
  const hostBuf = Buffer.from(host, 'utf-8');
  const out = Buffer.alloc(7 + hostBuf.length);
  out[0] = 0x05; // VER
  out[1] = 0x01; // CONNECT
  out[2] = 0x00; // RSV
  out[3] = 0x03; // ATYP: domain
  out[4] = hostBuf.length;
  hostBuf.copy(out, 5);
  out.writeUInt16BE(port, 5 + hostBuf.length);
  return out;
}

/** متن درخواست HTTP CONNECT (برای تست) */
export function buildHttpConnectRequest(host: string, port: number): string {
  return `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`;
}

function readExact(socket: Socket, n: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onErr); };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= n) { cleanup(); resolve(buf.subarray(0, n)); }
    };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    socket.on('data', onData);
    socket.once('error', onErr);
  });
}

function readUntil(socket: Socket, delimiter: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onErr); };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      const i = buf.indexOf(delimiter);
      if (i >= 0) { cleanup(); resolve(buf.slice(0, i + delimiter.length)); }
    };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    socket.on('data', onData);
    socket.once('error', onErr);
  });
}

function tlsGetTrace(socket: Socket, host: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, servername: host, minVersion: 'TLSv1.2' });
    const timer = setTimeout(() => { try { tls.destroy(); } catch {} reject(new Error('timeout')); }, timeoutMs);
    let body = '';
    tls.once('error', (e) => { clearTimeout(timer); reject(e); });
    tls.once('secureConnect', () => {
      tls.write(`GET ${TRACE_PATH} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    tls.on('data', (c) => { body += c.toString('utf-8'); });
    tls.once('end', () => { clearTimeout(timer); resolve(body); });
    tls.once('close', () => { clearTimeout(timer); resolve(body); });
  });
}

function stripHttpHeaders(raw: string): string {
  const i = raw.indexOf('\r\n\r\n');
  return i >= 0 ? raw.slice(i + 4) : raw;
}

/** trace مستقیم (بدون پراکسی) — IP عادی نت */
export async function fetchTraceDirect(timeoutMs = TRACE_TIMEOUT_MS): Promise<TraceInfo> {
  const res = await fetch(`https://${TRACE_HOST}${TRACE_PATH}`, { signal: AbortSignal.timeout(timeoutMs) } as any);
  return parseTrace(await res.text());
}

/** trace از طریق HTTP CONNECT به یک پراکسی (Xray mixed روی 10808) */
export async function fetchTraceViaHttpProxy(
  proxyHost: string,
  proxyPort: number,
  timeoutMs = TRACE_TIMEOUT_MS,
): Promise<TraceInfo> {
  const socket = connect(proxyPort, proxyHost);
  socket.setTimeout(timeoutMs, () => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  socket.write(buildHttpConnectRequest(TRACE_HOST, 443));
  const head = await readUntil(socket, '\r\n\r\n', timeoutMs);
  if (!/^HTTP\/1\.[01] 200/i.test(head)) { socket.destroy(); throw new Error(`HTTP CONNECT ناموفق: ${head.split('\r\n')[0]}`); }
  const raw = await tlsGetTrace(socket, TRACE_HOST, timeoutMs);
  return parseTrace(stripHttpHeaders(raw));
}

/** trace از طریق SOCKS5 (Aether روی 1819) */
export async function fetchTraceViaSocks5(
  socksHost: string,
  socksPort: number,
  timeoutMs = TRACE_TIMEOUT_MS,
): Promise<TraceInfo> {
  const socket = connect(socksPort, socksHost);
  socket.setTimeout(timeoutMs, () => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const greet = await readExact(socket, 2, timeoutMs);
  if (greet[0] !== 0x05 || greet[1] !== 0x00) { socket.destroy(); throw new Error('SOCKS5 greeting ناموفق'); }
  socket.write(buildSocks5ConnectRequest(TRACE_HOST, 443));
  const head = await readExact(socket, 4, timeoutMs);
  if (head[1] !== 0x00) { socket.destroy(); throw new Error(`SOCKS5 CONNECT ناموفق (rep=${head[1]})`); }
  const atyp = head[3];
  if (atyp === 0x01) await readExact(socket, 6, timeoutMs);
  else if (atyp === 0x03) {
    const lenBuf = await readExact(socket, 1, timeoutMs);
    await readExact(socket, lenBuf[0] + 2, timeoutMs);
  } else if (atyp === 0x04) await readExact(socket, 18, timeoutMs);
  else { socket.destroy(); throw new Error(`SOCKS5 atyp نامعتبر: ${atyp}`); }
  const raw = await tlsGetTrace(socket, TRACE_HOST, timeoutMs);
  return parseTrace(stripHttpHeaders(raw));
}

export type WarpStatus =
  | 'warp-on-same-ip' // warp=on و IP همان IP عادی → egress کلادفلر در ایران است
  | 'warp-on-different-ip' // warp=on و IP عوض شده
  | 'warp-off' // warp=off → تانل وصل نشده / نشت
  | 'no-aether' // Aether در دسترس نیست
  | 'unknown';

export const WARP_STATUS_FA: Record<WarpStatus, string> = {
  'warp-on-same-ip': '✅ warp=on است و IP همان IP عادی است — یعنی egress کلادفلر در ایران است؛ فیلترینگ رفع می‌شود ولی IP عوض نشده.',
  'warp-on-different-ip': '✅ warp=on است و IP عوض شده — تانل برقرار است.',
  'warp-off': '⚠️ warp=off است — تانل وصل نشده و ترافیک نشت می‌کند؛ اتصال Aether را چک کن.',
  'no-aether': 'Aether در دسترس نیست (هنوز متصل نشده یا SOCKS 1819 بالا نیامده).',
  unknown: 'وضعیت warp مشخص نیست.',
};

/** تفسیر وضعیت تانل از مقایسه IP مستقیم و IP از Aether */
export function interpretWarp(direct: TraceInfo | null, viaAether: TraceInfo | null): WarpStatus {
  if (!viaAether || !viaAether.ip) return 'no-aether';
  if (viaAether.warp === 'on') {
    if (direct?.ip && viaAether.ip === direct.ip) return 'warp-on-same-ip';
    return 'warp-on-different-ip';
  }
  if (viaAether.warp === 'off') return 'warp-off';
  return 'unknown';
}

/** گزارش کامل: هر سه مسیر را موازی می‌سنجد؛ خرابی یک مسیر بقیه را خراب نمی‌کند */
export async function getExitIpReport(): Promise<ExitIpReport> {
  const [direct, viaXray, viaAether, countryRes] = await Promise.all([
    fetchTraceDirect().catch(() => null),
    fetchTraceViaHttpProxy('127.0.0.1', 10808).catch(() => null),
    fetchTraceViaSocks5('127.0.0.1', 1819).catch(() => null),
    fetch('https://ip-api.com/json/?fields=status,country,countryCode,query', { signal: AbortSignal.timeout(8000) } as any)
      .then((r) => r.json() as Promise<any>)
      .catch(() => null),
  ]);
  return {
    direct,
    viaXray,
    viaAether,
    country: countryRes?.status === 'success' ? (countryRes.country ?? '') : '',
    countryCode: countryRes?.status === 'success' ? (countryRes.countryCode ?? '') : '',
  };
}
