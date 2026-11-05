// App.tsx — رابط کاربری فارسی RTL، تیره، مدرن (glass + گرادیان بنفش/فیروزه‌ای)
// منطق درست modeها (اصلاحیه آرش، 2026-11-05):
//  - Frag (Serverless) = رفع DNS hijacking + fragment برای SNI، با IP واقعی ایرانی.
//    برای سایت‌هایی است که داخل شبکه ایران با DNS hijacking بسته شده‌اند (مثل Discord).
//  - Tunnel (Aether) = عبور از فیلتر ISP؛ ولی خروجی Aether هم فعلاً IP ایران است،
//    پس برای سرویس‌هایی که IP ایران را تحریم/بلاک کرده‌اند (مثل OpenAI و...) راه‌حل نیست.
//    تازگی‌ها WARP/MASQUE IP ایران می‌دهند (قبلاً با همین نت IP آلمان می‌داد) و IP همان
//    IP نت عادی است — فقط فیلترینگ رفع می‌شود. کارت Aether هم IP قبل/بعد و هم warp=on/off
//    را نشان می‌دهد: IP یکسان + warp=on یعنی egress کلادفلر در ایران است؛ warp=off یعنی نشت.
//  - تلگرام: فیلتر ISP — فقط با تانل باز می‌شود، IP ایران مشکلی ندارد.
//    (note قدیمی فایل که می‌گفت «تلگرام IP ایرانی را قبول نمی‌کند» اشتباه بود و اصلاح شد.)
//  - دیسکورد: DNS hijacking — با Frag/DoH درست می‌شود.
//  - Serverless نیازی به UUID ندارد.
import { useEffect, useMemo, useState } from 'react';
import type { AppSettings, CoreState, IpInfo, LogEntry, RuleGroup, RuleMode, RuleTransport, ScanCandidate, ScanEvent, ScanIpVersion, ScanMode, ScanProtocol, TraceInfo } from './types';

const MODE_FA: Record<RuleMode, string> = { frag: 'Frag (Serverless)', tunnel: 'Tunnel (Aether)' };

// توضیح فارسی هر گروه — از note خود فایل رول‌ها + اصلاحیه آرش
const FA_NOTE: Record<string, string> = {
  Discord: 'DNS hijacking — دیسکورد داخل ایران با هایجک DNS بسته شده و با Frag/DoH درست می‌شود؛ آدرس واقعی ایرانی حفظ می‌شود. اگر resolver هنوز EOF بدهد، frag روی این شبکه جواب نمی‌دهد و دیسکورد باید برگردد به تانل.',
  Telegram: 'فیلتر ISP — تلگرام از سمت ISP فیلتر شده و فقط با تانل باز می‌شود؛ IP ایران مشکلی ندارد.',
  Youtube: 'بدون یادداشت در فایل؛ پیش‌فرض تانل (Aether).',
  Downloads: 'بدون یادداشت در فایل؛ دانلود از طریق Frag.',
};

const defaultSettings: AppSettings = {
  mode: 'hybrid', defaultTarget: 'serverless', serverlessProfile: 'fragB',
  aetherProtocol: 'masque', aetherScan: 'balanced', aetherIpVersion: 'both', aetherH2: false, aetherNoize: 'balanced',
  aetherPeer: '', aetherQuickReconnect: false, lastGoodEndpoint: '', lastGoodAt: '',
  tunEnabled: false, systemProxyEnabled: false, tunName: 'zeptun0',
  tunMtu: 8500, tunAddress: '172.19.0.1/30',
  subscriptionUrl: 'https://raw.githubusercontent.com/patterniha/Serverless-for-Iran/refs/heads/main/Subscription/Serverless-for-Iran.json',
};

export const SCAN_MODE_FA: Record<string, string> = {
  turbo: 'turbo — اولین جواب‌دهنده',
  balanced: 'balanced — پیش‌فرض؛ چندتا جمع می‌کند و سریع‌ترین را نگه می‌دارد',
  thorough: 'thorough — کل رنج را می‌گردد',
  stealth: 'stealth — پروب کم',
  ironclad: 'ironclad — تانل کامل + ریکوئست واقعی برای هر کاندید',
};

const isElectron = typeof window !== 'undefined' && !!window.aethersl;

const WARP_FA: Record<string, string> = {
  'warp-on-same-ip': '✅ warp=on است و IP همان IP عادی است — یعنی egress کلادفلر در ایران است؛ فیلترینگ رفع می‌شود ولی IP عوض نشده.',
  'warp-on-different-ip': '✅ warp=on است و IP عوض شده — تانل برقرار است.',
  'warp-off': '⚠️ warp=off است — تانل وصل نشده و ترافیک نشت می‌کند؛ اتصال Aether را چک کن.',
  'no-aether': 'Aether در دسترس نیست (هنوز متصل نشده یا SOCKS 1819 بالا نیامده).',
  unknown: 'وضعیت warp مشخص نیست.',
};

function traceRow(label: string, t: TraceInfo | null | undefined) {
  if (!t || !t.ip) return <p className="text-xs text-slate-500">{label}: — (خوانده نشد)</p>;
  return (
    <p className="text-xs" dir="ltr">
      <span className="font-bold">{label}:</span> {t.ip} · {t.loc || '؟'}
      {t.warp ? <span className={`mr-2 rounded-full px-2 py-0.5 ${t.warp === 'on' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}`}>warp={t.warp}</span> : null}
    </p>
  );
}

