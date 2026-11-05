// تایپ‌های سمت رندرر (آینه تایپ‌های electron/config-generator.ts)
// فرمت رول‌ها: RuleFile با formatVersion 1 — همان configs/rules.user.json
export type Target = 'aether' | 'serverless' | 'direct' | 'block';
export type MatchType = 'domain-suffix' | 'domain-keyword' | 'geosite' | 'geoip' | 'cidr' | 'port';
export type Mode = 'hybrid' | 'serverless-only' | 'aether-only';
export type RuleMode = 'frag' | 'tunnel';
export type RuleTransport = 'both' | 'tcp' | 'udp';
export interface RuleGroup { name: string; mode: RuleMode; transport: RuleTransport; enabled: boolean; domains: string[]; note?: string }
export interface RuleFile { formatVersion: 1; rules: RuleGroup[] }
export interface UserRule { id: string; enabled: boolean; name: string; matchType: MatchType; match: string; target: Target; priority?: number; network?: string }
export interface AppSettings {
  mode: Mode; defaultTarget: 'serverless' | 'aether' | 'direct'; serverlessProfile: string;
  aetherProtocol: 'masque' | 'wireguard' | 'gool' | 'mim'; aetherScan: string; aetherIpVersion: string;
  aetherH2: boolean; aetherNoize: string; aetherPeer: string; aetherQuickReconnect: boolean;
  lastGoodEndpoint: string; lastGoodAt: string;
  tunEnabled: boolean; systemProxyEnabled: boolean;
  tunName: string; tunMtu: number; tunAddress: string; subscriptionUrl: string;
}
export type ScanMode = 'turbo' | 'balanced' | 'thorough' | 'stealth' | 'ironclad';
export type ScanIpVersion = 'both' | '4' | '6';
export type ScanProtocol = 'masque' | 'masque-h2' | 'wg' | 'gool';
export interface ScanOptions { mode: ScanMode; ipVersion: ScanIpVersion; protocol: ScanProtocol; fallbackOnly?: boolean }
export type CandidateStatus = 'ok' | 'failed' | 'cooldown' | 'testing';
export interface ScanCandidate { endpoint: string; ip: string; port: number; status: CandidateStatus; latencyMs?: number; source: string; detail?: string; selected?: boolean }
export interface ScanEvent { type: string; line?: string; candidate?: ScanCandidate; candidates?: ScanCandidate[]; selected?: string; tested?: number; message?: string; source?: string }
export interface CoreState { name: string; status: string; pid?: number; uptimeSec: number; restarts: number; lastError?: string }
export interface TraceInfo { ip: string; loc: string; warp: string; raw?: string }
export interface IpInfo {
  ip: string; loc: string; country: string; countryCode: string;
  warp: string; warpStatus: string;
  direct: TraceInfo | null; viaXray: TraceInfo | null; viaAether: TraceInfo | null;
}
export interface LogEntry { core: string; line: string; time: string }

declare global {
  interface Window {
    aethersl?: {
      getState: () => Promise<any>;
      connect: () => Promise<any>;
      disconnect: () => Promise<any>;
      saveRules: (r: RuleGroup[] | RuleFile) => Promise<any>;
      loadDefaultRules: () => Promise<RuleGroup[]>;
      saveSettings: (s: AppSettings) => Promise<any>;
      health: () => Promise<any>;
      downloadCores: () => Promise<any>;
      coresStatus: () => Promise<any>;
      testSpeed: () => Promise<any>;
      getIp: () => Promise<any>;
      scanStart: (opts: ScanOptions) => Promise<any>;
      scanStop: () => Promise<any>;
      scanUsePeer: (endpoint: string) => Promise<any>;
      scanClearPeer: () => Promise<any>;
      scanQuickReconnect: () => Promise<any>;
      onScanEvent: (cb: (e: ScanEvent) => void) => void;
      onLog: (cb: (e: LogEntry) => void) => void;
      onStatus: (cb: (s: CoreState[]) => void) => void;
    };
  }
}
