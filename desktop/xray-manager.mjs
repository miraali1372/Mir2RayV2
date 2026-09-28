import { app, clipboard, safeStorage, shell } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildMainConfig, buildSpeedTestConfig } from './xray-config.mjs';
import {
  downloadWithResolvedIp, fetchPublicIp, fetchPublicIpThroughHttpProxy, getFreePort, measureHttpsDelayThroughHttpProxy,
  requestThroughHttpProxy, uploadThroughHttpProxy, uploadWithResolvedIp,
  resolveWithDns, selectPreferredDelaySample, selectSlowestDelaySample, tcpPing, waitForPort,
} from './net-utils.mjs';

const CONFIG_DELAY_TEST_LIMIT = 15;
const CONFIG_BANDWIDTH_TEST_LIMIT = 3;
const DEFAULT_DOWNLOAD_TEST_URL = 'https://cachefly.cachefly.net/1mb.test';
const DEFAULT_UPLOAD_TEST_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_DOWNLOAD_TEST_BYTES = 512 * 1024;
const DEFAULT_UPLOAD_TEST_BYTES = 1280 * 1024;
const GEO_MIRRORS = {
  geoip: [
    'https://cdn.jsdelivr.net/gh/chocolate4u/Iran-v2ray-rules@release/geoip.dat',
    'https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/geoip.dat',
  ],
  geosite: [
    'https://cdn.jsdelivr.net/gh/chocolate4u/Iran-v2ray-rules@release/geosite.dat',
    'https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/geosite.dat',
  ],
};

class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  async use(task) {
    if (this.active >= this.limit) await new Promise(resolve => this.queue.push(resolve));
    this.active += 1;
    try { return await task(); }
    finally { this.active -= 1; this.queue.shift()?.(); }
  }
}

function sanitizeLog(value) {
  return String(value || '')
    .replace(/(?:vless|vmess|trojan|ss):\/\/\S+/gi, '[config]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}/gi, '[id]')
    .slice(0, 2000);
}

function remainingDeadlineMs(deadline, label) {
  const remaining = deadline - Date.now();
  if (remaining < 250) throw new Error(`${label} deadline exceeded`);
  return remaining;
}

function medianNumber(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : -1;
}

async function writeAtomic(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, content);
  await fsp.rename(temporary, filePath);
}

async function fetchBuffer(url, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'Mir2rayV2-Windows' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally { clearTimeout(timer); }
}

