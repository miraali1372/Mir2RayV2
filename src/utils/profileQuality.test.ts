import assert from 'node:assert/strict';
import test from 'node:test';
import { configMeasurementKey } from './profileQuality';
import { connectionCandidates, invalidateMeasurements, screenMobileConfigs } from './mobileSelection';
import { V2RayConfig } from '../types';
import {
  computeConfigQuality,
  pickBestConfig,
  rankConfigsForInstagram,
} from './profileQuality';

function config(overrides: Partial<V2RayConfig>): V2RayConfig {
  return {
    id: String(overrides.id ?? 'config'),
    name: String(overrides.name ?? overrides.id ?? 'Config'),
    type: 'vless',
    address: 'example.test',
    port: '443',
    rawUri: 'vless://test@example.test:443',
    ...overrides,
  };
}

test('Instagram ranking follows TCP and then Meta real delay before bandwidth exists', () => {
  const tcpRanked = rankConfigsForInstagram([
    config({ id: 'slow', tcpPing: 240 }),
    config({ id: 'fast', tcpPing: 85 }),
  ]);
  assert.deepEqual(tcpRanked.map(item => item.id), ['fast', 'slow']);

  const realRanked = rankConfigsForInstagram([
    config({ id: 'middle', tcpPing: 90, realDelay: 170, ping: 170 }),
    config({ id: 'slow', tcpPing: 80, realDelay: 246, ping: 246 }),
    config({ id: 'fast', tcpPing: 150, realDelay: 155, ping: 155 }),
  ]);
  assert.deepEqual(realRanked.map(item => item.id), ['fast', 'middle', 'slow']);
});

test('fresh bandwidth promotes balanced Instagram throughput after the latency stage', () => {
  const ranked = rankConfigsForInstagram([
    config({
      id: 'low-throughput',
      ping: 100,
      realDelay: 100,
      downloadBps: 2_000_000,
      uploadBps: 2_000_000,
      lastSuccessAt: new Date().toISOString(),
    }),
    config({
      id: 'balanced',
      ping: 180,
      realDelay: 180,
      downloadBps: 20_000_000,
      uploadBps: 20_000_000,
      lastSuccessAt: new Date().toISOString(),
    }),
  ]);
  assert.equal(ranked[0].id, 'balanced');
});

test('quality does not award an unmeasured protocol or clean-IP bonus', () => {
  const base = config({ id: 'base', ping: 150, lastSuccessAt: '2026-01-01T00:00:00.000Z' });
  const decorated = config({
    ...base,
    id: 'decorated',
    cleanIp: '198.51.100.7',
    rawUri: 'vless://test@example.test:443?security=reality',
  });
  assert.equal(computeConfigQuality(base).score, computeConfigQuality(decorated).score);
});

test('automatic selection never promotes an untested or TCP-only config', () => {
  const untested = config({ id: 'untested' });
  const tcpOnly = config({ id: 'tcp-only', ping: 50, tcpPing: 50, lastSuccessAt: new Date().toISOString() });
  assert.equal(computeConfigQuality(untested).usable, false);
  assert.equal(pickBestConfig([untested, tcpOnly]), null);
});

test('expired measurements cannot beat a fresh verified candidate', () => {
  const expired = config({
    id: 'expired', ping: 30, realDelay: 30, downloadBps: 100_000_000, uploadBps: 100_000_000,
    lastSuccessAt: '2025-01-01T00:00:00.000Z',
  });
  const fresh = config({
    id: 'fresh', ping: 300, realDelay: 300, lastSuccessAt: new Date().toISOString(),
  });
  assert.equal(pickBestConfig([expired, fresh])?.id, 'fresh');
  assert.equal(pickBestConfig([expired]), null);
});

test('a slow working config remains available when it is the only verified route', () => {
  const available = config({
    id: 'available', ping: 850, realDelay: 850, downloadBps: 600_000, uploadBps: 200_000,
    lastSuccessAt: new Date().toISOString(),
  });
  assert.equal(pickBestConfig([available])?.id, 'available');
});

test('network and configuration changes invalidate measurements without deleting the profile', () => {
  const measured = config({ id: 'retained', realDelay: 80, ping: 80, lastSuccessAt: new Date().toISOString() });
  measured.measurementKey = configMeasurementKey(measured, 'wifi');
  assert.equal(invalidateMeasurements(measured, 'wifi'), measured);
  const changed = invalidateMeasurements(measured, 'mobile');
  assert.equal(changed.id, 'retained');
  assert.equal(changed.rawUri, measured.rawUri);
  assert.equal(pickBestConfig([changed]), null);
  assert.equal(invalidateMeasurements({ ...measured, cleanIp: '198.51.100.8' }, 'wifi').realDelay, undefined);
});

test('mobile screening is bounded and reports failures without deleting candidates', async () => {
  const candidates = Array.from({ length: 100 }, (_, index) => config({ id: String(index) }));
  const updates: V2RayConfig[] = [];
  const result = await screenMobileConfigs({
    configs: candidates, context: 'network', stopped: () => false,
    probe: async candidate => ({ ok: candidate.id !== '0', latency: 700 }),
    onResult: candidate => updates.push(candidate), targetCount: 1,
  });
  assert.ok(result.tested <= 6);
  assert.ok(result.verified >= 1);
  assert.equal(candidates.length, 100);
  assert.ok(updates.find(candidate => candidate.id === '0')?.retryAfter);
  assert.equal(connectionCandidates(updates).some(candidate => candidate.id === '0'), false);
});
