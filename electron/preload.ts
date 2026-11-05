// preload.ts — پل امن بین رندرر و main (contextBridge)
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aethersl', {
  getState: () => ipcRenderer.invoke('aethersl:get-state'),
  connect: () => ipcRenderer.invoke('aethersl:connect'),
  disconnect: () => ipcRenderer.invoke('aethersl:disconnect'),
  saveRules: (rules: unknown) => ipcRenderer.invoke('aethersl:save-rules', rules),
  loadDefaultRules: () => ipcRenderer.invoke('aethersl:load-default-rules'),
  saveSettings: (s: unknown) => ipcRenderer.invoke('aethersl:save-settings', s),
  health: () => ipcRenderer.invoke('aethersl:health'),
  downloadCores: () => ipcRenderer.invoke('aethersl:download-cores'),
  coresStatus: () => ipcRenderer.invoke('aethersl:cores-status'),
  testSpeed: () => ipcRenderer.invoke('aethersl:test-speed'),
  getIp: () => ipcRenderer.invoke('aethersl:get-ip'),
  scanStart: (opts: unknown) => ipcRenderer.invoke('aethersl:scan-start', opts),
  scanStop: () => ipcRenderer.invoke('aethersl:scan-stop'),
  scanUsePeer: (endpoint: string) => ipcRenderer.invoke('aethersl:scan-use-peer', endpoint),
  scanClearPeer: () => ipcRenderer.invoke('aethersl:scan-clear-peer'),
  scanQuickReconnect: () => ipcRenderer.invoke('aethersl:scan-quick-reconnect'),
  onScanEvent: (cb: (e: any) => void) => ipcRenderer.on('aethersl:scan-event', (_e, ev) => cb(ev)),
  onLog: (cb: (e: any) => void) => ipcRenderer.on('aethersl:log', (_e, entry) => cb(entry)),
  onStatus: (cb: (s: any) => void) => ipcRenderer.on('aethersl:status', (_e, s) => cb(s)),
});
