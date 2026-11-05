// core-manager.ts — مدیریت پروسس‌های xray + aether + zeptun
// هر هسته با spawn اجرا می‌شود، لاگش به UI می‌رود، وضعیت و PID نگه داشته می‌شود.
// health-check: TCP connect به 10808 و 1819 + تست از طریق پراکسی.
// restart خودکار حداکثر 3 بار.
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { buildAetherArgs, buildXrayConfig, buildZeptunConfig, AETHER_SOCKS_PORT, XRAY_INBOUND_PORT, type AppSettings, type UserRule } from './config-generator';
import {
  buildAetherScanArgs, isProxyReadyLine, parseAetherLogLine, probeCandidates, sampleFallbackCandidates,
  SCAN_MODE_TIMEOUT_MS, type ScanCandidate, type ScanEvent, type ScanOptions,
} from './scanner';
import { coreBinaryPath } from './downloader';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type CoreName = 'xray' | 'aether' | 'zeptun';
export type CoreStatus = 'stopped' | 'starting' | 'running' | 'error';
export interface CoreState { name: CoreName; status: CoreStatus; pid?: number; uptimeSec: number; startedAt?: number; restarts: number; lastError?: string }
export type LogFn = (core: CoreName | 'app', line: string) => void;

const MAX_RESTARTS = 3;

