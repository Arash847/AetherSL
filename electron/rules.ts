// rules.ts — تایپ، اعتبارسنجی و parse/serialize فرمت فایل رول‌ها
// فرمت مرجع: configs/rules.user.json — { formatVersion: 1, rules: [...] }
// هر گروه: { name, mode: 'frag'|'tunnel', transport: 'both'|'tcp'|'udp',
//            enabled, domains: string[], note? }
// نگاشت قطعی: frag = Serverless ، tunnel = Aether.
// فایل رول‌های کاربر (rules.json) در پوشه userData اپ ذخیره می‌شود، نه در ریپو.
import type { RuleFile, RuleGroup, RuleMode, RuleTransport, Target, UserRule } from './config-generator';

// نگاشت mode ↔ target اینجا تکرار شده تا rules.ts هیچ import زمان‌اجرایی
// از config-generator نداشته باشد (تست node:test فایل TS را مستقیم import می‌کند
// و ESM نود extension صریح می‌خواهد؛ منطق تکی‌خطی است و در config-generator.ts
// نسخه مرجع آن lives می‌کند — اگر عوض شد، اینجا هم عوضش کن).
function ruleModeToTarget(mode: RuleMode): Target {
  return mode === 'frag' ? 'serverless' : 'aether';
}
function targetToRuleMode(target: Target): RuleMode {
  return target === 'serverless' ? 'frag' : 'tunnel';
}

export type { RuleFile, RuleGroup, RuleMode, RuleTransport };

export function newRuleId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function validateGroup(input: Partial<RuleGroup>): { ok: boolean; error?: string } {
  if (!input.name || !String(input.name).trim()) return { ok: false, error: 'نام گروه خالی است' };
  if (input.mode !== 'frag' && input.mode !== 'tunnel') return { ok: false, error: 'mode باید frag یا tunnel باشد' };
  if (input.transport !== undefined && !['both', 'tcp', 'udp'].includes(input.transport)) {
    return { ok: false, error: 'transport باید both یا tcp یا udp باشد' };
  }
  if (!Array.isArray(input.domains) || input.domains.length === 0) {
    return { ok: false, error: 'گروه باید حداقل یک دامنه داشته باشد' };
  }
  for (const d of input.domains) {
    if (!DOMAIN_RE.test(String(d).trim())) return { ok: false, error: `دامنه نامعتبر: ${d}` };
  }
  return { ok: true };
}

/** parse سخت‌گیرانه فایل رول‌ها؛ ورودی نامعتبر خطا می‌دهد (نه سکوت) */
export function parseRuleFile(input: unknown): RuleFile {
  if (!input || typeof input !== 'object') throw new Error('فایل رول‌ها یک آبجکت JSON نیست');
  const obj = input as Record<string, unknown>;
  if (obj.formatVersion !== 1) throw new Error(`formatVersion پشتیبانی‌نشده: ${String(obj.formatVersion)} (انتظار 1)`);
  if (!Array.isArray(obj.rules)) throw new Error('فایل رول‌ها فیلد rules (آرایه) ندارد');
  const rules: RuleGroup[] = obj.rules.map((g: unknown, i: number) => {
    if (!g || typeof g !== 'object') throw new Error(`رول شماره ${i + 1} آبجکت نیست`);
    const r = g as Partial<RuleGroup>;
    const v = validateGroup(r);
    if (!v.ok) throw new Error(`رول «${String(r.name ?? i + 1)}»: ${v.error}`);
    return {
      name: String(r.name).trim(),
      mode: r.mode as RuleMode,
      transport: (r.transport ?? 'both') as RuleTransport,
      enabled: r.enabled !== false,
      domains: [...new Set((r.domains as string[]).map((d) => String(d).trim().toLowerCase()))],
      ...(r.note ? { note: String(r.note) } : {}),
    };
  });
  return { formatVersion: 1, rules };
}

export function parseRuleFileText(text: string): RuleFile {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('فایل JSON معتبر نیست'); }
  return parseRuleFile(parsed);
}

export function serializeRuleFile(file: RuleFile): string {
  return JSON.stringify({ formatVersion: 1, rules: file.rules }, null, 2) + '\n';
}

/** تغییر mode یک گروه با یک کلیک: frag <-> tunnel */
export function toggleGroupMode(group: RuleGroup): RuleGroup {
  return { ...group, mode: group.mode === 'frag' ? 'tunnel' : 'frag' };
}

/** افزودن دامنه به گروه (تکراری و نامعتبر رد می‌شود) */
export function addDomainToGroup(group: RuleGroup, domain: string): { group: RuleGroup; error?: string } {
  const d = domain.trim().toLowerCase();
  if (!DOMAIN_RE.test(d)) return { group, error: `دامنه نامعتبر: ${domain}` };
  if (group.domains.includes(d)) return { group, error: 'این دامنه از قبل در گروه هست' };
  return { group: { ...group, domains: [...group.domains, d] } };
}

// ---- سازگاری با رول‌های تکی قدیمی (UserRule) ----

export function validateRule(input: Partial<UserRule>): { ok: boolean; error?: string } {
  if (!input.name || !input.name.trim()) return { ok: false, error: 'نام رول خالی است' };
  if (!input.match || !String(input.match).trim()) return { ok: false, error: 'مقدار match خالی است' };
  const types = ['domain-suffix', 'domain-keyword', 'geosite', 'geoip', 'cidr', 'port'];
  if (!types.includes(input.matchType as string)) return { ok: false, error: 'نوع match نامعتبر است' };
  const targets = ['aether', 'serverless', 'direct', 'block'];
  if (!targets.includes(input.target as string)) return { ok: false, error: 'مقصد نامعتبر است' };
  if (input.matchType === 'cidr') {
    const m = String(input.match).trim();
    if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(m) && !/^(\d{1,3}\.){3}\d{1,3}$/.test(m)) {
      return { ok: false, error: 'CIDR نامعتبر است (مثال: 10.0.0.0/8)' };
    }
  }
  if (input.matchType === 'port') {
    const m = String(input.match).trim();
    if (!/^(tcp|udp)?:?\d+(-\d+)?$/i.test(m)) return { ok: false, error: 'پورت نامعتبر است (مثال: 443 یا udp:53)' };
  }
  return { ok: true };
}

/** تبدیل رول‌های تکی قدیمی به گروه (برای مهاجرت rules.json قدیمی) */
export function userRulesToGroups(rules: UserRule[]): RuleGroup[] {
  const byKey = new Map<string, RuleGroup>();
  for (const r of rules) {
    if (r.matchType !== 'domain-suffix') continue;
    const mode = targetToRuleMode(r.target);
    const key = `${r.name}::${mode}`;
    const g = byKey.get(key) ?? {
      name: r.name, mode, transport: 'both' as RuleTransport,
      enabled: r.enabled !== false, domains: [],
    };
    const d = r.match.replace(/^domain:/, '').trim().toLowerCase();
    if (d && !g.domains.includes(d)) g.domains.push(d);
    byKey.set(key, g);
  }
  return [...byKey.values()];
}

/** گروه‌ها → رول تکی (برای سازگاری با کد قدیمی) */
export function groupsToUserRules(groups: RuleGroup[]): UserRule[] {
  const out: UserRule[] = [];
  groups.forEach((g, gi) => {
    for (const d of g.domains) {
      out.push({
        id: `${g.name}:${d}`, enabled: g.enabled !== false, name: g.name,
        matchType: 'domain-suffix', match: d, target: ruleModeToTarget(g.mode),
        priority: (gi + 1) * 10, network: g.transport === 'both' ? 'tcp+udp' : g.transport,
      });
    }
  });
  return out;
}
