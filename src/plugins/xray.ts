import { registerPlugin, WebPlugin } from '@capacitor/core';
import { FragmentSettings } from '../types';

export interface XrayPlugin {
  startVpn(options: { config: string }): Promise<{ status: string; version?: string; message?: string; confirmed?: boolean; connectedAtMs?: number }>;
  stopVpn(): Promise<{ status: string }>;
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  getStatus(): Promise<{ running: boolean; validated?: boolean; version: string; starting?: boolean; lastError?: string; activeConfigId?: string; desired?: boolean }>;
  getNetworkContext(): Promise<{ key: string; connected: boolean }>;
  cancelConfigTests(): Promise<{ ok: boolean }>;
  checkVpnHealth(options?: { timeoutMs?: number }): Promise<{ ok: boolean; latency: number; checkedAt: number }>;
  getAppVersionInfo(): Promise<{ versionName: string; versionCode: number; platform?: 'android' | 'windows' | 'web' }>;
  resolveLatestRelease(options: {
    owner: string;
    repo: string;
    installedVersion?: string;
  }): Promise<{
    ok: boolean;
    tagName: string;
    htmlUrl: string;
    assetName: string;
    downloadUrl: string;
    message?: string;
  }>;
  downloadAndInstallApk(options: { url: string; fileName?: string }): Promise<{ ok: boolean; message?: string; path?: string }>;
  pingHost(options: { host: string; port?: number; timeout?: number }): Promise<{ latency: number; ok: boolean; ip?: string }>;
  getCurrentPublicIp(options?: { timeoutMs?: number }): Promise<{ ip: string; ok: boolean; source: 'vpn' | 'direct'; message?: string }>;
  testDnsResolve(options: {
    dnsIp: string;
    domain?: string;
    timeoutMs?: number;
  }): Promise<{ latency: number; ok: boolean; message?: string }>;
  measureDnsDownload(options: {
    dnsIp: string;
    url?: string;
    timeoutMs?: number;
    maxBytes?: number;
  }): Promise<{
    downloadBps: number;
    downloadMs: number;
    resolveMs: number;
    resolvedIp: string;
    ok: boolean;
    message?: string;
  }>;
  measureDnsBandwidth(options: {
    dnsIp: string;
    downloadUrl?: string;
    uploadUrl?: string;
    timeoutMs?: number;
    bytes?: number;
    downloadBytes?: number;
    uploadBytes?: number;
  }): Promise<{
    downloadBps: number;
    uploadBps: number;
    downloadMs: number;
    uploadMs: number;
    resolveMs: number;
    resolvedIp: string;
    ok: boolean;
    message?: string;
  }>;
  measureConfigDelay(options: {
    shareUri: string;
    dnsIp?: string;
    cleanIp?: string;
    strictDns?: boolean;
    timeoutMs?: number;
    maxLatencyMs?: number;
    testUrl?: string;
    testUrls?: readonly string[];
    preferredTestUrl?: string;
    fragment?: FragmentSettings;
    fakeDns?: boolean;
    doh?: boolean;
  }): Promise<{ latency: number; worstLatency?: number; coldLatency?: number; jitter?: number; ok: boolean; exitIp?: string; exitCountry?: string }>;
  measureConfigBandwidth(options: {
    config: string;
    bytes?: number;
    downloadBytes?: number;
    uploadBytes?: number;
    timeoutMs?: number;
    downloadUrl?: string;
    uploadUrl?: string;
  }): Promise<{
    downloadBps: number;
    uploadBps: number;
    downloadBytes?: number;
    downloadMs: number;
    uploadMs: number;
    ok: boolean;
    message?: string;
  }>;
  measureConfigDownload(options: {
    config: string;
    bytes?: number;
    downloadBytes?: number;
    timeoutMs?: number;
    downloadUrl?: string;
  }): Promise<{
    downloadBps: number;
    downloadBytes?: number;
    downloadMs: number;
    ok: boolean;
    message?: string;
  }>;
  getTrafficStats(): Promise<{ up: number; down: number }>;
  updateGeoAssets(): Promise<{ ok: boolean; geoipBytes: number; geositeBytes: number; message?: string }>;
  readClipboardText(): Promise<{ text: string }>;
  openVpnSettings(): Promise<{ ok: boolean }>;
  setSecure(options: { key: string; value: string }): Promise<{ ok: boolean }>;
  getSecure(options: { key: string }): Promise<{ value?: string }>; 
  removeSecure(options: { key: string }): Promise<{ ok: boolean }>;
  appendLog(options: { line: string }): Promise<{ ok: boolean }>;
  readLogs(): Promise<{ logs: string }>;
  clearLogs(): Promise<{ ok: boolean }>;
  setAutoStart(options: { enabled: boolean; lastShareUri?: string; lastPayload?: string }): Promise<{ ok: boolean }>;
  requestIgnoreBatteryOptimizations(): Promise<{ ok: boolean }>;
  openExternalUrl(options: { url: string }): Promise<{ ok: boolean }>;
  fetchText(options: { url: string; timeoutMs?: number }): Promise<{ ok: boolean; status: number; text: string; message?: string }>;
}

