// downloader.ts — دانلود آخرین ریلیز هسته‌ها از گیت‌هاب
// patterniha/Xray-core (فورک Xray با finalmask — برای Serverless اجباری است، نه Xray اصلی)
// CluvexStudio/Aether — Noisemux/zeptun
// باینری‌ها هرگز کامیت نمی‌شوند؛ فقط در cores/<os>-<arch>/ ذخیره می‌شوند.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { chmod, mkdir, rename, stat } from 'node:fs/promises';
import { get } from 'node:https';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

export interface CoreSpec {
  key: 'xray' | 'aether' | 'zeptun';
  repo: string;
  /** تابع انتخاب فایل ریلیز بر اساس سیستم‌عامل و معماری */
  pickAsset: (assets: { name: string; browser_download_url: string }[], os: string, arch: string) => { name: string; browser_download_url: string } | undefined;
  binaryName: (os: string) => string;
}

export const CORE_SPECS: CoreSpec[] = [
  {
    key: 'xray',
    repo: 'patterniha/Xray-core',
    binaryName: (os) => (os === 'win32' ? 'xray.exe' : 'xray'),
    pickAsset: (assets, os, arch) => {
      const want = os === 'win32' ? /^Xray-windows-64\.zip$/i : /^Xray-linux-64\.zip$/i;
      return assets.find((a) => want.test(a.name));
    },
  },
  {
    key: 'aether',
    repo: 'CluvexStudio/Aether',
    binaryName: (os) => (os === 'win32' ? 'aether.exe' : 'aether'),
    pickAsset: (assets, os) => {
      const want = os === 'win32' ? /^aether-windows-x86_64\.zip$/i : /^aether-linux-x86_64\.tar\.gz$/i;
      return assets.find((a) => want.test(a.name));
    },
  },
  {
    key: 'zeptun',
    repo: 'Noisemux/zeptun',
    binaryName: (os) => (os === 'win32' ? 'zeptun.exe' : 'zeptun'),
    pickAsset: (assets, os) => {
      const want = os === 'win32' ? /^zeptun-windows-x86_64\.zip$/i : /^zeptun-linux-x86_64$/i;
      return assets.find((a) => want.test(a.name));
    },
  },
];

function httpsJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    get(url, { headers: { 'User-Agent': 'AetherSL-downloader', Accept: 'application/vnd.github+json' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 300) {
          reject(new Error(`GitHub API ${res.statusCode} برای ${url}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  await mkdir(join(dest, '..'), { recursive: true }).catch(() => {});
  await new Promise<void>((resolve, reject) => {
    get(url, { headers: { 'User-Agent': 'AetherSL-downloader' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`دانلود ناموفق: HTTP ${res.statusCode}`)); return; }
      pipeline(res, createWriteStream(dest)).then(() => resolve()).catch(reject);
    }).on('error', reject);
  });
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(path), hash as any);
  return hash.digest('hex');
}

export interface DownloadResult { key: string; version: string; path: string; url: string }

/** دانلود یک هسته؛ اگر ریلیز/فایل پیدا نشد خطا می‌دهد (نه سکوت) تا UI لینک دستی نشان دهد */
export async function downloadCore(spec: CoreSpec, coresDir: string, os: string, arch: string, onLog?: (s: string) => void): Promise<DownloadResult> {
  const release = await httpsJson(`https://api.github.com/repos/${spec.repo}/releases/latest`);
  const asset = spec.pickAsset(release.assets ?? [], os, arch);
  if (!asset) throw new Error(`فایل مناسب ${spec.key} برای ${os}/${arch} در ریلیز ${release.tag_name} پیدا نشد — از صفحه ریلیز دستی دانلود کنید: https://github.com/${spec.repo}/releases/latest`);
  const dir = join(coresDir, `${os}-${arch}`);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, asset.name);
  onLog?.(`دانلود ${spec.key} ${release.tag_name} …`);
  await downloadFile(asset.browser_download_url, dest);
  onLog?.(`${spec.key} دانلود شد: ${dest}`);
  // فایل‌های zip را همین‌جا باز نمی‌کنیم؛ کاربر/مرحله بعد با unzip آن را باز می‌کند.
  // اگر فایل خود باینری بود، مستقیم قابل اجراست.
  if (os !== 'win32' && !asset.name.endsWith('.zip')) {
    try { await chmod(dest, 0o755); } catch { /* ignore */ }
  }
  return { key: spec.key, version: String(release.tag_name ?? ''), path: dest, url: asset.browser_download_url };
}

export async function downloadAllCores(coresDir: string, os = process.platform, arch = process.arch, onLog?: (s: string) => void): Promise<DownloadResult[]> {
  const out: DownloadResult[] = [];
  for (const spec of CORE_SPECS) {
    try { out.push(await downloadCore(spec, coresDir, os, arch, onLog)); }
    catch (e: any) { onLog?.(`خطا در دانلود ${spec.key}: ${e.message}`); throw e; }
  }
  return out;
}

export function coreBinaryPath(coresDir: string, key: string, os = process.platform, arch = process.arch): string {
  const spec = CORE_SPECS.find((s) => s.key === key)!;
  const p = join(coresDir, `${os}-${arch}`, spec.binaryName(os));
  return p;
}

export function coreExists(coresDir: string, key: string, os = process.platform, arch = process.arch): boolean {
  return existsSync(coreBinaryPath(coresDir, key, os, arch));
}