export class XrayManager {
  constructor() {
    this.mainProcess = null;
    this.mainPorts = null;
    this.starting = false;
    this.lastError = '';
    this.connectedAtMs = 0;
    this.traffic = { up: 0, down: 0 };
    this.delayTests = new Semaphore(CONFIG_DELAY_TEST_LIMIT);
    this.bandwidthTests = new Semaphore(CONFIG_BANDWIDTH_TEST_LIMIT);
    this.secureStoreMutation = Promise.resolve();
    this.dataRoot = this.resolveDataRoot();
    this.bundledRuntimeRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'runtime')
      : path.resolve('desktop', 'runtime');
    this.runtimeRoot = app.isPackaged
      ? path.join(this.dataRoot, 'runtime')
      : this.bundledRuntimeRoot;
    this.xrayPath = path.join(this.runtimeRoot, 'xray.exe');
    this.assetRoot = path.join(this.dataRoot, 'assets');
    this.tempRoot = path.join(this.dataRoot, 'temp');
    this.secureFile = path.join(this.dataRoot, 'secure-store.json');
    this.logFile = path.join(this.dataRoot, 'mir2ray.log');
    this.version = 'unknown';
  }

  resolveDataRoot() {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir) return path.join(portableDir, 'Mir2rayV2-Data');
    if (app.isPackaged) return path.join(path.dirname(process.execPath), 'Mir2rayV2-Data');
    return path.join(app.getPath('userData'), 'desktop-data');
  }

  async initialize() {
    if (!fs.existsSync(path.join(this.bundledRuntimeRoot, 'xray.exe'))) {
      throw new Error('Xray Windows runtime is missing from the application package');
    }
    await this.materializePackagedRuntime();
    if (!fs.existsSync(this.xrayPath)) throw new Error('Xray Windows runtime could not be prepared');
    this.version = this.readXrayVersion();
    await fsp.mkdir(this.assetRoot, { recursive: true });
    await fsp.mkdir(this.tempRoot, { recursive: true });
    for (const name of ['geoip.dat', 'geosite.dat']) {
      const destination = path.join(this.assetRoot, name);
      if (!fs.existsSync(destination)) await fsp.copyFile(path.join(this.runtimeRoot, name), destination);
    }
    await this.cleanupTemporaryFiles();
    await this.appendLog({ line: `Windows runtime initialized (${this.version})` });
  }

  async materializePackagedRuntime() {
    if (!app.isPackaged) return;
    await fsp.mkdir(this.runtimeRoot, { recursive: true });
    const requiredFiles = [
      'xray.exe', 'wintun.dll', 'geoip.dat', 'geosite.dat',
      'runtime-version.json', 'XRAY-LICENSE.txt',
    ];
    for (const name of requiredFiles) {
      const source = path.join(this.bundledRuntimeRoot, name);
      const destination = path.join(this.runtimeRoot, name);
      const [sourceInfo, destinationInfo] = await Promise.all([
        fsp.stat(source),
        fsp.stat(destination).catch(() => null),
      ]);
      if (destinationInfo?.size === sourceInfo.size) continue;
      const temporary = `${destination}.${process.pid}.tmp`;
      await fsp.copyFile(source, temporary);
      await fsp.rm(destination, { force: true });
      await fsp.rename(temporary, destination);
    }
  }

  readXrayVersion() {
    if (!fs.existsSync(this.xrayPath)) return 'missing';
    const result = spawnSync(this.xrayPath, ['version'], { cwd: this.runtimeRoot, encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return String(result.stdout || result.stderr || '').match(/Xray\s+([\w.-]+)/i)?.[1] || 'unknown';
  }

  xrayEnvironment() {
    return { ...process.env, XRAY_LOCATION_ASSET: this.assetRoot };
  }

  async cleanupTemporaryFiles() {
    const files = await fsp.readdir(this.tempRoot).catch(() => []);
    await Promise.all(files.filter(name => name.endsWith('.json')).map(name => fsp.rm(path.join(this.tempRoot, name), { force: true })));
  }

  async writeConfig(config) {
    const file = path.join(this.tempRoot, `${crypto.randomUUID()}.json`);
    await fsp.writeFile(file, JSON.stringify(config));
    return file;
  }

  spawnXray(configFile) {
    if (!fs.existsSync(this.xrayPath)) {
      throw new Error('Xray runtime is unavailable. Restart the portable application.');
    }
    return spawn(this.xrayPath, ['run', '-c', configFile], {
      cwd: this.runtimeRoot, env: this.xrayEnvironment(), windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  captureProcessErrors(child, onExit) {
    let output = '';
    let reported = false;
    const capture = chunk => { output = `${output}${chunk}`.slice(-8000); };
    const report = info => {
      if (reported) return;
      reported = true;
      onExit?.(info);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', error => report({ code: null, signal: 'spawn-error', output: sanitizeLog(error.message) }));
    child.once('exit', (code, signal) => report({ code, signal, output: sanitizeLog(output) }));
  }

  async validateConfig(config) {
    const file = await this.writeConfig(config);
    try {
      const result = await new Promise(resolve => {
        const child = spawn(this.xrayPath, ['run', '-test', '-c', file], {
          cwd: this.runtimeRoot, env: this.xrayEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        child.once('error', error => finish({ code: -1, output: error.message }));
        child.once('exit', code => finish({ code, output }));
      });
      if (result.code !== 0) throw new Error(sanitizeLog(result.output) || 'Xray rejected the generated configuration');
      return true;
    } finally { await fsp.rm(file, { force: true }); }
  }

  async runTemporaryCore(payload, task, semaphore = this.delayTests) {
    return semaphore.use(async () => {
      const httpPort = await getFreePort();
      const config = buildSpeedTestConfig(payload, httpPort);
      const file = await this.writeConfig(config);
      let child = null;
      let exitInfo = null;
      try {
        child = this.spawnXray(file);
        this.captureProcessErrors(child, info => { exitInfo = info; });
        const ready = await waitForPort(httpPort, 5000);
        await fsp.rm(file, { force: true });
        if (!ready || child.exitCode !== null) throw new Error(exitInfo?.output || 'Temporary Xray core did not start');
        return await task(httpPort);
      } finally {
        if (child?.exitCode === null) child.kill();
        await fsp.rm(file, { force: true });
      }
    });
  }

  async startVpn(options) {
    if (this.starting) return { status: 'error', message: 'Connection is already starting' };
    this.starting = true;
    try {
      await this.stopVpn();
      const parsed = JSON.parse(options?.config || '{}');
      this.mainPorts = { socksPort: await getFreePort(), httpPort: await getFreePort(), apiPort: await getFreePort() };
      const config = buildMainConfig(parsed, this.mainPorts);
      await this.validateConfig(config);
      const file = await this.writeConfig(config);
      let child;
      try {
        child = this.spawnXray(file);
      } catch (error) {
        await fsp.rm(file, { force: true });
        throw error;
      }
      this.mainProcess = child;
      let earlyExit = null;
      this.captureProcessErrors(child, info => {
        earlyExit = info;
        if (this.mainProcess === child) {
          this.mainProcess = null;
          this.lastError = info.output || `Xray exited (${info.code ?? info.signal})`;
        }
      });
      const ready = await waitForPort(this.mainPorts.httpPort, 9000);
      await fsp.rm(file, { force: true });
      if (!ready || child.exitCode !== null) {
        if (child.exitCode === null) child.kill();
        this.mainProcess = null;
        throw new Error(earlyExit?.output || 'Xray TUN did not become ready. Run the portable app as administrator.');
      }
      this.connectedAtMs = Date.now();
      this.lastError = '';
      this.traffic = { up: 0, down: 0 };
      await this.appendLog({ line: `VPN connected with Xray ${this.version}` });
      return { status: 'connected', version: this.version, confirmed: true, connectedAtMs: this.connectedAtMs };
    } catch (error) {
      this.lastError = sanitizeLog(error instanceof Error ? error.message : error);
      await this.appendLog({ line: `VPN start failed: ${this.lastError}` });
      return { status: 'error', version: this.version, message: this.lastError };
    } finally { this.starting = false; }
  }

  async stopVpn() {
    const child = this.mainProcess;
    this.mainProcess = null;
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 2500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    this.mainPorts = null;
    this.connectedAtMs = 0;
    this.traffic = { up: 0, down: 0 };
    await this.appendLog({ line: 'VPN disconnected' });
    return { status: 'disconnected' };
  }

  async getStatus() {
    const running = Boolean(this.mainProcess && this.mainProcess.exitCode === null);
    return { running, validated: running, starting: this.starting, version: this.version, lastError: this.lastError || undefined };
  }

  async pingHost(options) {
    return tcpPing(options?.host, options?.port || 443, options?.timeout || 1000);
  }

  async testDnsResolve(options) {
    const timeoutMs = Math.max(1000, Number(options?.timeoutMs || 2500));
    const deadline = Date.now() + timeoutMs;
    const samples = [];
    let lastMessage = 'DNS resolution failed';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining < 250) break;
      const attemptsLeft = 3 - attempt;
      const result = await resolveWithDns(
        options?.dnsIp,
        options?.domain || 'www.gstatic.com',
        Math.max(250, Math.floor(remaining / attemptsLeft))
      );
      if (result.ok && result.latency >= 0) samples.push(result.latency);
      else if (result.message) lastMessage = result.message;
    }
    if (samples.length < 2) return { latency: -1, ok: false, message: lastMessage };
    return { latency: medianNumber(samples), ok: true };
  }

  async measureDnsDownload(options) {
    const url = options?.url || DEFAULT_DOWNLOAD_TEST_URL;
    const timeoutMs = options?.timeoutMs || 8000;
    const resolved = await resolveWithDns(options?.dnsIp, new URL(url).hostname, timeoutMs);
    if (!resolved.ok) return { downloadBps: -1, downloadMs: -1, resolveMs: resolved.latency, resolvedIp: '', ok: false, message: resolved.message };
    const sample = await downloadWithResolvedIp(url, resolved.address, timeoutMs, options?.maxBytes || DEFAULT_DOWNLOAD_TEST_BYTES);
    return { downloadBps: sample.bps, downloadMs: sample.elapsed, resolveMs: resolved.latency, resolvedIp: resolved.address, ok: sample.ok, message: sample.message };
  }

  async measureDnsBandwidth(options) {
    const downloadUrl = options?.downloadUrl || DEFAULT_DOWNLOAD_TEST_URL;
    const uploadUrl = options?.uploadUrl || DEFAULT_UPLOAD_TEST_URL;
    const timeoutMs = Math.max(1000, Number(options?.timeoutMs || 8000));
    const downloadBytes = Math.max(
      1,
      Number(options?.downloadBytes ?? options?.bytes ?? DEFAULT_DOWNLOAD_TEST_BYTES)
    );
    const uploadBytes = Math.max(
      1,
      Number(options?.uploadBytes ?? options?.bytes ?? DEFAULT_UPLOAD_TEST_BYTES)
    );
    const deadline = Date.now() + (timeoutMs * 2);
    try {
      const downloadTarget = new URL(downloadUrl);
      const uploadTarget = new URL(uploadUrl);
      const downloadResolved = await resolveWithDns(
        options?.dnsIp,
        downloadTarget.hostname,
        Math.min(timeoutMs, remainingDeadlineMs(deadline, 'DNS bandwidth test'))
      );
      if (!downloadResolved.ok) throw new Error(downloadResolved.message || 'DNS resolution failed');

      const download = await downloadWithResolvedIp(
        downloadUrl,
        downloadResolved.address,
        Math.min(timeoutMs, remainingDeadlineMs(deadline, 'DNS bandwidth test')),
        downloadBytes
      );
      if (!download.ok || download.bytes < Math.max(1, downloadBytes * 0.9)) {
        throw new Error(download.message || 'Downloaded too few bytes');
      }

      const uploadResolved = uploadTarget.hostname === downloadTarget.hostname
        ? downloadResolved
        : await resolveWithDns(
            options?.dnsIp,
            uploadTarget.hostname,
            Math.min(timeoutMs, remainingDeadlineMs(deadline, 'DNS bandwidth test'))
          );
      if (!uploadResolved.ok) throw new Error(uploadResolved.message || 'DNS resolution failed');
      const upload = await uploadWithResolvedIp(
        uploadUrl,
        uploadResolved.address,
        Math.min(timeoutMs, remainingDeadlineMs(deadline, 'DNS bandwidth test')),
        uploadBytes
      );
      if (!upload.ok) throw new Error(upload.message || 'Upload test failed');

      return {
        downloadBps: download.bps,
        uploadBps: upload.bps,
        downloadMs: download.elapsed,
        uploadMs: upload.elapsed,
        resolveMs: downloadResolved.latency,
        resolvedIp: downloadResolved.address,
        ok: download.bps > 0 && upload.bps > 0,
      };
    } catch (error) {
      return {
        downloadBps: -1,
        uploadBps: -1,
        downloadMs: -1,
        uploadMs: -1,
        resolveMs: -1,
        resolvedIp: '',
        ok: false,
        message: sanitizeLog(error instanceof Error ? error.message : error),
      };
    }
  }

  async measureConfigDelay(options) {
    try {
      const payload = {
        shareUri: options?.shareUri, dnsIp: options?.dnsIp, cleanIp: options?.cleanIp,
        fragment: options?.fragment, strictDns: options?.strictDns,
      };
      const timeoutMs = Math.max(3000, Math.min(Number(options?.timeoutMs || 15000), 30000));
      const maxLatencyMs = Number(options?.maxLatencyMs || -1);
      const requestedUrls = Array.isArray(options?.testUrls) && options.testUrls.length > 0
        ? options.testUrls
        : [options?.testUrl || 'https://www.gstatic.com/generate_204'];
      const urls = [...new Set(requestedUrls
        .map(value => String(value || '').trim())
        .filter(Boolean))]
        .filter(value => {
          try { return new URL(value).protocol === 'https:'; }
          catch { return false; }
        })
        .slice(0, 3);
      if (urls.length === 0) throw new Error('No valid real-delay target was provided');
      const preferredUrl = String(options?.preferredTestUrl || '').trim();
      const samples = await this.runTemporaryCore(payload, async port => {
        const deadline = Date.now() + timeoutMs;
        const orderedUrls = preferredUrl && urls.includes(preferredUrl)
          ? [preferredUrl, ...urls.filter(url => url !== preferredUrl)]
          : urls;
        let delaySample = null;
        for (let index = 0; index < orderedUrls.length; index += 1) {
          const remaining = deadline - Date.now();
          if (remaining < 500) break;
          const targetsLeft = orderedUrls.length - index;
          const targetBudget = Math.min(
            remaining,
            Math.max(1000, Math.floor(remaining / targetsLeft))
          );
          const target = orderedUrls[index];
          try {
            delaySample = {
              ...await measureHttpsDelayThroughHttpProxy(port, target, {
                timeoutMs: targetBudget,
                attempts: 1,
              }),
              target,
            };
            break;
          } catch {
            // Try the next service target within the same overall deadline.
          }
        }
        if (!delaySample) throw new Error('All real-delay targets failed');

        let exitIp = null;
        const remaining = deadline - Date.now();
        if (remaining >= 500) {
          const result = await fetchPublicIpThroughHttpProxy(port, Math.min(1000, remaining));
          if (result.ok) exitIp = result.ip;
        }
        return { preferred: delaySample, slowest: delaySample, exitIp };
      });
      const ok = samples.preferred.ok
        && samples.slowest.ok
        && (maxLatencyMs < 0 || samples.slowest.elapsed <= maxLatencyMs);
      return {
        latency: samples.preferred.elapsed,
        worstLatency: samples.slowest.elapsed,
        ok,
        exitIp: samples.exitIp || null,
      };
    } catch { return { latency: -1, worstLatency: -1, ok: false }; }
  }

  async measureConfigDownload(options) {
    try {
      const payload = JSON.parse(options?.config || '{}');
      const bytes = Math.max(
        1,
        Number(payload.downloadBytes ?? payload.bytes ?? options?.downloadBytes ?? options?.bytes ?? DEFAULT_DOWNLOAD_TEST_BYTES)
      );
      const timeoutMs = Math.max(1000, Number(payload.timeoutMs || options?.timeoutMs || 8000));
      const sample = await this.runTemporaryCore(payload, async port => {
        const exitIp = await fetchPublicIpThroughHttpProxy(
          port,
          Math.min(4500, Math.max(1500, Math.floor(timeoutMs / 3)))
        );
        if (!exitIp.ok) throw new Error('Exit IP validation failed');
        return requestThroughHttpProxy(port, payload.downloadUrl || options?.downloadUrl || DEFAULT_DOWNLOAD_TEST_URL, {
          timeoutMs,
          maxBytes: bytes,
        });
      }, this.bandwidthTests);
      const ok = sample.ok && sample.bytes >= Math.max(1, bytes * 0.9);
      return { downloadBps: ok ? sample.bps : -1, downloadBytes: sample.bytes, downloadMs: sample.elapsed, ok, message: ok ? undefined : 'Downloaded too few bytes' };
    } catch (error) {
      return { downloadBps: -1, downloadBytes: -1, downloadMs: -1, ok: false, message: sanitizeLog(error instanceof Error ? error.message : error) };
    }
  }

  async measureConfigBandwidth(options) {
    try {
      const payload = JSON.parse(options?.config || '{}');
      const downloadBytes = Math.max(
        1,
        Number(payload.downloadBytes ?? payload.bytes ?? options?.downloadBytes ?? options?.bytes ?? DEFAULT_DOWNLOAD_TEST_BYTES)
      );
      const uploadBytes = Math.max(
        1,
        Number(payload.uploadBytes ?? payload.bytes ?? options?.uploadBytes ?? options?.bytes ?? DEFAULT_UPLOAD_TEST_BYTES)
      );
      const timeoutMs = Math.max(1000, Number(payload.timeoutMs || options?.timeoutMs || 8000));
      const samples = await this.runTemporaryCore(payload, async port => {
        const deadline = Date.now() + (timeoutMs * 2);
        const exitIp = await fetchPublicIpThroughHttpProxy(
          port,
          Math.min(4500, Math.max(1500, Math.floor(timeoutMs / 3)))
        );
        if (!exitIp.ok) throw new Error('Exit IP validation failed');
        const download = await requestThroughHttpProxy(
          port,
          payload.downloadUrl || options?.downloadUrl || DEFAULT_DOWNLOAD_TEST_URL,
          {
            timeoutMs: Math.min(
              timeoutMs,
              remainingDeadlineMs(deadline, 'Configuration bandwidth test')
            ),
            maxBytes: downloadBytes,
          }
        );
        const downloadOk = download.ok && download.bytes >= Math.max(1, downloadBytes * 0.9);
        if (!downloadOk) throw new Error('Downloaded too few bytes');

        const upload = await uploadThroughHttpProxy(
          port,
          payload.uploadUrl || options?.uploadUrl || DEFAULT_UPLOAD_TEST_URL,
          {
            timeoutMs: Math.min(
              timeoutMs,
              remainingDeadlineMs(deadline, 'Configuration bandwidth test')
            ),
            bytes: uploadBytes,
          }
        );
        if (!upload.ok) throw new Error(upload.message || 'Upload test failed');
        return { download, upload };
      }, this.bandwidthTests);

      return {
        downloadBps: samples.download.bps,
        uploadBps: samples.upload.bps,
        downloadBytes: samples.download.bytes,
        downloadMs: samples.download.elapsed,
        uploadMs: samples.upload.elapsed,
        ok: samples.download.bps > 0 && samples.upload.bps > 0,
      };
    } catch (error) {
      return {
        downloadBps: -1,
        uploadBps: -1,
        downloadBytes: -1,
        downloadMs: -1,
        uploadMs: -1,
        ok: false,
        message: sanitizeLog(error instanceof Error ? error.message : error),
      };
    }
  }

  async getCurrentPublicIp(options) {
    const result = await fetchPublicIp(options?.timeoutMs || 7000);
    return { ...result, source: this.mainProcess ? 'vpn' : 'direct' };
  }

  async getTrafficStats() {
    if (!this.mainProcess || !this.mainPorts) return { up: 0, down: 0 };
    const result = spawnSync(this.xrayPath, ['api', 'statsquery', `--server=127.0.0.1:${this.mainPorts.apiPort}`, '-pattern', 'inbound>>>tun>>>traffic>>>'], {
      cwd: this.runtimeRoot, env: this.xrayEnvironment(), encoding: 'utf8', windowsHide: true, timeout: 1500,
    });
    try {
      const parsed = JSON.parse(result.stdout || '{}');
      for (const stat of parsed.stat || []) {
        if (String(stat.name).endsWith('uplink')) this.traffic.up = Number(stat.value || 0);
        if (String(stat.name).endsWith('downlink')) this.traffic.down = Number(stat.value || 0);
      }
    } catch { /* keep last counters */ }
    return { ...this.traffic };
  }

  async getAppVersionInfo() {
    const parts = app.getVersion().split('.').map(value => Number(value) || 0);
    return { versionName: app.getVersion(), versionCode: parts[0] * 10000 + parts[1] * 100 + parts[2], platform: 'windows' };
  }

  async resolveLatestRelease(options) {
    try {
      const response = await fetch(`https://api.github.com/repos/${options.owner}/${options.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Mir2rayV2-Windows' } });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      const release = await response.json();
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const asset = assets.find(item => /mir2ray.*(?:portable|windows).*\.exe$/i.test(item.name)) || assets.find(item => /\.exe$/i.test(item.name));
      if (!asset) throw new Error('Windows portable asset was not found');
      return { ok: true, tagName: release.tag_name, htmlUrl: release.html_url, assetName: asset.name, downloadUrl: asset.browser_download_url };
    } catch (error) {
      return { ok: false, tagName: '', htmlUrl: '', assetName: '', downloadUrl: '', message: sanitizeLog(error instanceof Error ? error.message : error) };
    }
  }

  async downloadAndInstallApk(options) {
    try {
      const url = new URL(options?.url);
      if (url.protocol !== 'https:') throw new Error('Only HTTPS updates are allowed');
      const safeName = path.basename(options?.fileName || 'Mir2rayV2-Portable.exe').replace(/[^a-z0-9._-]/gi, '_');
      const destination = path.join(app.getPath('downloads'), safeName);
      const data = await fetchBuffer(url.href, 180_000);
      await writeAtomic(destination, data);
      shell.showItemInFolder(destination);
      return { ok: true, path: destination, message: 'Update downloaded' };
    } catch (error) { return { ok: false, message: sanitizeLog(error instanceof Error ? error.message : error) }; }
  }

  async updateGeoAssets() {
    const download = async (name, mirrors) => {
      let lastError;
      for (const url of mirrors) {
        try {
          const data = await fetchBuffer(url);
          if (data.length < 100000) throw new Error('Routing database is unexpectedly small');
          await writeAtomic(path.join(this.assetRoot, `${name}.dat`), data);
          return data.length;
        } catch (error) { lastError = error; }
      }
      throw lastError || new Error(`Could not update ${name}`);
    };
    try {
      const [geoipBytes, geositeBytes] = await Promise.all([download('geoip', GEO_MIRRORS.geoip), download('geosite', GEO_MIRRORS.geosite)]);
      return { ok: true, geoipBytes, geositeBytes };
    } catch (error) { return { ok: false, geoipBytes: -1, geositeBytes: -1, message: sanitizeLog(error instanceof Error ? error.message : error) }; }
  }

  async readSecureStore() {
    try { return JSON.parse(await fsp.readFile(this.secureFile, 'utf8')); } catch { return {}; }
  }

  async mutateSecureStore(mutator) {
    const operation = this.secureStoreMutation.then(async () => {
      const store = await this.readSecureStore();
      await mutator(store);
      await writeAtomic(this.secureFile, JSON.stringify(store));
    });
    this.secureStoreMutation = operation.catch(() => {});
    await operation;
  }

  async setSecure(options) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable');
    const key = String(options.key);
    const encrypted = safeStorage.encryptString(String(options.value)).toString('base64');
    await this.mutateSecureStore(store => { store[key] = encrypted; });
    return { ok: true };
  }

  async getSecure(options) {
    await this.secureStoreMutation;
    const store = await this.readSecureStore();
    const encoded = store[String(options.key)];
    if (!encoded) return {};
    try { return { value: safeStorage.decryptString(Buffer.from(encoded, 'base64')) }; }
    catch { throw new Error('Windows secure storage could not decrypt the saved value'); }
  }

  async removeSecure(options) {
    const key = String(options.key);
    await this.mutateSecureStore(store => { delete store[key]; });
    return { ok: true };
  }

  async appendLog(options) {
    await fsp.mkdir(path.dirname(this.logFile), { recursive: true });
    await fsp.appendFile(this.logFile, `${new Date().toISOString()} ${sanitizeLog(options?.line)}\n`, 'utf8');
    return { ok: true };
  }

  async readLogs() {
    try { return { logs: (await fsp.readFile(this.logFile, 'utf8')).slice(-100000) }; }
    catch { return { logs: '' }; }
  }

  async clearLogs() { await fsp.rm(this.logFile, { force: true }); return { ok: true }; }
  async readClipboardText() { return { text: clipboard.readText() || '' }; }
  async requestNotificationPermission() { return { granted: true }; }
  async requestIgnoreBatteryOptimizations() { return { ok: true }; }
  async openVpnSettings() { await shell.openExternal('ms-settings:network-vpn'); return { ok: true }; }
  async openExternalUrl(options) { await shell.openExternal(options.url); return { ok: true }; }
  async setAutoStart(options) {
    const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    app.setLoginItemSettings({ openAtLogin: Boolean(options?.enabled), path: executable });
    return { ok: true };
  }

  async fetchText(options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options?.timeoutMs || 15_000);
    try {
      const response = await fetch(options.url, { redirect: 'follow', cache: 'no-store', signal: controller.signal, headers: { 'User-Agent': 'Mir2rayV2-Windows' } });
      return { ok: response.ok, status: response.status, text: await response.text() };
    } catch (error) { return { ok: false, status: 0, text: '', message: sanitizeLog(error instanceof Error ? error.message : error) }; }
    finally { clearTimeout(timer); }
  }

  async invoke(method, options) {
    const allowed = new Set([
      'startVpn', 'stopVpn', 'requestNotificationPermission', 'getStatus', 'getAppVersionInfo',
      'resolveLatestRelease', 'downloadAndInstallApk', 'pingHost', 'getCurrentPublicIp',
      'testDnsResolve', 'measureDnsDownload', 'measureDnsBandwidth', 'measureConfigDelay', 'measureConfigBandwidth',
      'measureConfigDownload', 'getTrafficStats', 'updateGeoAssets', 'readClipboardText',
      'openVpnSettings', 'setSecure', 'getSecure', 'removeSecure', 'appendLog', 'readLogs',
      'clearLogs', 'setAutoStart', 'requestIgnoreBatteryOptimizations', 'openExternalUrl', 'fetchText',
    ]);
    if (!allowed.has(method) || typeof this[method] !== 'function') throw new Error('Unsupported desktop operation');
    return this[method](options);
  }
}