export class XrayWeb extends WebPlugin implements XrayPlugin {
  async getNetworkContext() { return { key: 'web', connected: navigator.onLine }; }
  async cancelConfigTests() { return { ok: true }; }
  async checkVpnHealth() { return { ok: false, latency: -1, checkedAt: Date.now() }; }

  async startVpn(): Promise<{ status: string }> {
    return new Promise((resolve) => setTimeout(() => resolve({ status: 'connected' }), 1500));
  }

  async stopVpn(): Promise<{ status: string }> {
    return { status: 'disconnected' };
  }

  async requestNotificationPermission(): Promise<{ granted: boolean }> {
    return { granted: false };
  }

  async getStatus(): Promise<{ running: boolean; version: string }> {
    return { running: false, version: 'web-stub' };
  }

  async getAppVersionInfo(): Promise<{ versionName: string; versionCode: number; platform: 'web' }> {
    return { versionName: 'web', versionCode: 0, platform: 'web' };
  }

  async resolveLatestRelease(): Promise<{
    ok: boolean;
    tagName: string;
    htmlUrl: string;
    assetName: string;
    downloadUrl: string;
    message?: string;
  }> {
    return {
      ok: false,
      tagName: '',
      htmlUrl: '',
      assetName: '',
      downloadUrl: '',
      message: 'Release fallback is only available on Android',
    };
  }

  async downloadAndInstallApk(options: { url: string; fileName?: string }): Promise<{ ok: boolean; message?: string; path?: string }> {
    const opened = window.open(options.url, '_blank', 'noopener,noreferrer');
    if (opened) opened.opener = null;
    return { ok: !!opened, message: opened ? undefined : 'Unable to open download link' };
  }

  async pingHost(): Promise<{ latency: number; ok: boolean }> {
    return { latency: -1, ok: false };
  }

  async getCurrentPublicIp(options?: { timeoutMs?: number }): Promise<{ ip: string; ok: boolean; source: 'vpn' | 'direct'; message?: string }> {
    const timeoutMs = options?.timeoutMs ?? 4000;
    const endpoints = [
      'https://api.ipify.org?format=json',
      'https://cloudflare.com/cdn-cgi/trace',
    ];

    for (const url of endpoints) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(url, {
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!response.ok) continue;
        const text = await response.text();
        const ip = this.extractPublicIp(text);
        if (ip) {
          return { ip, ok: true, source: 'direct' };
        }
      } catch {
        // try next endpoint
      }
    }

