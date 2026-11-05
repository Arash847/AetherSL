// download-cores.mjs — دانلود آخرین ریلیز هسته‌ها از گیت‌هاب
// استفاده: node scripts/download-cores.mjs [--os win32|linux] [--arch x64]
// باینری‌ها در cores/<os>-<arch>/ ذخیره می‌شوند و هرگز کامیت نمی‌شوند.
// اگر ریلیز/فایل پیدا نشد، لینک دستی چاپ می‌شود و اسکریپت با خطا خارج می‌شود (نه سکوت).
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const os = getArg('--os', process.platform);
const arch = getArg('--arch', process.arch);
const coresDir = join(root, 'cores', `${os}-${arch}`);
mkdirSync(coresDir, { recursive: true });

// نکته (تست واقعی 2026-11-06 روی CachyOS): hintهای کلی قبلی فایل اشتباه
// می‌گرفتند — برای Aether اولین فایل linux یعنی aarch64-musl، و برای Zeptun
// اول libzeptun-*.a (کتابخانه استاتیک) را می‌گرفت، نه باینری zeptun.
// پس همه hintها exact و anchored هستند و .sha256/.dgst را رد می‌کنند.
const REPOS = [
  { key: 'xray', repo: 'patterniha/Xray-core', hint: os === 'win32' ? /^Xray-windows-64\.zip$/i : /^Xray-linux-64\.zip$/i },
  { key: 'aether', repo: 'CluvexStudio/Aether', hint: os === 'win32' ? /^aether-windows-x86_64\.zip$/i : /^aether-linux-x86_64\.tar\.gz$/i },
  { key: 'zeptun', repo: 'Noisemux/zeptun', hint: os === 'win32' ? /^zeptun-windows-x86_64\.zip$/i : /^zeptun-linux-x86_64$/i },
];

async function latestRelease(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'User-Agent': 'AetherSL-downloader', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} برای ${repo}`);
  return res.json();
}

for (const { key, repo, hint } of REPOS) {
  console.log(`\n== ${key} (${repo}) ==`);
  let release;
  try {
    release = await latestRelease(repo);
  } catch (e) {
    console.error(`خطا: ${e.message}\nدانلود دستی: https://github.com/${repo}/releases/latest`);
    process.exitCode = 1;
    continue;
  }
  console.log(`آخرین نسخه: ${release.tag_name}`);
  const asset = (release.assets ?? []).find((a) => hint.test(a.name));
  if (!asset) {
    console.error(`فایل مناسب ${os}/${arch} پیدا نشد. فایل‌های موجود:`);
    for (const a of release.assets ?? []) console.error(`  - ${a.name}`);
    console.error(`دانلود دستی: https://github.com/${repo}/releases/latest`);
    process.exitCode = 1;
    continue;
  }
  const dest = join(coresDir, asset.name);
  console.log(`دانلود ${asset.name} ← ${dest}`);
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'AetherSL-downloader' } });
  if (!res.ok || !res.body) { console.error(`دانلود ناموفق: HTTP ${res.status}`); process.exitCode = 1; continue; }
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  await pipeline(res.body, createWriteStream(dest));
  console.log(`ذخیره شد: ${dest}`);
  if (os !== 'win32' && !asset.name.endsWith('.zip')) {
    const { chmod, copyFile } = await import('node:fs/promises');
    await chmod(dest, 0o755).catch(() => {});
  }
  // zeptun روی لینوکس با اسم zeptun-linux-x86_64 می‌آید، ولی core-manager
  // دنبال باینری با اسم zeptun می‌گردد — یک کپی با اسم درست بگذار.
  if (key === 'zeptun' && os !== 'win32') {
    const { copyFile, chmod } = await import('node:fs/promises');
    await copyFile(dest, join(coresDir, 'zeptun'));
    await chmod(join(coresDir, 'zeptun'), 0o755).catch(() => {});
    console.log('کپی شد به: zeptun');
  }
  // باز کردن خودکار آرشیو تا باینری کنارش قرار گیرد؛ اگر ابزار نبود فقط هشدار می‌دهد.
  if (asset.name.endsWith('.zip') || asset.name.endsWith('.tar.gz')) {
    const { execFile } = await import('node:child_process');
    const run = (cmd, a) => new Promise((res) => execFile(cmd, a, { cwd: coresDir }, (e) => res(!e)));
    const ok = asset.name.endsWith('.zip')
      ? await run('unzip', ['-o', asset.name])
      : await run('tar', ['-xzf', asset.name]);
    if (ok) {
      console.log('باز شد در همین پوشه.');
      // باینری‌های استخراج‌شده روی لینوکس اجرایی شوند
      if (os !== 'win32') {
        const { chmod } = await import('node:fs/promises');
        for (const n of ['xray', 'aether', 'zeptun']) {
          await chmod(join(coresDir, n), 0o755).catch(() => {});
        }
      }
    } else {
      console.log('توجه: باز کردن خودکار آرشیو نشد — دستی بازش کن (unzip / tar -xzf) تا باینری کنارش قرار گیرد.');
    }
  }
}
console.log(`\nتمام شد. پوشه هسته‌ها: ${coresDir}`);
console.log('روی ویندوز: wintun.dll را کنار zeptun.exe بگذار (از https://www.wintun.net).');
