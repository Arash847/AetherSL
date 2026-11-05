// main.ts — پروسس اصلی Electron: پنجره، تری، IPC، مدیریت هسته‌ها
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } from 'electron';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreManager, type CoreName } from './core-manager';
import { defaultSettings, expandRuleGroups, type AppSettings, type RuleGroup, type UserRule } from './config-generator';
import { parseRuleFile, parseRuleFileText, userRulesToGroups } from './rules';
import { downloadAllCores, coreExists } from './downloader';
import { clearSystemProxy, setSystemProxy } from './system-proxy';
import { tunPrereqMessage } from './tun';
import { getExitIpReport, interpretWarp } from './ip-check';
import type { ScanOptions } from './scanner';

const isDev = !app.isPackaged;
const userData = app.getPath('userData');
const coresDir = isDev ? join(__dirname, '..', 'cores') : join(process.resourcesPath, 'cores');
const workDir = join(userData, 'runtime');
mkdirSync(workDir, { recursive: true });
mkdirSync(coresDir, { recursive: true });

const rulesPath = join(userData, 'rules.json');
const settingsPath = join(userData, 'settings.json');

function loadJson<T>(p: string, fallback: T): T {
  try { if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8')) as T; } catch {}
  return fallback;
}
function saveJson(p: string, v: unknown) { writeFileSync(p, JSON.stringify(v, null, 2), 'utf-8'); }

let settings: AppSettings = { ...defaultSettings(), ...loadJson<Partial<AppSettings>>(settingsPath, {}) };

/** رول‌های پیش‌فرض = فایل خود کاربر (configs/rules.user.json) — تنها مرجع */
function loadDefaultRuleGroups(): RuleGroup[] {
  const candidates = [
    join(__dirname, '..', 'configs', 'rules.user.json'),
    join(process.resourcesPath, 'configs', 'rules.user.json'),
    join(__dirname, '..', 'configs', 'rules.example.json'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return parseRuleFileText(readFileSync(p, 'utf-8')).rules;
    } catch (e: any) { console.warn(`خواندن رول پیش‌فرض از ${p} ناموفق: ${e.message}`); }
  }
  throw new Error('فایل رول‌های پیش‌فرض (configs/rules.user.json) پیدا نشد');
}

function loadStoredRules(): RuleGroup[] {
  try {
    if (existsSync(rulesPath)) {
      const parsed = JSON.parse(readFileSync(rulesPath, 'utf-8'));
      if (Array.isArray(parsed)) return userRulesToGroups(parsed as UserRule[]); // مهاجرت فرمت قدیمی
      return parseRuleFile(parsed).rules;
    }
  } catch (e: any) { console.warn(`خواندن rules.json ناموفق (${e.message}) — رول‌های پیش‌فرض لود می‌شوند`); }
  const defaults = loadDefaultRuleGroups();
  saveJson(rulesPath, { formatVersion: 1, rules: defaults });
  return defaults;
}

let rules: RuleGroup[] = loadStoredRules();
let connected = false;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
const logs: { core: string; line: string; time: string }[] = [];
const log = (core: CoreName | 'app', line: string) => {
  const entry = { core, line: String(line).slice(0, 2000), time: new Date().toISOString() };
  logs.push(entry);
  if (logs.length > 2000) logs.splice(0, logs.length - 2000);
  win?.webContents.send('aethersl:log', entry);
};
const manager = new CoreManager(coresDir, workDir, log);
manager.onScanEvent((e) => win?.webContents.send('aethersl:scan-event', e));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ری‌استارت هسته Aether با تنظیمات فعلی (مثلاً بعد از انتخاب peer) */
async function restartAether(): Promise<void> {
  manager.stop('aether');
  await sleep(600); // فرصت آزادشدن پورت 1819
  manager.startAether(settings);
  win?.webContents.send('aethersl:status', manager.getAllStates());
}

function baseConfig(profile = settings.serverlessProfile): Record<string, any> {
  // پروفایل پیش‌فرض fragB است؛ سوییچ fragA/fragB/oob از تب تنظیمات
  const fileName =
    profile === 'fragA' ? 'serverless-fragA.base.jsonc'
    : profile === 'oob' ? 'serverless-oob.base.jsonc'
    : 'serverless-fragB.base.jsonc';
  const p = join(__dirname, '..', 'configs', fileName);
  const alt = join(process.resourcesPath, 'configs', fileName);
  const file = existsSync(p) ? p : alt;
  const raw = readFileSync(file, 'utf-8');
  // JSONC ساده: حذف کامنت‌های // و /* */
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return JSON.parse(stripped);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'AetherSL',
    backgroundColor: '#0b0b14',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  if (isDev) win.loadURL('http://127.0.0.1:5173');
  else win.loadFile(join(__dirname, '..', 'dist', 'index.html'));
  win.on('closed', () => { win = null; });
}

function createTray() {
  try {
    const icon = nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setToolTip('AetherSL');
    const menu = Menu.buildFromTemplate([
      { label: 'اتصال', click: () => doConnect() },
      { label: 'قطع اتصال', click: () => doDisconnect() },
      { type: 'separator' },
      { label: 'خروج', click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => win?.show());
  } catch { /* تری اختیاری است */ }
}

async function doConnect(): Promise<{ ok: boolean; error?: string }> {
  if (connected) return { ok: true };
  try {
    const base = baseConfig();
    manager.startXray(base, expandRuleGroups(rules), settings);
    manager.startAether(settings);
    if (settings.tunEnabled) manager.startZeptun(settings);
    if (settings.systemProxyEnabled) await setSystemProxy().catch((e) => log('app', `پراکسی سیستمی: ${e.message}`));
    connected = true;
    log('app', 'متصل شد — Xray روی 10808، Aether روی 1819');
    win?.webContents.send('aethersl:status', manager.getAllStates());
    return { ok: true };
  } catch (e: any) {
    log('app', `خطا در اتصال: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function doDisconnect() {
  manager.stopAll();
  await clearSystemProxy().catch(() => {});
  connected = false;
  log('app', 'قطع شد');
  win?.webContents.send('aethersl:status', manager.getAllStates());
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => { manager.stopAll(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('aethersl:get-state', () => ({ settings, rules, ruleFile: { formatVersion: 1, rules }, connected, scanning: manager.isScanning(), cores: manager.getAllStates(), logs: logs.slice(-300), tunPrereq: tunPrereqMessage(), platform: process.platform }));
ipcMain.handle('aethersl:connect', () => doConnect());
ipcMain.handle('aethersl:disconnect', () => doDisconnect());
ipcMain.handle('aethersl:save-rules', (_e, next: unknown) => {
  // ورودی یا RuleFile کامل است یا آرایه گروه‌ها
  const groups = Array.isArray(next) ? (next as RuleGroup[]) : parseRuleFile(next).rules;
  rules = groups;
  saveJson(rulesPath, { formatVersion: 1, rules });
  return { ok: true };
});
ipcMain.handle('aethersl:load-default-rules', () => { rules = loadDefaultRuleGroups(); saveJson(rulesPath, { formatVersion: 1, rules }); return rules; });
ipcMain.handle('aethersl:save-settings', (_e, next: AppSettings) => { settings = { ...defaultSettings(), ...next }; saveJson(settingsPath, settings); return { ok: true }; });
ipcMain.handle('aethersl:health', () => manager.healthCheck());
// ---------- Endpoint Scanner ----------
ipcMain.handle('aethersl:scan-start', (_e, opts: ScanOptions) => {
  const o: ScanOptions = {
    mode: ['turbo', 'balanced', 'thorough', 'stealth', 'ironclad'].includes(opts?.mode) ? opts.mode : 'balanced',
    ipVersion: ['both', '4', '6'].includes(opts?.ipVersion) ? opts.ipVersion : (settings.aetherIpVersion as ScanOptions['ipVersion']) ?? 'both',
    protocol: ['masque', 'masque-h2', 'wg', 'gool'].includes(opts?.protocol) ? opts.protocol : 'masque',
    fallbackOnly: !!opts?.fallbackOnly,
  };
  return manager.startScan(o, settings);
});
ipcMain.handle('aethersl:scan-stop', () => { manager.stopScan(); return { ok: true }; });
ipcMain.handle('aethersl:scan-use-peer', async (_e, endpoint: string) => {
  const ep = String(endpoint ?? '').trim();
  if (!/^\[?[0-9a-fA-F:.]+\]?:\d+$/.test(ep)) return { ok: false, error: `اندپوینت نامعتبر: ${endpoint}` };
  settings = { ...settings, aetherPeer: ep, aetherQuickReconnect: false, lastGoodEndpoint: ep, lastGoodAt: new Date().toISOString() };
  saveJson(settingsPath, settings);
  log('app', `peer انتخاب شد: ${ep} — Aether ری‌استارت می‌شود`);
  if (connected) await restartAether();
  return { ok: true, settings };
});
ipcMain.handle('aethersl:scan-clear-peer', async () => {
  settings = { ...settings, aetherPeer: '', aetherQuickReconnect: false };
  saveJson(settingsPath, settings);
  log('app', 'peer پاک شد — Aether با اسکن خودکار برمی‌گردد');
  if (connected) await restartAether();
  return { ok: true, settings };
});
ipcMain.handle('aethersl:scan-quick-reconnect', async () => {
  if (!settings.lastGoodEndpoint) return { ok: false, error: 'هنوز اندپوینت خوبی ذخیره نشده — اول یک اسکن بگیر' };
  settings = { ...settings, aetherPeer: settings.lastGoodEndpoint, aetherQuickReconnect: true };
  saveJson(settingsPath, settings);
  log('app', `Quick Reconnect به ${settings.lastGoodEndpoint}`);
  if (connected) await restartAether();
  else await doConnect();
  return { ok: true, settings };
});
ipcMain.handle('aethersl:download-cores', async () => {
  try {
    const res = await downloadAllCores(coresDir, process.platform, process.arch, (s) => log('app', s));
    return { ok: true, cores: res };
  } catch (e: any) {
    return { ok: false, error: `${e.message} — دانلود دستی: https://github.com/patterniha/Xray-core/releases ، https://github.com/CluvexStudio/Aether/releases ، https://github.com/Noisemux/zeptun/releases` };
  }
});
ipcMain.handle('aethersl:cores-status', () => ({
  xray: coreExists(coresDir, 'xray'),
  aether: coreExists(coresDir, 'aether'),
  zeptun: coreExists(coresDir, 'zeptun'),
  coresDir,
}));
ipcMain.handle('aethersl:test-speed', async () => {
  const t0 = Date.now();
  try {
    const res = await fetch('https://speed.cloudflare.com/__down?bytes=1000000', { signal: AbortSignal.timeout(15000) } as any);
    const buf = await res.arrayBuffer();
    const sec = (Date.now() - t0) / 1000;
    return { ok: true, mbps: +((buf.byteLength * 8) / sec / 1e6).toFixed(2), seconds: +sec.toFixed(2) };
  } catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('aethersl:get-ip', async () => {
  // گزارش سه‌مسیره (به electron/ip-check.ts نگاه کن):
  //  مستقیم = IP عادی نت (قبل) | از Xray = مسیر پیش‌فرض فعلی | از Aether = IP تانل + warp.
  // توجه: تازگی‌ها WARP IP ایران می‌دهد (قبلاً آلمان می‌داد) و همان IP نت عادی است؛
  //  پس IP یکسان + warp=on یعنی egress کلادفلر در ایران است، نه نشت.
  try {
    const report = await getExitIpReport();
    const shown = report.viaXray ?? report.viaAether ?? report.direct;
    return {
      ok: true,
      ip: shown?.ip ?? '',
      loc: shown?.loc ?? '',
      country: report.country,
      countryCode: report.countryCode,
      warp: report.viaAether?.warp ?? '',
      warpStatus: interpretWarp(report.direct, report.viaAether),
      direct: report.direct,
      viaXray: report.viaXray,
      viaAether: report.viaAether,
    };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});