    return { ip: '', ok: false, source: 'direct', message: 'Unable to determine public IP' };
  }

  async testDnsResolve(): Promise<{ latency: number; ok: boolean; message?: string }> {
    return { latency: -1, ok: false };
  }

  async measureDnsDownload(): Promise<{
    downloadBps: number;
    downloadMs: number;
    resolveMs: number;
    resolvedIp: string;
    ok: boolean;
    message?: string;
  }> {
    return {
      downloadBps: -1,
      downloadMs: -1,
      resolveMs: -1,
      resolvedIp: '',
      ok: false,
      message: 'DNS-specific download tests are only available on Android',
    };
  }

  async measureDnsBandwidth(): Promise<{
    downloadBps: number;
    uploadBps: number;
    downloadMs: number;
    uploadMs: number;
    resolveMs: number;
    resolvedIp: string;
    ok: boolean;
    message?: string;
  }> {
    return {
      downloadBps: -1,
      uploadBps: -1,
      downloadMs: -1,
      uploadMs: -1,
      resolveMs: -1,
      resolvedIp: '',
      ok: false,
      message: 'DNS-specific bandwidth tests are only available on native platforms',
    };
  }

  async measureConfigDelay(): Promise<{ latency: number; worstLatency?: number; ok: boolean }> {
    return { latency: -1, worstLatency: -1, ok: false };
  }

  async measureConfigBandwidth(): Promise<{
    downloadBps: number;
    uploadBps: number;
    downloadBytes?: number;
    downloadMs: number;
    uploadMs: number;
    ok: boolean;
    message?: string;
  }> {
    return {
      downloadBps: -1,
      uploadBps: -1,
      downloadBytes: -1,
      downloadMs: -1,
      uploadMs: -1,
      ok: false,
    };
  }

  async measureConfigDownload(): Promise<{
    downloadBps: number;
    downloadBytes?: number;
    downloadMs: number;
    ok: boolean;
    message?: string;
  }> {
    return {
      downloadBps: -1,
      downloadBytes: -1,
      downloadMs: -1,
      ok: false,
    };
  }

  async getTrafficStats(): Promise<{ up: number; down: number }> {
    return { up: 0, down: 0 };
  }

  async updateGeoAssets(): Promise<{ ok: boolean; geoipBytes: number; geositeBytes: number; message?: string }> {
    return { ok: false, geoipBytes: -1, geositeBytes: -1, message: 'Routing database update is only available on Android' };
  }

  async readClipboardText(): Promise<{ text: string }> {
    try {
      const text = await navigator.clipboard?.readText?.();
      return { text: text || '' };
    } catch {
      return { text: '' };
    }
  }

  async openVpnSettings(): Promise<{ ok: boolean }> {
    return { ok: false };
  }

  async setSecure(): Promise<{ ok: boolean }> {
    return { ok: false };
  }

  async getSecure(): Promise<{ value?: string }> {
    return { value: undefined };
  }

  async removeSecure(): Promise<{ ok: boolean }> {
    return { ok: false };
  }

  async appendLog(): Promise<{ ok: boolean }> {
    return { ok: false };
  }

  async readLogs(): Promise<{ logs: string }> {
    return { logs: '' };
  }

  async clearLogs(): Promise<{ ok: boolean }> {
    return { ok: false };
  }

  async setAutoStart(): Promise<{ ok: boolean }> {
    return { ok: false };
  }

  async requestIgnoreBatteryOptimizations(): Promise<{ ok: boolean }> {
    return { ok: false };
  }

  async openExternalUrl(options: { url: string }): Promise<{ ok: boolean }> {
    try {
      const opened = window.open(options.url, '_blank', 'noopener,noreferrer');
      if (opened) opened.opener = null;
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async fetchText(options: { url: string; timeoutMs?: number }): Promise<{ ok: boolean; status: number; text: string; message?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    try {
      const response = await fetch(options.url, { cache: 'no-store', signal: controller.signal });
      return { ok: response.ok, status: response.status, text: await response.text() };
    } catch (error) {
      return { ok: false, status: 0, text: '', message: error instanceof Error ? error.message : 'Request failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  private extractPublicIp(body: string): string {
    const trimmed = (body || '').trim();
    if (!trimmed) return '';
    try {
      if (trimmed.startsWith('{')) {
        const parsed = JSON.parse(trimmed) as { ip?: string };
        if (typeof parsed.ip === 'string' && parsed.ip.trim()) {
          return parsed.ip.trim();
        }
      }
    } catch {
      // ignore JSON parse failure and fall through
    }
    for (const line of trimmed.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('ip=') && t.length > 3) {
        return t.slice(3).trim();
      }
    }
    return '';
  }
}

const desktopBridge = typeof window !== 'undefined' ? window.mir2rayDesktop : undefined;

const Xray: XrayPlugin = desktopBridge
  ? new Proxy({} as XrayPlugin, {
      get: (_target, property) => (options?: unknown) => desktopBridge.invoke(String(property), options),
    })
  : registerPlugin<XrayPlugin>('Xray', {
      web: () => new XrayWeb(),
    });

export default Xray;
