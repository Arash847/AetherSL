// system-proxy.ts — تنظیم/حذف پراکسی سیستمی به 127.0.0.1:10808 (Xray)
// ویندوز: رجیستری Internet Settings + اطلاع‌رسانی به سیستم.
// لینوکس: gsettings برای GNOME (اگر موجود بود) + متغیرهای محیطی برای اپ‌های ترمینالی.
// این فقط «پراکسی سیستمی» است؛ TUN جداگانه با Zeptun کار می‌کند.
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
export const PROXY_HOST = '127.0.0.1';
export const PROXY_PORT = 10808;

export async function setSystemProxy(): Promise<void> {
  if (process.platform === 'win32') {
    await execAsync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`);
    await execAsync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d ${PROXY_HOST}:${PROXY_PORT} /f`);
    await execAsync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "localhost;127.0.0.1;<local>" /f`);
    return;
  }
  if (process.platform === 'linux') {
    try {
      await execAsync(`gsettings set org.gnome.system.proxy mode 'manual'`);
      await execAsync(`gsettings set org.gnome.system.proxy.http host '${PROXY_HOST}'`);
      await execAsync(`gsettings set org.gnome.system.proxy.http port ${PROXY_PORT}`);
      await execAsync(`gsettings set org.gnome.system.proxy.socks host '${PROXY_HOST}'`);
      await execAsync(`gsettings set org.gnome.system.proxy.socks port ${PROXY_PORT}`);
    } catch {
      // بدون GNOME فقط متغیر محیطی برای شل باقی می‌ماند؛ در UI اطلاع بده
      process.env.http_proxy = `http://${PROXY_HOST}:${PROXY_PORT}`;
      process.env.https_proxy = `http://${PROXY_HOST}:${PROXY_PORT}`;
    }
    return;
  }
  throw new Error('پراکسی سیستمی روی این سیستم‌عامل پشتیبانی نمی‌شود');
}

export async function clearSystemProxy(): Promise<void> {
  if (process.platform === 'win32') {
    await execAsync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`);
    return;
  }
  if (process.platform === 'linux') {
    try { await execAsync(`gsettings set org.gnome.system.proxy mode 'none'`); } catch {}
    delete process.env.http_proxy;
    delete process.env.https_proxy;
  }
}
