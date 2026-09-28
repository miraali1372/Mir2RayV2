import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildMainConfig, buildSpeedTestConfig } from '../xray-config.mjs';
import { getFreePort, waitForPort } from '../net-utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtime = path.join(root, 'desktop', 'runtime');
const xray = path.join(runtime, 'xray.exe');
const fixture = 'vless://11111111-1111-4111-8111-111111111111@example.com:443?encryption=none&security=tls&sni=example.com&type=tcp#Runtime-Test';

function validate(config) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mir2ray-xray-test-'));
  const file = path.join(directory, 'config.json');
  try {
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    return spawnSync(xray, ['run', '-test', '-c', file], {
      cwd: runtime,
      env: { ...process.env, XRAY_LOCATION_ASSET: runtime },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('official Xray runtime is present and reports a version', { skip: !fs.existsSync(xray) }, () => {
  const result = spawnSync(xray, ['version'], { cwd: runtime, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Xray\s+\d+/i);
});

test('official Xray accepts generated speed-test configuration', { skip: !fs.existsSync(xray) }, () => {
  const result = validate(buildSpeedTestConfig({ shareUri: fixture }, 19180));
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('official Xray accepts generated Windows TUN and routing configuration', { skip: !fs.existsSync(xray) }, () => {
  const result = validate(buildMainConfig({ shareUri: fixture, dnsIp: '1.1.1.1' }, {
    socksPort: 19181, httpPort: 19182, apiPort: 19183,
  }));
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Xray Stats API command used by the home chart is compatible', { skip: !fs.existsSync(xray) }, async () => {
  const [socksPort, httpPort, apiPort] = await Promise.all([getFreePort(), getFreePort(), getFreePort()]);
  const config = buildMainConfig({ shareUri: fixture }, { socksPort, httpPort, apiPort });
  config.inbounds = config.inbounds.filter(item => item.protocol !== 'tun');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mir2ray-xray-stats-'));
  const file = path.join(directory, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(xray, ['run', '-c', file], {
    cwd: runtime,
    env: { ...process.env, XRAY_LOCATION_ASSET: runtime },
    windowsHide: true,
    stdio: 'ignore',
  });
  try {
    assert.equal(await waitForPort(apiPort, 5000), true);
    const result = spawnSync(xray, ['api', 'statsquery', `--server=127.0.0.1:${apiPort}`, '-pattern', 'inbound>>>tun>>>traffic>>>'], {
      cwd: runtime, encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  } finally {
    child.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