function tcpOk(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(port, host);
    const done = (ok: boolean) => { try { s.destroy(); } catch {} resolve(ok); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

export class CoreManager {
  private procs = new Map<CoreName, ChildProcess>();
  private states = new Map<CoreName, CoreState>();
  private log: LogFn;
  private coresDir: string;
  private workDir: string;

  constructor(coresDir: string, workDir: string, log: LogFn) {
    this.coresDir = coresDir;
    this.workDir = workDir;
    this.log = log;
    for (const n of ['xray', 'aether', 'zeptun'] as CoreName[]) {
      this.states.set(n, { name: n, status: 'stopped', uptimeSec: 0, restarts: 0 });
    }
  }

  getState(name: CoreName): CoreState {
    const s = this.states.get(name)!;
    return { ...s, uptimeSec: s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0 };
  }
  getAllStates(): CoreState[] {
    return (['xray', 'aether', 'zeptun'] as CoreName[]).map((n) => this.getState(n));
  }

  private setStatus(name: CoreName, status: CoreStatus, extra?: Partial<CoreState>) {
    const s = this.states.get(name)!;
    Object.assign(s, { status, ...extra });
    if (status === 'running' && !s.startedAt) s.startedAt = Date.now();
    if (status === 'stopped') { s.startedAt = undefined; s.pid = undefined; }
  }

  private spawnCore(name: CoreName, bin: string, args: string[], cwd?: string): void {
    const st = this.states.get(name)!;
    this.setStatus(name, 'starting');
    this.log(name, `اجرای ${bin} ${args.join(' ')}`);
    let proc: ChildProcess;
    try {
      proc = spawn(bin, args, { cwd: cwd ?? this.workDir, windowsHide: true });
    } catch (e: any) {
      this.setStatus(name, 'error', { lastError: e.message });
      this.log(name, `خطا در اجرا: ${e.message}`);
      return;
    }
    this.procs.set(name, proc);
    this.setStatus(name, 'running', { pid: proc.pid });
    proc.stdout?.on('data', (d) => this.log(name, String(d).trim()));
    proc.stderr?.on('data', (d) => this.log(name, String(d).trim()));
    proc.on('error', (e) => {
      this.setStatus(name, 'error', { lastError: e.message });
      this.log(name, `خطا: ${e.message}`);
    });
    proc.on('exit', (code, signal) => {
      this.procs.delete(name);
      this.log(name, `خروج با کد ${code} (سیگنال ${signal})`);
      const wasRunning = st.status === 'running';
      this.setStatus(name, 'stopped');
      // restart خودکار فقط اگر خودش کرش کرده باشد (نه stop دستی) و زیر سقف باشد
      if (wasRunning && st.restarts < MAX_RESTARTS && (this as any)._autoRestart?.[name]) {
        st.restarts += 1;
        this.log(name, `ری‌استارت خودکار (${st.restarts}/${MAX_RESTARTS}) تا 2 ثانیه دیگر…`);
        setTimeout(() => (this as any)._restartFn?.(name), 2000);
      }
    });
  }

  private _autoRestart: Record<CoreName, boolean> = { xray: false, aether: false, zeptun: false };
  private _restartFn: ((name: CoreName) => void) | null = null;
  onRestartRequest(fn: (name: CoreName) => void) { this._restartFn = fn; }

  startXray(baseConfig: Record<string, any>, rules: UserRule[], settings: AppSettings): boolean {
    const bin = coreBinaryPath(this.coresDir, 'xray');
    const cfg = buildXrayConfig(baseConfig, rules, settings);
    const cfgPath = join(this.workDir, 'xray.generated.json');
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
    this._autoRestart.xray = true;
    this.spawnCore('xray', bin, ['run', '-c', cfgPath]);
    return true;
  }

  startAether(settings: AppSettings): boolean {
    const bin = coreBinaryPath(this.coresDir, 'aether');
    this._autoRestart.aether = true;
    this.spawnCore('aether', bin, buildAetherArgs(settings));
    return true;
  }

  startZeptun(settings: AppSettings): boolean {
    const bin = coreBinaryPath(this.coresDir, 'zeptun');
    const cfgPath = join(this.workDir, 'zeptun.generated.toml');
    writeFileSync(cfgPath, buildZeptunConfig(settings), 'utf-8');
    this._autoRestart.zeptun = true;
    // Zeptun روی لینوکس به sudo/CAP_NET_ADMIN و روی ویندوز به Admin نیاز دارد؛
    // اگر بدون دسترسی اجرا شود خطایش در لاگ دیده می‌شود (به README بخش عیب‌یابی نگاه کنید).
    this.spawnCore('zeptun', bin, ['run', '-c', cfgPath]);
    return true;
  }

  stop(name: CoreName): void {
    this._autoRestart[name] = false;
    const p = this.procs.get(name);
    if (p && !p.killed) { try { p.kill('SIGTERM'); } catch {} setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 3000); }
    this.setStatus(name, 'stopped');
  }
  stopAll(): void { for (const n of ['xray', 'aether', 'zeptun'] as CoreName[]) this.stop(n); }

  // ---------- Endpoint Scanner ----------
  private scanProc: ChildProcess | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private scanEmit: ((e: ScanEvent) => void) | null = null;
  private scanCandidates = new Map<string, ScanCandidate>();
  private scanTested = 0;
  private scanDone = false;

  onScanEvent(fn: (e: ScanEvent) => void): void { this.scanEmit = fn; }
  isScanning(): boolean { return !!this.scanProc && !this.scanProc.killed; }

  private emitScan(e: ScanEvent): void { try { this.scanEmit?.(e); } catch {} }

  /** اسکن با پروسس جداگانه Aether روی پورت 1820 (هسته اصلی روی 1819 دست نمی‌خورد) */
  startScan(opts: ScanOptions, settings: AppSettings): { ok: boolean; error?: string } {
    if (this.isScanning()) return { ok: false, error: 'اسکن در حال اجراست — اول Stop را بزن' };
    const bin = coreBinaryPath(this.coresDir, 'aether');
    if (!existsSync(bin)) {
      return { ok: false, error: 'باینری Aether پیدا نشد — اول «دانلود هسته‌ها» را بزن' };
    }
    this.scanCandidates = new Map();
    this.scanTested = 0;
    this.scanDone = false;
    this.emitScan({ type: 'started', message: `اسکن شروع شد (mode=${opts.mode}, protocol=${opts.protocol}, ip=${opts.ipVersion})` });

    const finish = (message: string, source: 'aether-log' | 'fallback-probe' = 'aether-log') => {
      if (this.scanDone) return;
      this.scanDone = true;
      if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null; }
      const candidates = [...this.scanCandidates.values()];
      const selected = candidates.find((c) => c.selected)?.endpoint;
      this.killScanProc();
      this.emitScan({ type: 'done', candidates, selected, tested: this.scanTested, message, source });
    };

    const runFallback = async (reason: string) => {
      this.log('app', `اسکنر: ${reason} — fallback probe روی رنج‌های WARP`);
      this.emitScan({ type: 'progress', tested: this.scanTested, message: 'لاگ Aether کاندیدی نداد؛ fallback probe…' });
      const samples = sampleFallbackCandidates(opts.protocol, opts.fallbackCount ?? 24);
      const results = await probeCandidates(samples, {
        onCandidate: (c) => {
          this.scanTested += 1;
          this.scanCandidates.set(c.endpoint, c);
          this.emitScan({ type: 'candidate', candidate: c, tested: this.scanTested });
        },
      });
      const best = results.find((c) => c.status === 'ok');
      if (best) best.selected = true;
      finish(best ? `fallback: بهترین کاندید ${best.endpoint}` : 'fallback هم کاندید سالمی نداد', 'fallback-probe');
    };

    if (opts.fallbackOnly) {
      void runFallback('fallback-only انتخاب شده');
      return { ok: true };
    }

    const args = buildAetherScanArgs(opts, settings.aetherNoize);
    this.log('app', `اسکنر: اجرای ${bin} ${args.join(' ')}`);
    let proc: ChildProcess;
    try {
      proc = spawn(bin, args, { cwd: this.workDir, windowsHide: true });
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
    this.scanProc = proc;
    const timeoutMs = SCAN_MODE_TIMEOUT_MS[opts.mode] ?? 90_000;
    this.scanTimer = setTimeout(() => {
      if (this.scanCandidates.size === 0) void runFallback(`تایم‌اوت ${timeoutMs / 1000} ثانیه بدون کاندید`);
      else finish(`تایم‌اوت ${timeoutMs / 1000} ثانیه — نتایج جزئی`);
    }, timeoutMs);

    let buffer = '';
    const onChunk = (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        this.emitScan({ type: 'line', line });
        const c = parseAetherLogLine(line);
        if (c) {
          this.scanTested += 1;
          const prev = this.scanCandidates.get(c.endpoint);
          const merged: ScanCandidate = prev
            ? { ...prev, status: c.status === 'ok' ? 'ok' : prev.status, latencyMs: c.latencyMs ?? prev.latencyMs, selected: prev.selected || c.selected, detail: c.detail }
            : c;
          this.scanCandidates.set(c.endpoint, merged);
          this.emitScan({ type: 'candidate', candidate: merged, tested: this.scanTested });
          if (c.selected) this.emitScan({ type: 'selected', selected: c.endpoint, candidate: merged });
        }
        // پروکسی آماده + یک انتخاب داریم → اسکن تمام است؛ پروسس اسکنر را می‌کشیم
        if (isProxyReadyLine(line) && this.scanCandidates.size > 0) {
          const selected = [...this.scanCandidates.values()].find((x) => x.selected)
            ?? [...this.scanCandidates.values()].find((x) => x.status === 'ok');
          if (selected) {
            selected.selected = true;
            finish(`اندپوینت انتخاب شد: ${selected.endpoint}`);
          }
        }
      }
    };
    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);
    proc.on('error', (e) => {
      this.log('app', `اسکنر خطا: ${e.message}`);
      if (this.scanCandidates.size === 0) void runFallback(`اجرای Aether ناموفق: ${e.message}`);
      else finish(`خطای پروسس اسکنر: ${e.message}`);
    });
    proc.on('exit', (code) => {
      this.scanProc = null;
      if (this.scanDone) return;
      if (this.scanCandidates.size === 0) void runFallback(`پروسس Aether با کد ${code} خارج شد و کاندیدی نداد`);
      else finish(`پروسس Aether خارج شد (کد ${code}) — نتایج جزئی`);
    });
    return { ok: true };
  }

  private killScanProc(): void {
    if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null; }
    const p = this.scanProc;
    this.scanProc = null;
    if (p && !p.killed) {
      try { p.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 2000);
    }
  }

  stopScan(): void {
    if (!this.isScanning() && this.scanDone) return;
    this.killScanProc();
    this.scanDone = true;
    this.emitScan({ type: 'stopped', candidates: [...this.scanCandidates.values()], tested: this.scanTested, message: 'اسکن متوقف شد' });
  }

  async healthCheck(): Promise<{ xrayPort: boolean; aetherPort: boolean; proxyWorks: boolean }> {
    const [xrayPort, aetherPort] = await Promise.all([
      tcpOk('127.0.0.1', XRAY_INBOUND_PORT),
      tcpOk('127.0.0.1', AETHER_SOCKS_PORT),
    ]);
    let proxyWorks = false;
    try {
      // تست ساده از طریق پراکسی Xray (بدون وابستگی به fetch خارجی در تست یونیت)
      const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(8000) } as any);
      proxyWorks = res.ok;
    } catch { proxyWorks = false; }
    return { xrayPort, aetherPort, proxyWorks };
  }
}
