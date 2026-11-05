// run-electron-dev.mjs — صبر می‌کند تا Vite روی 5173 بالا بیاید، بعد Electron را اجرا می‌کند
// استفاده: npm run dev (از طریق concurrently) — بدون wait-on خارجی
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

async function waitForVite(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch('http://127.0.0.1:5173/');
      if (res.ok) return true;
    } catch { /* هنوز بالا نیامده */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const ok = await waitForVite();
if (!ok) {
  console.error('Vite روی 127.0.0.1:5173 بالا نیامد');
  process.exit(1);
}
const child = spawn(electronBin, ['.'], { cwd: root, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
