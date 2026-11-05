// tun.ts — کمک‌های TUN / Zeptun
// روی لینوکس: نیاز به sudo یا CAP_NET_ADMIN. روی ویندوز: Wintun + اجرا به‌عنوان Administrator.
import { execSync } from 'node:child_process';

export function isAdminOrRoot(): boolean {
  try {
    if (process.platform === 'win32') {
      execSync('net session', { stdio: 'ignore' });
      return true;
    }
    return typeof process.getuid === 'function' && process.getuid() === 0;
  } catch { return false; }
}

export function tunPrereqMessage(): string {
  if (process.platform === 'win32') {
    return 'ویندوز: برای TUN باید AetherSL را به‌عنوان Administrator اجرا کنید و wintun.dll کنار zeptun.exe باشد.';
  }
  if (process.platform === 'linux') {
    return 'لینوکس: برای TUN به sudo یا CAP_NET_ADMIN نیاز است. مثال: sudo setcap cap_net_admin=+ep ./zeptun — یا اپ را با sudo اجرا کنید.';
  }
  return 'این سیستم‌عامل برای TUN پشتیبانی نمی‌شود.';
}

export function zeptunArgs(configPath: string): string[] {
  return ['run', '-c', configPath];
}