export default function App() {
  const [tab, setTab] = useState<'home' | 'rules' | 'scanner' | 'logs' | 'settings'>('home');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [groups, setGroups] = useState<RuleGroup[]>([]);
  const [cores, setCores] = useState<CoreState[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logFilter, setLogFilter] = useState('all');
  const [msg, setMsg] = useState('');
  const [ipInfo, setIpInfo] = useState<IpInfo | null>(null);
  const [ipLoading, setIpLoading] = useState(false);
  const [speed, setSpeed] = useState('');
  const [coresStatus, setCoresStatus] = useState<any>(null);
  const [tunPrereq, setTunPrereq] = useState('');
  const [newDomain, setNewDomain] = useState<Record<string, string>>({});
  const [newGroup, setNewGroup] = useState({ name: '', mode: 'tunnel' as RuleMode, domain: '' });
  // اسکنر اندپوینت
  const [scanMode, setScanMode] = useState<ScanMode>('balanced');
  const [scanIpVersion, setScanIpVersion] = useState<ScanIpVersion>('both');
  const [scanProtocol, setScanProtocol] = useState<ScanProtocol>('masque');
  const [scanning, setScanning] = useState(false);
  const [scanCandidates, setScanCandidates] = useState<ScanCandidate[]>([]);
  const [scanSelected, setScanSelected] = useState('');
  const [scanTested, setScanTested] = useState(0);
  const [scanMsg, setScanMsg] = useState('');
  const [scanSource, setScanSource] = useState('');
  const [scanLines, setScanLines] = useState<string[]>([]);
  const [scanStartedAt, setScanStartedAt] = useState<number | null>(null);
  const [scanElapsed, setScanElapsed] = useState(0);

  useEffect(() => {
    if (!scanning || !scanStartedAt) return;
    const t = setInterval(() => setScanElapsed(Math.floor((Date.now() - scanStartedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [scanning, scanStartedAt]);

  const handleScanEvent = (e: ScanEvent) => {
    if (e.type === 'started') {
      setScanning(true); setScanStartedAt(Date.now()); setScanElapsed(0);
      setScanCandidates([]); setScanSelected(''); setScanTested(0); setScanLines([]);
      setScanMsg(e.message ?? 'در حال اسکن…'); setScanSource('');
    } else if (e.type === 'line') {
      if (e.line) setScanLines((p) => [...p.slice(-49), e.line!]);
    } else if (e.type === 'candidate' && e.candidate) {
      setScanCandidates((p) => {
        const i = p.findIndex((x) => x.endpoint === e.candidate!.endpoint);
        const next = [...p];
        if (i >= 0) next[i] = e.candidate!;
        else next.push(e.candidate!);
        return next.sort((a, b) => (a.selected ? -1 : b.selected ? 1 : (a.latencyMs ?? 999999) - (b.latencyMs ?? 999999)));
      });
      if (e.tested !== undefined) setScanTested(e.tested);
    } else if (e.type === 'selected' && e.selected) {
      setScanSelected(e.selected);
    } else if (e.type === 'progress' && e.message) {
      setScanMsg(e.message);
      if (e.tested !== undefined) setScanTested(e.tested);
    } else if (e.type === 'done') {
      setScanning(false);
      if (e.candidates) setScanCandidates(e.candidates);
      if (e.selected) setScanSelected(e.selected);
      if (e.tested !== undefined) setScanTested(e.tested);
      setScanMsg(e.message ?? 'اسکن تمام شد');
      setScanSource(e.source ?? '');
      if (e.selected) setMsg(`اسکن تمام شد — اندپوینت انتخاب‌شده: ${e.selected}`);
    } else if (e.type === 'stopped') {
      setScanning(false);
      if (e.candidates) setScanCandidates(e.candidates);
      setScanMsg(e.message ?? 'اسکن متوقف شد');
    } else if (e.type === 'error') {
      setScanning(false);
      setScanMsg(e.message ?? 'خطا در اسکن');
    }
  };

  const startScan = async (fallbackOnly = false) => {
    if (!isElectron) { setMsg('اسکن فقط داخل اپ Electron کار می‌کند.'); return; }
    const r = await window.aethersl!.scanStart({ mode: scanMode, ipVersion: scanIpVersion, protocol: scanProtocol, fallbackOnly });
    if (!r.ok) setScanMsg(`خطا در شروع اسکن: ${r.error ?? ''}`);
  };
  const usePeer = async (endpoint: string) => {
    if (!isElectron) return;
    const r = await window.aethersl!.scanUsePeer(endpoint);
    if (r.ok && r.settings) {
      setSettings({ ...defaultSettings, ...r.settings });
      setMsg(`peer ذخیره شد: ${endpoint} — Aether با آن ری‌استارت شد ✅`);
    } else setMsg(`خطا: ${r.error ?? ''}`);
  };
  const clearPeer = async () => {
    if (!isElectron) return;
    const r = await window.aethersl!.scanClearPeer();
    if (r.ok && r.settings) { setSettings({ ...defaultSettings, ...r.settings }); setMsg('peer پاک شد — Aether با اسکن خودکار برمی‌گردد.'); }
  };
  const quickReconnect = async () => {
    if (!isElectron) return;
    const r = await window.aethersl!.scanQuickReconnect();
    if (r.ok && r.settings) {
      setSettings({ ...defaultSettings, ...r.settings });
      setConnected(true);
      setMsg(`Quick Reconnect به ${r.settings.lastGoodEndpoint} ✅`);
    } else setMsg(`خطا: ${r.error ?? ''}`);
  };

  const fetchIp = async () => {
    if (!isElectron) return;
    setIpLoading(true);
    try {
      const r = await window.aethersl!.getIp();
      if (r.ok) {
        setIpInfo({
          ip: r.ip ?? '', loc: r.loc ?? '', country: r.country ?? '', countryCode: r.countryCode ?? '',
          warp: r.warp ?? '', warpStatus: r.warpStatus ?? 'unknown',
          direct: r.direct ?? null, viaXray: r.viaXray ?? null, viaAether: r.viaAether ?? null,
        });
      } else setMsg(`IP خروجی خوانده نشد: ${r.error ?? ''}`);
    } finally { setIpLoading(false); }
  };

  useEffect(() => {
    if (!isElectron) { setMsg('در حالت مرورگر (بدون Electron) هستید — برای اتصال واقعی، اپ را با npm run dev اجرا کنید.'); return; }
    window.aethersl!.getState().then((s: any) => {
      if (s.settings) setSettings({ ...defaultSettings, ...s.settings });
      if (s.rules) setGroups(s.rules);
      else if (s.ruleFile?.rules) setGroups(s.ruleFile.rules);
      setConnected(!!s.connected);
      setCores(s.cores ?? []);
      setLogs(s.logs ?? []);
      setTunPrereq(s.tunPrereq ?? '');
    }).catch(() => {});
    window.aethersl!.coresStatus().then(setCoresStatus).catch(() => {});
    window.aethersl!.onLog((e) => setLogs((p) => [...p.slice(-499), e]));
    window.aethersl!.onStatus((s) => setCores(s));
    window.aethersl!.onScanEvent(handleScanEvent);
  }, []);

  const saveSettings = (next: AppSettings) => {
    setSettings(next);
    if (isElectron) window.aethersl!.saveSettings(next).catch(() => {});
  };
  const saveGroups = (next: RuleGroup[]) => {
    setGroups(next);
    if (isElectron) window.aethersl!.saveRules({ formatVersion: 1, rules: next }).catch(() => {});
  };

  const hasFrag = useMemo(() => groups.some((g) => g.enabled && g.mode === 'frag'), [groups]);

  const toggleConnect = async () => {
    if (!isElectron) { setMsg('اتصال فقط داخل اپ Electron کار می‌کند.'); return; }
    setBusy(true); setMsg('');
    try {
      if (!connected) {
        const r = await window.aethersl!.connect();
        if (r.ok) { setConnected(true); setMsg('متصل شد ✅ — Xray روی 10808، Aether روی 1819'); fetchIp(); }
        else setMsg(`خطا در اتصال: ${r.error ?? ''}`);
      } else {
        await window.aethersl!.disconnect();
        setConnected(false); setMsg('قطع شد.');
      }
    } finally { setBusy(false); }
  };

  const core = (name: string) => cores.find((c) => c.name === name);
  const statusBadge = (s?: string) => s === 'running' ? '🟢 در حال اجرا' : s === 'starting' ? '🟡 در حال شروع…' : s === 'error' ? '🔴 خطا' : '⚪ متوقف';
  const filteredLogs = useMemo(() => logFilter === 'all' ? logs : logs.filter((l) => l.core === logFilter), [logs, logFilter]);

  const toggleMode = (name: string) => saveGroups(groups.map((g) => g.name === name ? { ...g, mode: g.mode === 'frag' ? 'tunnel' : 'frag' } : g));
  const addDomain = (name: string) => {
    const d = (newDomain[name] ?? '').trim().toLowerCase();
    if (!d) return;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) { setMsg(`دامنه نامعتبر: ${d}`); return; }
    saveGroups(groups.map((g) => g.name === name
      ? { ...g, domains: g.domains.includes(d) ? g.domains : [...g.domains, d] }
      : g));
    setNewDomain({ ...newDomain, [name]: '' });
  };
  const removeDomain = (name: string, domain: string) => saveGroups(groups.map((g) => g.name === name ? { ...g, domains: g.domains.filter((x) => x !== domain) } : g));
  const addGroup = () => {
    if (!newGroup.name.trim() || !newGroup.domain.trim()) { setMsg('نام گروه و حداقل یک دامنه را وارد کن.'); return; }
    if (groups.some((g) => g.name === newGroup.name.trim())) { setMsg('گروهی با این نام از قبل هست.'); return; }
    saveGroups([...groups, { name: newGroup.name.trim(), mode: newGroup.mode, transport: 'both', enabled: true, domains: [newGroup.domain.trim().toLowerCase()] }]);
    setNewGroup({ name: '', mode: 'tunnel', domain: '' });
  };
  const exportRules = () => {
    const blob = new Blob([JSON.stringify({ formatVersion: 1, rules: groups }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'aethersl-rules.json'; a.click();
  };
  const importRules = (f: File) => {
    f.text().then((t) => {
      try {
        const j = JSON.parse(t);
        if (j.formatVersion !== 1 || !Array.isArray(j.rules)) { setMsg('فرمت فایل معتبر نیست — باید formatVersion: 1 و rules داشته باشد.'); return; }
        saveGroups(j.rules); setMsg('رول‌ها ایمپورت شد ✅');
      } catch { setMsg('فایل JSON معتبر نیست.'); }
    });
  };

  const isIranExit = !!ipInfo && (ipInfo.viaAether?.loc === 'IR' || ipInfo.countryCode === 'IR' || ipInfo.loc === 'IR');

  return (
    <div className="min-h-screen bg-[#0b0b14] text-slate-100" dir="rtl">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-[#0b0b14]/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div>
            <h1 className="bg-gradient-to-l from-violet-400 to-cyan-300 bg-clip-text text-2xl font-black text-transparent">AetherSL ⚡</h1>
            <p className="text-xs text-slate-400">Aether + Serverless-for-Iran — همزمان، با رول‌های خودت</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-3 py-1 text-xs ${connected ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/10 text-slate-300'}`}>{connected ? '● متصل' : '○ قطع'}</span>
            <span className="rounded-full bg-white/10 px-3 py-1 text-xs">Xray :10808 · Aether :1819</span>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-2 px-4 pb-3">
          {([['home', '🏠 اصلی'], ['rules', '📋 رول‌ها'], ['scanner', '🔍 اسکنر اندپوینت'], ['logs', '📜 لاگ'], ['settings', '⚙️ تنظیمات']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded-xl px-4 py-2 text-sm ${tab === k ? 'bg-violet-600 text-white' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>{label}</button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-5">
        {msg && <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm">{msg}</div>}

        {tab === 'home' && (
          <>
            <section className="rounded-3xl border border-white/10 bg-gradient-to-l from-violet-600/25 via-white/5 to-cyan-500/20 p-6 text-center shadow-2xl">
              <button disabled={busy} onClick={toggleConnect} className={`mx-auto block rounded-full px-12 py-4 text-xl font-black shadow-lg transition ${connected ? 'bg-rose-500 hover:bg-rose-600' : 'bg-gradient-to-l from-violet-500 to-cyan-400 hover:opacity-90'}`}>
                {busy ? '…صبر کن' : connected ? '⏹ قطع اتصال' : '▶ اتصال'}
              </button>
              <p className="mt-3 text-sm text-slate-300">هر دو هسته همیشه بالا می‌مانند تا سوییچ بین حالت‌ها فوری باشد.</p>
              <div className="mx-auto mt-4 flex max-w-lg justify-center gap-2">
                {(['hybrid', 'serverless-only', 'aether-only'] as const).map((m) => (
                  <button key={m} onClick={() => saveSettings({ ...settings, mode: m })} className={`rounded-full px-4 py-2 text-sm ${settings.mode === m ? 'bg-white text-slate-900 font-bold' : 'bg-white/10'}`}>
                    {m === 'hybrid' ? '🔀 Hybrid' : m === 'serverless-only' ? '🧩 فقط Serverless' : '☁️ فقط Aether'}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-400">پیش‌فرض در Hybrid: <b>{settings.defaultTarget === 'aether' ? 'Aether' : settings.defaultTarget === 'direct' ? 'مستقیم' : 'Serverless'}</b> — از تب تنظیمات عوضش کن.</p>
            </section>

            <section className="rounded-2xl border border-white/10 bg-white/5 p-5 text-sm leading-6">
              <h2 className="font-bold">دو mode یعنی چه؟</h2>
              <p className="mt-2">🧩 <b>Frag (Serverless)</b> — رفع DNS hijacking + fragment برای SNI، با <b>IP واقعی ایرانی</b>. برای سایت‌هایی که داخل شبکه ایران با DNS hijacking بسته شده‌اند (مثل Discord).</p>
              <p className="mt-1">☁️ <b>Tunnel (Aether)</b> — عبور از <b>فیلتر ISP</b>؛ ولی خروجی Aether هم فعلاً <b>IP ایران</b> است — برای سرویس‌هایی که IP ایران را تحریم/بلاک کرده‌اند (مثل OpenAI و...) جواب نمی‌دهد.</p>
            </section>

            <section className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <h2 className="text-lg font-bold">☁️ Aether <span className="text-xs text-slate-400">(WARP / MASQUE)</span></h2>
                <p className="mt-1 text-sm">{statusBadge(core('aether')?.status)} · SOCKS5 روی 127.0.0.1:1819 · uptime: {core('aether')?.uptimeSec ?? 0} ثانیه</p>
                <div className="mt-3 rounded-xl bg-black/40 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold">🌍 IP خروجی — قبل / بعد</span>
                    <button className="rounded-lg bg-white/10 px-3 py-1 text-xs" onClick={fetchIp} disabled={ipLoading}>{ipLoading ? '…' : '🔄 تازه‌سازی'}</button>
                  </div>
                  {ipInfo ? (
                    <div className="mt-2 space-y-1.5">
                      {traceRow('بدون تانل (مستقیم)', ipInfo.direct)}
                      {traceRow('با Aether (SOCKS :1819)', ipInfo.viaAether)}
                      {traceRow('از مسیر پیش‌فرض Xray (:10808)', ipInfo.viaXray)}
                      <p className="pt-1 text-xs leading-5 text-slate-300">{WARP_FA[ipInfo.warpStatus] ?? WARP_FA.unknown}</p>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-slate-400">هنوز خوانده نشده — بعد از اتصال خودکار خوانده می‌شود، یا دکمه تازه‌سازی را بزن.</p>
                  )}
                  {isIranExit && (
                    <p className="mt-2 rounded-lg bg-white/5 p-2 text-xs leading-5 text-slate-300">ℹ️ خروجی Aether: ایران — سایت‌هایی که از خارجِ ایران را تحریم کرده‌اند با این IP کار نمی‌کنند. برای آرش مهم نیست؛ فقط اطلاع‌رسانی است.</p>
                  )}
                  {ipInfo && !isIranExit && ipInfo.viaAether?.ip && (
                    <p className="mt-2 rounded-lg bg-emerald-500/10 p-2 text-xs text-emerald-200">خروجی Aether: {ipInfo.viaAether.loc || ipInfo.country || '؟'} — ایران نیست.</p>
                  )}
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-400">تازگی‌ها WARP/MASQUE با همین نت ایران IP ایران می‌دهد (قبلاً IP آلمان می‌داد)؛ IP همان IP نت عادی است — فقط فیلترینگ رفع می‌شود. پروتکل: {settings.aetherProtocol} · scan: {settings.aetherScan} · noize: {settings.aetherNoize}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <h2 className="text-lg font-bold">🧩 Serverless <span className="text-xs text-slate-400">(Xray fragment — بدون سرور)</span></h2>
                <p className="mt-1 text-sm">{statusBadge(core('xray')?.status)} · mixed روی 127.0.0.1:10808 · uptime: {core('xray')?.uptimeSec ?? 0} ثانیه</p>
                <p className="mt-2 rounded-lg bg-cyan-500/10 p-2 text-xs leading-5 text-cyan-200">🧩 Frag مشکل را از راه DNS / DoH حل می‌کند: وقتی سایتی داخل شبکه ایران با DNS hijacking بسته شده (مثل Discord)، با Serverless درست می‌شود. IP واقعی ایرانی حفظ می‌شود و نیازی به UUID ندارد.</p>
                <p className="mt-1 text-xs text-slate-400">پروفایل: {settings.serverlessProfile} (fragB پیش‌فرض) · هسته: patterniha/Xray-core (فورک با finalmask)</p>
              </div>
            </section>

            <section className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <h3 className="font-bold">🌐 TUN (Zeptun) و پراکسی سیستمی</h3>
                <label className="mt-3 flex items-center justify-between text-sm">TUN (همه ترافیک سیستم از Xray رد می‌شود)
                  <input type="checkbox" checked={settings.tunEnabled} onChange={(e) => saveSettings({ ...settings, tunEnabled: e.target.checked })} className="h-5 w-5 accent-violet-500" />
                </label>
                <label className="mt-2 flex items-center justify-between text-sm">پراکسی سیستمی (127.0.0.1:10808)
                  <input type="checkbox" checked={settings.systemProxyEnabled} onChange={(e) => saveSettings({ ...settings, systemProxyEnabled: e.target.checked })} className="h-5 w-5 accent-violet-500" />
                </label>
                <p className="mt-3 text-xs leading-5 text-slate-400">{tunPrereq || 'TUN روی لینوکس به sudo/CAP_NET_ADMIN و روی ویندوز به Administrator + Wintun نیاز دارد.'}</p>
                <p className="mt-1 text-xs text-slate-400">وضعیت Zeptun: {statusBadge(core('zeptun')?.status)}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <h3 className="font-bold">🔍 تست اتصال</h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className="rounded-xl bg-white/10 px-4 py-2 text-sm" onClick={fetchIp}>نمایش IP خروجی</button>
                  <button className="rounded-xl bg-white/10 px-4 py-2 text-sm" onClick={async () => { if (!isElectron) return; setSpeed('در حال تست…'); const r = await window.aethersl!.testSpeed(); setSpeed(r.ok ? `سرعت دانلود: ${r.mbps} Mbps در ${r.seconds} ثانیه` : `خطا: ${r.error}`); }}>تست سرعت</button>
                  <button className="rounded-xl bg-white/10 px-4 py-2 text-sm" onClick={async () => { if (!isElectron) return; const r = await window.aethersl!.health(); setMsg(`Health — Xray:10808 ${r.xrayPort ? '✅' : '❌'} · Aether:1819 ${r.aetherPort ? '✅' : '❌'} · اینترنت از پراکسی ${r.proxyWorks ? '✅' : '❌'}`); }}>Health-check</button>
                </div>
                {ipInfo && <p className="mt-3 text-sm text-cyan-200" dir="ltr">{ipInfo.ip} — {ipInfo.country || ipInfo.loc}</p>}
                {speed && <p className="mt-2 text-sm">{speed}</p>}
                <p className="mt-3 text-xs text-slate-400">هسته‌ها: {coresStatus ? `xray ${coresStatus.xray ? '✅' : '❌'} · aether ${coresStatus.aether ? '✅' : '❌'} · zeptun ${coresStatus.zeptun ? '✅' : '❌'}` : '…'}</p>
                <button className="mt-2 rounded-xl bg-violet-600 px-4 py-2 text-sm" onClick={async () => { if (!isElectron) return; setMsg('در حال دانلود هسته‌ها از گیت‌هاب…'); const r = await window.aethersl!.downloadCores(); setMsg(r.ok ? 'هسته‌ها دانلود شدند ✅' : `خطا: ${r.error}`); }}>⬇ دانلود هسته‌ها</button>
              </div>
            </section>
          </>
        )}

        {tab === 'rules' && (
          <section className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <h2 className="text-lg font-bold">📋 گروه‌های رول — مرجع: فایل خودت (Discord / Telegram / Youtube / Downloads)</h2>
              <p className="mt-1 text-xs leading-5 text-slate-400">ترتیب گروه‌ها = اولویت (first-match wins)؛ بعد از بلاک تبلیغات و قبل از دامنه‌های داخلی Serverless. transport روی «both» یعنی tcp+udp هر دو به همان مقصد می‌روند.</p>
              <p className="mt-2 rounded-lg bg-white/5 p-2 text-xs">رول no-filter-dns: {hasFrag ? '🟢 فعال — چون حداقل یک گروه frag فعال است، به tcp-fragment-tls می‌رود (DoH فرانت‌شده outbound محافظت‌شده می‌گیرد).' : '⚪ غیرفعال — هیچ گروه frag فعالی نیست.'}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="rounded-xl bg-violet-600 px-4 py-2 text-sm" onClick={async () => { if (!isElectron) return; const r = await window.aethersl!.loadDefaultRules(); setGroups(r); setMsg('رول‌های پیش‌فرض (فایل خودت) بارگذاری شد.'); }}>بارگذاری رول‌های پیش‌فرض</button>
                <button className="rounded-xl bg-white/10 px-4 py-2 text-sm" onClick={exportRules}>⬇ اکسپورت JSON</button>
                <label className="cursor-pointer rounded-xl bg-white/10 px-4 py-2 text-sm">⬆ ایمپورت JSON<input type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importRules(f); }} /></label>
              </div>
            </div>

            {groups.map((g) => (
              <div key={g.name} className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <input type="checkbox" checked={g.enabled} title="فعال / غیرفعال" onChange={(e) => saveGroups(groups.map((x) => x.name === g.name ? { ...x, enabled: e.target.checked } : x))} className="h-5 w-5 accent-violet-500" />
                    <h3 className="text-lg font-bold">{g.name}</h3>
                    <span className="rounded-full bg-white/10 px-2 py-1 text-xs">{g.domains.length} دامنه</span>
                    <span className="rounded-full bg-white/10 px-2 py-1 text-xs">transport: {g.transport}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => toggleMode(g.name)} title="تغییر mode با یک کلیک" className={`rounded-full px-4 py-2 text-sm font-bold ${g.mode === 'frag' ? 'bg-cyan-500/20 text-cyan-200' : 'bg-violet-500/25 text-violet-200'}`}>
                      {MODE_FA[g.mode]} ⇄
                    </button>
                    <select className="rounded-xl bg-black/40 px-2 py-2 text-xs" value={g.transport} onChange={(e) => saveGroups(groups.map((x) => x.name === g.name ? { ...x, transport: e.target.value as RuleTransport } : x))}>
                      <option value="both">both (tcp+udp)</option>
                      <option value="tcp">tcp</option>
                      <option value="udp">udp</option>
                    </select>
                    <button className="rounded bg-rose-500/20 px-3 py-2 text-xs text-rose-300" onClick={() => saveGroups(groups.filter((x) => x.name !== g.name))}>حذف گروه</button>
                  </div>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-300">{FA_NOTE[g.name] ?? g.note ?? 'بدون توضیح.'}</p>
                {g.note && <p className="mt-1 text-xs leading-5 text-slate-500" dir="ltr">{g.note}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {g.domains.map((d) => (
                    <span key={d} className="flex items-center gap-1 rounded-full bg-black/40 px-3 py-1 font-mono text-xs" dir="ltr">{d}
                      <button className="text-rose-300" onClick={() => removeDomain(g.name, d)}>×</button>
                    </span>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <input className="flex-1 rounded-xl bg-black/40 px-3 py-2 text-sm" placeholder="افزودن دامنه به گروه — مثلاً example.com" value={newDomain[g.name] ?? ''} onChange={(e) => setNewDomain({ ...newDomain, [g.name]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') addDomain(g.name); }} dir="ltr" />
                  <button className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold" onClick={() => addDomain(g.name)}>＋ افزودن دامنه</button>
                </div>
              </div>
            ))}
            {groups.length === 0 && <p className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center text-slate-400">هنوز گروهی نداری — یکی بساز یا «بارگذاری رول‌های پیش‌فرض» را بزن.</p>}

            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <h3 className="font-bold">＋ گروه جدید</h3>
              <div className="mt-3 grid gap-2 md:grid-cols-4">
                <input className="rounded-xl bg-black/40 px-3 py-2 text-sm" placeholder="نام گروه" value={newGroup.name} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} />
                <select className="rounded-xl bg-black/40 px-3 py-2 text-sm" value={newGroup.mode} onChange={(e) => setNewGroup({ ...newGroup, mode: e.target.value as RuleMode })}>
                  <option value="tunnel">Tunnel (Aether)</option>
                  <option value="frag">Frag (Serverless)</option>
                </select>
                <input className="rounded-xl bg-black/40 px-3 py-2 text-sm" placeholder="اولین دامنه" value={newGroup.domain} onChange={(e) => setNewGroup({ ...newGroup, domain: e.target.value })} dir="ltr" />
                <button className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold" onClick={addGroup}>افزودن گروه</button>
              </div>
            </div>
          </section>
        )}

        {tab === 'scanner' && (
          <section className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <h2 className="text-lg font-bold">🔍 اسکنر اندپوینت Aether</h2>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                Aether دستور scan جداگانه ندارد؛ اسکن موقع استارت اتفاق می‌افتد. اسکنر یک پروسس جداگانه Aether را با فلگ‌های اسکن اجرا می‌کند
                (روی پورت 1820 تا با هسته اصلی روی 1819 تداخل نکند)، لاگ را زنده parse می‌کند و کاندیدها را نشان می‌دهد.
                handshake به‌تنهایی کافی نیست — کاندید باید data-plane را هم پاس کند.
              </p>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <label className="text-sm">Scan mode
                  <select className="mt-1 w-full rounded-xl bg-black/40 px-3 py-2" value={scanMode} onChange={(e) => { setScanMode(e.target.value as ScanMode); saveSettings({ ...settings, aetherScan: e.target.value }); }}>
                    {Object.entries(SCAN_MODE_FA).map(([v, fa]) => <option key={v} value={v}>{fa}</option>)}
                  </select>
                </label>
                <label className="text-sm">IP version
                  <select className="mt-1 w-full rounded-xl bg-black/40 px-3 py-2" value={scanIpVersion} onChange={(e) => { setScanIpVersion(e.target.value as ScanIpVersion); saveSettings({ ...settings, aetherIpVersion: e.target.value }); }}>
                    <option value="both">هر دو (بدون فلگ -4/-6)</option>
                    <option value="4">فقط IPv4 (-4)</option>
                    <option value="6">فقط IPv6 (-6)</option>
                  </select>
                </label>
                <label className="text-sm">پروتکل
                  <select className="mt-1 w-full rounded-xl bg-black/40 px-3 py-2" value={scanProtocol} onChange={(e) => setScanProtocol(e.target.value as ScanProtocol)}>
                    <option value="masque">masque (HTTP/3)</option>
                    <option value="masque-h2">masque --h2 (HTTP/2 روی TCP 443)</option>
                    <option value="wg">wg (WireGuard روی UDP 2408)</option>
                    <option value="gool">gool (WireGuard روی MASQUE)</option>
                  </select>
                </label>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button disabled={scanning} onClick={() => startScan(false)} className="rounded-xl bg-gradient-to-l from-violet-500 to-cyan-400 px-5 py-2 text-sm font-bold disabled:opacity-50">▶ شروع اسکن</button>
                <button disabled={!scanning} onClick={() => window.aethersl!.scanStop()} className="rounded-xl bg-rose-500 px-5 py-2 text-sm font-bold disabled:opacity-50">⏹ توقف اسکن</button>
                <button disabled={scanning} onClick={() => startScan(false)} className="rounded-xl bg-white/10 px-5 py-2 text-sm">🔄 اسکن دوباره</button>
                <button disabled={scanning} onClick={() => startScan(true)} title="بدون اجرای Aether — پروب مستقیم رنج‌های WARP" className="rounded-xl bg-white/10 px-5 py-2 text-sm">🧪 فقط fallback probe</button>
              </div>
              <p className="mt-3 text-sm">
                {scanning
                  ? <>⏳ در حال اسکن… — {scanTested} کاندید تست شد · {scanElapsed} ثانیه گذشته</>
                  : scanMsg || 'هنوز اسکنی انجام نشده.'}
                {scanSource ? <span className="mr-2 rounded-full bg-white/10 px-2 py-0.5 text-xs">منبع: {scanSource === 'fallback-probe' ? 'fallback probe' : 'لاگ Aether'}</span> : null}
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <h3 className="font-bold">⭐ آخرین اندپوینت خوب (last known-good)</h3>
                {settings.lastGoodEndpoint ? (
                  <>
                    <p className="mt-2 font-mono text-sm" dir="ltr">{settings.lastGoodEndpoint}</p>
                    <p className="mt-1 text-xs text-slate-400">ذخیره‌شده: {settings.lastGoodAt ? new Date(settings.lastGoodAt).toLocaleString('fa-IR') : '—'}</p>
                    <div className="mt-3 flex gap-2">
                      <button className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold" onClick={quickReconnect}>⚡ Quick Reconnect</button>
                    </div>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-slate-400">هنوز اندپوینتی ذخیره نشده — بعد از اولین اسکن موفق، اینجا می‌آید.</p>
                )}
                <p className="mt-3 text-xs leading-5 text-slate-400">
                  peer فعلی: <span className="font-mono" dir="ltr">{settings.aetherPeer || '— (اسکن خودکار)'}</span>
                  {settings.aetherQuickReconnect ? ' · quick-reconnect فعال است' : ''}
                </p>
                {settings.aetherPeer && (
                  <button className="mt-2 rounded-xl bg-white/10 px-4 py-2 text-sm" onClick={clearPeer}>🗑 پاک کردن peer (برگشت به اسکن خودکار)</button>
                )}
                <p className="mt-3 text-xs leading-5 text-slate-400">
                  peer دستی کی به درد می‌خورد؟ وقتی اسکن خودکار کند است یا یک IP خاص خوب جواب می‌دهد —
                  آن را با «استفاده از این اندپوینت» قفل کن؛ اگر خراب شد، peer را پاک کن تا اسکن خودکار برگردد.
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <h3 className="font-bold">📜 لاگ زنده اسکن</h3>
                <pre className="mt-3 max-h-48 overflow-auto rounded-xl bg-black/60 p-3 text-xs leading-5" dir="ltr">{scanLines.join('\n') || '—'}</pre>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-white/10">
              <table className="w-full text-sm">
                <thead><tr className="bg-white/5 text-slate-300"><th className="p-3 text-right">اندپوینت</th><th className="p-3 text-right">وضعیت</th><th className="p-3 text-right">تاخیر</th><th className="p-3 text-right">منبع</th><th className="p-3">عملیات</th></tr></thead>
                <tbody>
                  {scanCandidates.map((c) => (
                    <tr key={c.endpoint} className={`border-t border-white/5 ${c.endpoint === scanSelected ? 'bg-emerald-500/10' : ''}`}>
                      <td className="p-3 font-mono text-xs" dir="ltr">{c.endpoint}{c.endpoint === scanSelected ? ' ⭐' : ''}</td>
                      <td className="p-3">{c.status === 'ok' ? '🟢 ok' : c.status === 'failed' ? '🔴 failed' : c.status === 'cooldown' ? '🟡 cooldown' : '⏳ testing'}</td>
                      <td className="p-3" dir="ltr">{c.latencyMs !== undefined ? `${c.latencyMs} ms` : '—'}</td>
                      <td className="p-3 text-xs text-slate-400">{c.source === 'fallback-probe' ? 'fallback probe' : 'لاگ Aether'}</td>
                      <td className="p-3">
                        <button disabled={c.status !== 'ok'} onClick={() => usePeer(c.endpoint)} className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-bold disabled:opacity-40">استفاده از این اندپوینت</button>
                      </td>
                    </tr>
                  ))}
                  {scanCandidates.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-slate-400">هنوز کاندیدی نیست — «شروع اسکن» را بزن.</td></tr>}
                </tbody>
              </table>
              <p className="border-t border-white/5 p-3 text-xs leading-5 text-slate-500">
                نکته fallback probe: اندپوینت‌های WARP سرویس UDP هستند و به پروب بدون handshake جواب نمی‌دهند؛
                پس «ok» در fallback فقط یعنی پورت در دسترس است، نه اینکه تانل حتماً کار می‌کند — اعتبارسنجی واقعی همان data-plane خود Aether است.
                اندپوینتی که تازه fail شده روی cooldown می‌ماند تا اسکن بعدی دوباره سراغش نرود.
              </p>
            </div>
          </section>
        )}

        {tab === 'logs' && (
          <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="flex gap-2">
              {(['all', 'xray', 'aether', 'zeptun', 'app'] as const).map((f) => (
                <button key={f} onClick={() => setLogFilter(f)} className={`rounded-full px-3 py-1 text-xs ${logFilter === f ? 'bg-violet-600' : 'bg-white/10'}`}>{f === 'all' ? 'همه' : f}</button>
              ))}
            </div>
            <pre className="mt-4 max-h-[60vh] overflow-auto rounded-xl bg-black/60 p-4 text-xs leading-5" dir="ltr">{filteredLogs.map((l) => `[${l.time}] [${l.core}] ${l.line}`).join('\n') || 'هنوز لاگی نیست.'}</pre>
          </section>
        )}

        {tab === 'settings' && (
          <section className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <h2 className="font-bold">☁️ تنظیمات Aether</h2>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="text-sm">پروتکل<select className="mt-1 w-full rounded-xl bg-black/40 px-3 py-2" value={settings.aetherProtocol} onChange={(e) => saveSettings({ ...settings, aetherProtocol: e.target.value as any })}><option value="masque">MASQUE (HTTP/3)</option><option value="wireguard">WireGuard</option><option value="gool">GOOL</option><option value="mim">MIM</option></select></label>
                <label className="text-sm">اسکن (scan)<select className="mt-1 w-full rounded-xl bg-black/40 px-3 py-2" value={settings.aetherScan} onChange={(e) => saveSettings({ ...settings, aetherScan: e.target.value })}><option value="turbo">turbo</option><option value="balanced">balanced</option><option value="thorough">thorough</option><option value="stealth">stealth</option><option value="ironclad">ironclad</option></select></label>
                <label className="text-sm">IP version<select className="mt-1 w-full rounded-xl bg-black/40 px-3 py-2" value={settings.aetherIpVersion} onChange={(e) => saveSettings({ ...settings, aetherIpVersion: e.target.value })}><option value="both">هر دو</option><option value="4">فقط IPv4 (-4)</option><option value="6">فقط IPv6 (-6)</option></select></label>
                <label className="text-sm">Noize<select className="mt-1 w-full rounded-xl bg-black/40 px-3 py-2" value={settings.aetherNoize} onChange={(e) => saveSettings({ ...settings, aetherNoize: e.target.value })}><option value="off">off</option><option value="light">light</option><option value="balanced">balanced</option><option value="aggressive">aggressive</option></select></label>
                <label className="text-sm">Peer (اختیاری)<input className="mt-1 w-full rounded-xl bg-black/40 px-3 py-2" value={settings.aetherPeer} onChange={(e) => saveSettings({ ...settings, aetherPeer: e.target.value })} dir="ltr" placeholder="مثال: 162.159.192.1:2408" /></label>
                <label className="flex items-center gap-2 text-sm">HTTP/2 (h2)<input type="checkbox" checked={settings.aetherH2} onChange={(e) => saveSettings({ ...settings, aetherH2: e.target.checked })} className="h-5 w-5 accent-violet-500" /></label>
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <h2 className="font-bold">🧩 تنظیمات Serverless</h2>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="text-sm">پروفایل<select className="mt-1 w-full rounded-xl bg-black/40 px-3 py-2" value={settings.serverlessProfile} onChange={(e) => saveSettings({ ...settings, serverlessProfile: e.target.value })}><option value="fragB">fragB (پیش‌فرض)</option><option value="fragA">fragA</option><option value="oob">oob</option></select></label>
                <label className="text-sm">مقصد پیش‌فرض (catch-all)<select className="mt-1 w-full rounded-xl bg-black/40 px-3 py-2" value={settings.defaultTarget} onChange={(e) => saveSettings({ ...settings, defaultTarget: e.target.value as any })}><option value="serverless">Serverless (Fragment)</option><option value="aether">Aether</option><option value="direct">مستقیم</option></select></label>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-400">fragB پیش‌فرض است (طبق note دیسکورد). fragA و fragB فقط در دو خط fragment lengths فرق دارند: fragA ‎["6", "99", "1"]‎ و fragB ‎["0", "105", "1"]‎. پروفایل oob یک outbound اضافه «tcp-oob» دارد.</p>
              <label className="mt-3 block text-sm">لینک سابسکریپشن Serverless<input className="mt-1 w-full rounded-xl bg-black/40 px-3 py-2 text-xs" value={settings.subscriptionUrl} onChange={(e) => saveSettings({ ...settings, subscriptionUrl: e.target.value })} dir="ltr" /></label>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <h2 className="font-bold">🌐 TUN</h2>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <label className="text-sm">نام اینترفیس<input className="mt-1 w-full rounded-xl bg-black/40 px-3 py-2" value={settings.tunName} onChange={(e) => saveSettings({ ...settings, tunName: e.target.value })} dir="ltr" /></label>
                <label className="text-sm">MTU<input type="number" className="mt-1 w-full rounded-xl bg-black/40 px-3 py-2" value={settings.tunMtu} onChange={(e) => saveSettings({ ...settings, tunMtu: Number(e.target.value) })} dir="ltr" /></label>
                <label className="text-sm">آدرس TUN<input className="mt-1 w-full rounded-xl bg-black/40 px-3 py-2" value={settings.tunAddress} onChange={(e) => saveSettings({ ...settings, tunAddress: e.target.value })} dir="ltr" /></label>
              </div>
            </div>
          </section>
        )}
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-6 text-center text-xs text-slate-500">
        AetherSL v0.1.0 — لایسنس‌ها: Aether AGPL-3.0 · Serverless-for-Iran GPL-3.0 · Xray-core MPL-2.0 · Zeptun MIT — جزئیات در README.fa.md
      </footer>
    </div>
  );
}
