import assert from 'node:assert/strict';
import test from 'node:test';
import { configMeasurementKey } from './profileQuality';
import { connectionCandidates, invalidateMeasurements, screenMobileConfigs } from './mobileSelection';
import { V2RayConfig } from '../types';
import {
  computeConfigQuality,
  createDestinationEvidence,
  getDestinationEvidence,
  isConfigEligible,
  isDestinationEvidencePassing,
  pickBestConfig,
  rankConfigsForInstagram,
  recordDestinationEvidence,
  satisfiesTier,
} from './profileQuality';
import {
  TARGET_KEYS,
  TARGET_KEY_GOOGLE,
  TARGET_KEY_META,
  TARGET_KEY_YOUTUBE,
  TARGET_KEY_DOWNLOAD,
  REQUIRED_POLICY_DEFAULT,
  REQUIRED_POLICY_INSTAGRAM,
  REQUIRED_POLICY_STRICT,
  VERIFICATION_TIERS,
} from '../constants/testTargets';
import {
  isCountryCompatible,
  checkCountryCompatibility,
  normalizeCountryCode,
  determineExitCountryProvenance,
} from './country';

function config(overrides: Partial<V2RayConfig>): V2RayConfig {
  return {
    id: String(overrides.id ?? 'config'),
    name: String(overrides.name ?? overrides.id ?? 'Config'),
    type: 'vless',
    address: 'example.test',
    port: '443',
    rawUri: 'vless:\x2f\x2ftest@example.test:443',
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
    rawUri: 'vless:\x2f\x2ftest@example.test:443?security=reality',
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

test('destination evidence records are serializable and preserve all required properties', () => {
  const stamp = new Date().toISOString();
  const evidence = createDestinationEvidence(TARGET_KEY_GOOGLE, {
    status: 'pass',
    httpStatus: 204,
    latency: 145,
    bytes: 0,
    verificationTier: VERIFICATION_TIERS.L7_HTTP,
    checkedAt: stamp,
  });

  assert.equal(evidence.destinationKey, TARGET_KEY_GOOGLE);
  assert.equal(evidence.destination, TARGET_KEY_GOOGLE);
  assert.equal(evidence.status, 'pass');
  assert.equal(evidence.httpStatus, 204);
  assert.equal(evidence.latency, 145);
  assert.equal(evidence.bytes, 0);
  assert.equal(evidence.error, undefined);
  assert.equal(evidence.checkedAt, stamp);
  assert.equal(evidence.verificationTier, 'l7_http');

  // Verify full JSON serializability
  const serialized = JSON.stringify(evidence);
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed, evidence);

  // Verify attachment to config and retrieval
  const baseConfig = config({ id: 'cfg-evidence' });
  const updated = recordDestinationEvidence(baseConfig, evidence);
  const retrieved = getDestinationEvidence(updated, TARGET_KEY_GOOGLE);
  assert.ok(retrieved);
  assert.equal(retrieved.destinationKey, TARGET_KEY_GOOGLE);
  assert.equal(retrieved.latency, 145);
});

test('verification tier hierarchy correctly evaluates compliance', () => {
  assert.equal(satisfiesTier('l7_http', 'l4_tcp'), true);
  assert.equal(satisfiesTier('l7_payload', 'l7_http'), true);
  assert.equal(satisfiesTier('l4_tcp', 'l7_http'), false);
  assert.equal(satisfiesTier('basic', 'standard'), false);
  assert.equal(satisfiesTier('standard', 'basic'), true);
  assert.equal(satisfiesTier('strict', 'standard'), true);
  assert.equal(satisfiesTier('standard', 'strict'), false);
  assert.equal(satisfiesTier('full', 'strict'), true);
  assert.equal(satisfiesTier(undefined, 'l7_http'), false);
  assert.equal(satisfiesTier('l7_http', undefined), true);
});

test('fail-closed country compatibility strictly rejects unknown and inferred provenance', () => {
  // 1. Provenance 'unknown' must be rejected
  const unknownProv = config({
    id: 'unknown-country',
    exitCountry: 'DE',
    exitCountryProvenance: 'unknown',
  });
  assert.equal(isCountryCompatible(unknownProv, 'DE'), false);
  const unknownCheck = checkCountryCompatibility(unknownProv, 'DE');
  assert.equal(unknownCheck.compatible, false);
  assert.ok(unknownCheck.reason?.includes('fail-closed'));

  // 2. Provenance 'inferred' must be rejected (fail-closed rule)
  const inferredProv = config({
    id: 'inferred-country',
    exitCountry: 'DE',
    exitCountryProvenance: 'inferred',
    name: '🇩🇪 Germany Fast',
  });
  assert.equal(isCountryCompatible(inferredProv, 'DE'), false);
  const inferredCheck = checkCountryCompatibility(inferredProv, 'DE');
  assert.equal(inferredCheck.compatible, false);
  assert.ok(inferredCheck.reason?.includes('fail-closed'));

  // 3. Unspecified provenance must be treated as unknown and rejected
  const noProv = config({
    id: 'no-prov',
    exitCountry: 'DE',
  });
  assert.equal(isCountryCompatible(noProv, 'DE'), false);

  // 4. Inferred only from config name must be rejected
  const nameOnly = config({
    id: 'name-only',
    name: '🇩🇪 Germany Reality Server',
  });
  assert.equal(isCountryCompatible(nameOnly, 'DE'), false);

  // 5. Provenance 'measured' matching expected country must succeed
  const measuredProv = config({
    id: 'measured-country',
    exitCountry: 'DE',
    exitCountryProvenance: 'measured',
  });
  assert.equal(isCountryCompatible(measuredProv, 'DE'), true);
  assert.equal(isCountryCompatible(measuredProv, 'de'), true);
  assert.equal(isCountryCompatible(measuredProv, 'آلمان'), true);

  // 6. Provenance 'measured' but country mismatch must fail
  assert.equal(isCountryCompatible(measuredProv, 'US'), false);

  // 7. No expected country required allows any config
  assert.equal(isCountryCompatible(inferredProv), true);
  assert.equal(isCountryCompatible(unknownProv), true);

  // 8. Helper determineExitCountryProvenance
  assert.equal(determineExitCountryProvenance({ measured: true }), 'measured');
  assert.equal(determineExitCountryProvenance({ hasMeasuredExitIp: true }), 'measured');
  assert.equal(determineExitCountryProvenance({ inferredFromName: true }), 'inferred');
  assert.equal(determineExitCountryProvenance({}), 'unknown');
  assert.equal(determineExitCountryProvenance({ provenanceOverride: 'measured' }), 'measured');
});

test('destination-aware eligibility enforces destinations, tiers, and limits', () => {
  const stamp = new Date().toISOString();
  const validGoogleEvidence = createDestinationEvidence(TARGET_KEY_GOOGLE, {
    status: 'pass',
    httpStatus: 204,
    latency: 120,
    verificationTier: VERIFICATION_TIERS.L7_HTTP,
    checkedAt: stamp,
  });
  const validMetaEvidence = createDestinationEvidence(TARGET_KEY_META, {
    status: 'pass',
    httpStatus: 204,
    latency: 180,
    verificationTier: VERIFICATION_TIERS.L7_HTTP,
    checkedAt: stamp,
  });
  const failedMetaEvidence = createDestinationEvidence(TARGET_KEY_META, {
    status: 'fail',
    error: 'timeout',
    checkedAt: stamp,
  });

  const verifiedConfig = config({
    id: 'dual-verified',
    realDelay: 150,
    ping: 150,
    lastSuccessAt: stamp,
    destinationEvidence: {
      [TARGET_KEY_GOOGLE]: validGoogleEvidence,
      [TARGET_KEY_META]: validMetaEvidence,
    },
  });

  // Base eligibility passes
  assert.equal(isConfigEligible(verifiedConfig), true);

  // Required destination present and passing
  assert.equal(
    isConfigEligible(verifiedConfig, { requiredDestinations: [TARGET_KEY_GOOGLE, TARGET_KEY_META] }),
    true
  );

  // Missing destination fails eligibility
  assert.equal(
    isConfigEligible(verifiedConfig, { requiredDestinations: [TARGET_KEY_DOWNLOAD] }),
    false
  );

  // Max latency exceeded fails eligibility
  assert.equal(
    isConfigEligible(verifiedConfig, { requiredDestinations: [TARGET_KEY_META], maxLatencyMs: 100 }),
    false
  );

  // Failed destination status fails eligibility
  const withFailedMeta = recordDestinationEvidence(verifiedConfig, failedMetaEvidence);
  assert.equal(
    isConfigEligible(withFailedMeta, { requiredDestinations: [TARGET_KEY_META] }),
    false
  );
});

test('pickBestConfig with destination and fail-closed country policy', () => {
  const stamp = new Date().toISOString();

  // Config A: German, measured exit country, passing meta evidence
  const germanMeasured = config({
    id: 'de-measured',
    realDelay: 160,
    ping: 160,
    exitCountry: 'DE',
    exitCountryProvenance: 'measured',
    lastSuccessAt: stamp,
    destinationEvidence: {
      [TARGET_KEY_META]: createDestinationEvidence(TARGET_KEY_META, {
        status: 'pass',
        latency: 160,
        verificationTier: 'l7_http',
        checkedAt: stamp,
      }),
      [TARGET_KEY_GOOGLE]: createDestinationEvidence(TARGET_KEY_GOOGLE, {
        status: 'pass',
        latency: 140,
        verificationTier: 'l7_http',
        checkedAt: stamp,
      }),
    },
  });

  // Config B: German, inferred exit country (lower latency, but inferred)
  const germanInferred = config({
    id: 'de-inferred',
    realDelay: 90,
    ping: 90,
    exitCountry: 'DE',
    exitCountryProvenance: 'inferred',
    name: '🇩🇪 Germany Super Fast',
    lastSuccessAt: stamp,
    destinationEvidence: {
      [TARGET_KEY_META]: createDestinationEvidence(TARGET_KEY_META, {
        status: 'pass',
        latency: 90,
        verificationTier: 'l7_http',
        checkedAt: stamp,
      }),
    },
  });

  // Config C: US, measured exit country, passing meta evidence
  const usMeasured = config({
    id: 'us-measured',
    realDelay: 120,
    ping: 120,
    exitCountry: 'US',
    exitCountryProvenance: 'measured',
    lastSuccessAt: stamp,
    destinationEvidence: {
      [TARGET_KEY_META]: createDestinationEvidence(TARGET_KEY_META, {
        status: 'pass',
        latency: 120,
        verificationTier: 'l7_http',
        checkedAt: stamp,
      }),
    },
  });

  // When policy requires 'DE' country:
  // Fail-closed MUST reject de-inferred (despite lower latency) and pick de-measured!
  const pickedGerman = pickBestConfig([germanInferred, germanMeasured, usMeasured], {
    requiredCountry: 'DE',
    requiredDestinations: [TARGET_KEY_META],
  });
  assert.equal(pickedGerman?.id, 'de-measured');

  // If only inferred German config is available, it returns null (fail-closed)
  const pickedOnlyInferred = pickBestConfig([germanInferred], {
    requiredCountry: 'DE',
  });
  assert.equal(pickedOnlyInferred, null);

  // When policy requires Instagram destination policy preset:
  const pickedInstagram = pickBestConfig([germanMeasured, usMeasured], {
    destinationPolicy: REQUIRED_POLICY_INSTAGRAM,
  });
  assert.ok(pickedInstagram);

  // Legacy callers without options still work exactly as before
  const legacyPick = pickBestConfig([germanInferred, germanMeasured]);
  assert.ok(legacyPick);
});
