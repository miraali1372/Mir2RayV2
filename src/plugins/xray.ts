import { registerPlugin, WebPlugin } from '@capacitor/core';

export interface XrayPlugin {
  startVpn(options: { config: string }): Promise<{ status: string; version?: string; message?: string }>;
  stopVpn(): Promise<{ status: string }>;
  getStatus(): Promise<{ running: boolean; version: string }>;
  getAppVersionInfo(): Promise<{ versionName: string; versionCode: number }>;
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
  pingHost(options: { host: string; port?: number; timeout?: number }): Promise<{ latency: number; ok: boolean }>;
  getCurrentPublicIp(options?: { timeoutMs?: number }): Promise<{ ip: string; ok: boolean; source: 'vpn' | 'direct'; message?: string }>;
  testDnsResolve(options: {
    dnsIp: string;
    domain?: string;
    timeoutMs?: number;
  }): Promise<{ latency: number; ok: boolean; message?: string }>;
  measureConfigDelay(options: {
    shareUri: string;
    dnsIp?: string;
    cleanIp?: string;
    strictDns?: boolean;
    timeoutMs?: number;
    maxLatencyMs?: number;
    testUrl?: string;
  }): Promise<{ latency: number; ok: boolean }>;
  measureConfigBandwidth(options: {
    config: string;
    bytes?: number;
    timeoutMs?: number;
    downloadUrl?: string;
    uploadUrl?: string;
  }): Promise<{
    downloadBps: number;
    uploadBps: number;
    downloadMs: number;
    uploadMs: number;
    ok: boolean;
    message?: string;
  }>;
  measureConfigDownload(options: {
    config: string;
    bytes?: number;
    timeoutMs?: number;
    downloadUrl?: string;
  }): Promise<{
    downloadBps: number;
    downloadMs: number;
    ok: boolean;
    message?: string;
  }>;
  getTrafficStats(): Promise<{ up: number; down: number }>;
  setSecure(options: { key: string; value: string }): Promise<{ ok: boolean }>;
  getSecure(options: { key: string }): Promise<{ value?: string }>; 
  removeSecure(options: { key: string }): Promise<{ ok: boolean }>;
  appendLog(options: { line: string }): Promise<{ ok: boolean }>;
  readLogs(): Promise<{ logs: string }>;
  clearLogs(): Promise<{ ok: boolean }>;
  setAutoStart(options: { enabled: boolean; lastShareUri?: string }): Promise<{ ok: boolean }>;
  requestIgnoreBatteryOptimizations(): Promise<{ ok: boolean }>;
  openExternalUrl(options: { url: string }): Promise<{ ok: boolean }>;
}

export class XrayWeb extends WebPlugin implements XrayPlugin {
  async startVpn(): Promise<{ status: string }> {
    return new Promise((resolve) => setTimeout(() => resolve({ status: 'connected' }), 1500));
  }

  async stopVpn(): Promise<{ status: string }> {
    return { status: 'disconnected' };
  }

  async getStatus(): Promise<{ running: boolean; version: string }> {
    return { running: false, version: 'web-stub' };
  }

  async getAppVersionInfo(): Promise<{ versionName: string; versionCode: number }> {
    return { versionName: 'web', versionCode: 0 };
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

  async measureConfigDelay(): Promise<{ latency: number; ok: boolean }> {
    return { latency: -1, ok: false };
  }

  async measureConfigBandwidth(): Promise<{
    downloadBps: number;
    uploadBps: number;
    downloadMs: number;
    uploadMs: number;
    ok: boolean;
    message?: string;
  }> {
    return {
      downloadBps: -1,
      uploadBps: -1,
      downloadMs: -1,
      uploadMs: -1,
      ok: false,
    };
  }

  async measureConfigDownload(): Promise<{
    downloadBps: number;
    downloadMs: number;
    ok: boolean;
    message?: string;
  }> {
    return {
      downloadBps: -1,
      downloadMs: -1,
      ok: false,
    };
  }

  async getTrafficStats(): Promise<{ up: number; down: number }> {
    return { up: 0, down: 0 };
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

const Xray = registerPlugin<XrayPlugin>('Xray', {
  web: () => new XrayWeb(),
});

export default Xray;
