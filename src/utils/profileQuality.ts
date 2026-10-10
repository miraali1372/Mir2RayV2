import {
  DestinationEvidence,
  DestinationPolicy,
  ExitCountryProvenance,
  V2RayConfig,
  VerificationTier,
} from '../types';
import { isCountryCompatible } from './country';

export interface ConfigQuality {
  score: number;
  latencyScore: number;
  downloadScore: number;
  uploadScore: number;
  reliabilityScore: number;
  tested: boolean;
  usable: boolean;
}

const CONNECTABLE_TYPES = new Set<V2RayConfig['type']>(['vless', 'vmess', 'trojan', 'shadowsocks']);

export const LATENCY_MAX_AGE_MS = 24 * 60 * 60_000;
export const BANDWIDTH_MAX_AGE_MS = 24 * 60 * 60_000;

export function isMeasurementFresh(stamp: string | undefined, maxAgeMs = LATENCY_MAX_AGE_MS, now = Date.now()): boolean {
  const age = now - Date.parse(stamp ?? '');
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

const TIER_LEVELS: Record<string, number> = {
  l4_tcp: 1,
  tcp: 1,
  basic: 1,
  l7_http: 2,
  http: 2,
  standard: 2,
  l7_payload: 3,
  payload: 3,
  strict: 3,
  bandwidth: 3,
  full: 4,
};

export function satisfiesTier(actualTier?: string, requiredTier?: string): boolean {
  if (!requiredTier) return true;
  if (!actualTier) return false;
  const actualLevel = TIER_LEVELS[actualTier.toLowerCase()] ?? 0;
  const requiredLevel = TIER_LEVELS[requiredTier.toLowerCase()] ?? 0;
  return actualLevel >= requiredLevel;
}

export function createDestinationEvidence(
  destinationKey: string,
  options: Partial<DestinationEvidence> = {}
): DestinationEvidence {
  const result: DestinationEvidence = {
    destinationKey,
    destination: options.destination ?? destinationKey,
    status: options.status ?? 'pass',
    checkedAt: options.checkedAt ?? new Date().toISOString(),
    verificationTier: options.verificationTier ?? 'l7_http',
  };
  if (options.httpStatus !== undefined) result.httpStatus = options.httpStatus;
  if (options.statusCode !== undefined || options.httpStatus !== undefined) {
    result.statusCode = options.statusCode ?? options.httpStatus;
  }
  if (options.latency !== undefined) result.latency = options.latency;
  if (options.bytes !== undefined) result.bytes = options.bytes;
  if (options.error !== undefined) result.error = options.error;
  return result;
}

export function getDestinationEvidence(
  config: V2RayConfig,
  destinationKey: string
): DestinationEvidence | undefined {
  const store = config.destinationEvidence ?? config.evidence;
  if (!store) return undefined;
  if (Array.isArray(store)) {
    return store.find(e => e.destinationKey === destinationKey || e.destination === destinationKey);
  }
  return store[destinationKey];
}

export function recordDestinationEvidence(
  config: V2RayConfig,
  evidence: DestinationEvidence
): V2RayConfig {
  const existingMap: Record<string, DestinationEvidence> = Array.isArray(config.destinationEvidence)
    ? Object.fromEntries(config.destinationEvidence.map(e => [e.destinationKey || e.destination || '', e]))
    : { ...(config.destinationEvidence ?? config.evidence ?? {}) };

  const key = evidence.destinationKey || evidence.destination;
  if (key) {
    existingMap[key] = evidence;
  }

  return {
    ...config,
    destinationEvidence: existingMap,
    evidence: existingMap,
  };
}

export function isDestinationEvidencePassing(
  evidence: DestinationEvidence | undefined,
  options: {
    maxLatencyMs?: number;
    minBytes?: number;
    requiredTier?: VerificationTier | string;
    maxAgeMs?: number;
    now?: number;
  } = {}
): boolean {
  if (!evidence) return false;
  const status = evidence.status;
  if (status !== 'pass' && status !== 'success') return false;
  if (evidence.error) return false;

  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? LATENCY_MAX_AGE_MS;
  if (!isMeasurementFresh(evidence.checkedAt, maxAge, now)) return false;

  if (typeof evidence.httpStatus === 'number') {
    if (evidence.httpStatus < 200 || evidence.httpStatus >= 300) return false;
  }

  if (typeof options.maxLatencyMs === 'number') {
    if (typeof evidence.latency !== 'number' || evidence.latency > options.maxLatencyMs) {
      return false;
    }
  }

  if (typeof options.minBytes === 'number') {
    const bytes = typeof evidence.bytes === 'number' ? evidence.bytes : 0;
    if (bytes < options.minBytes) return false;
  }

  if (options.requiredTier && !satisfiesTier(evidence.verificationTier, options.requiredTier)) {
    return false;
  }

  return true;
}

export function getBestDestinationLatency(config: V2RayConfig): number | undefined {
  const store = config.destinationEvidence ?? config.evidence;
  if (!store) return undefined;
  const list = Array.isArray(store) ? store : Object.values(store);
  let best: number | undefined;
  for (const e of list) {
    if (isDestinationEvidencePassing(e) && typeof e.latency === 'number' && e.latency > 0) {
      if (best === undefined || e.latency < best) {
        best = e.latency;
      }
    }
  }
  return best;
}

export function hasPassingL7DestinationEvidence(config: V2RayConfig): boolean {
  const store = config.destinationEvidence ?? config.evidence;
  if (!store) return false;
  const list = Array.isArray(store) ? store : Object.values(store);
  return list.some(e => isDestinationEvidencePassing(e, { requiredTier: 'l7_http' }));
}

export function configMeasurementKey(config: V2RayConfig, context: string): string {
  return JSON.stringify([config.rawUri, config.cleanIp ?? '', config.fragment ?? null, context]);
}

export function hasFreshVerification(config: V2RayConfig): boolean {
  return isMeasurementFresh(config.verifiedAt)
    || (typeof config.realDelay === 'number' && config.realDelay > 0
      && isMeasurementFresh(config.latencyTestedAt ?? config.lastSuccessAt))
    || hasPassingL7DestinationEvidence(config);
}

export function recordConfigFailure(config: V2RayConfig, now = Date.now()): V2RayConfig {
  const failStreak = (config.failStreak ?? 0) + 1;
  return annotateConfigQuality({
    ...config,
    failStreak,
    failureCount: (config.failureCount ?? 0) + 1,
    lastFailureAt: new Date(now).toISOString(),
    retryAfter: now + Math.min(120_000, 5_000 * 2 ** Math.min(5, failStreak - 1)),
    verifiedAt: undefined,
    latencyTestedAt: undefined,
    realDelay: 'error',
    ping: 'error',
  });
}

export function isConnectableConfig(config: Pick<V2RayConfig, 'type' | 'rawUri'>): boolean {
  if (!CONNECTABLE_TYPES.has(config.type) || !config.rawUri) return false;
  if ((config.type === 'vless' || config.type === 'trojan') && config.rawUri.toLowerCase().includes('security=none')) {
    return false;
  }
  return true;
}

export function computeConfigQuality(config: V2RayConfig): ConfigQuality {
  if (!isConnectableConfig(config)) {
    return {
      score: 0,
      latencyScore: 0,
      downloadScore: 0,
      uploadScore: 0,
      reliabilityScore: 0,
      tested: false,
      usable: false,
    };
  }

  const destinationLatency = getBestDestinationLatency(config);
  const effectiveLatency = typeof config.realDelay === 'number'
    ? config.realDelay
    : typeof config.tcpPing === 'number'
      ? config.tcpPing
      : typeof config.ping === 'number'
        ? config.ping
        : destinationLatency;

  const hasLatency = typeof effectiveLatency === 'number' && Number.isFinite(effectiveLatency) && effectiveLatency >= 0;
  const isRealVerified = (typeof config.realDelay === 'number' && config.realDelay > 0)
    || hasPassingL7DestinationEvidence(config);
  const bandwidthFresh = isMeasurementFresh(config.bandwidthTestedAt ?? config.lastSuccessAt, BANDWIDTH_MAX_AGE_MS);
  const hasDownload = bandwidthFresh && typeof config.downloadBps === 'number' && config.downloadBps > 0;
  const hasUpload = bandwidthFresh && typeof config.uploadBps === 'number' && config.uploadBps > 0;
  const hasDestinationTested = Boolean(
    config.destinationEvidence && Object.keys(config.destinationEvidence).length > 0
  );

  const tested = hasLatency
    || hasDownload
    || hasUpload
    || hasDestinationTested
    || config.ping === 'error'
    || config.realDelay === 'error'
    || config.tcpPing === 'error'
    || config.downloadBps === 'error'
    || config.uploadBps === 'error';

  if (!tested) {
    return {
      score: 0,
      latencyScore: 0,
      downloadScore: 0,
      uploadScore: 0,
      reliabilityScore: 0,
      tested: false,
      usable: false,
    };
  }

  // 1. Latency Score (0 to 45 pts)
  let latencyScore = 0;
  if (hasLatency) {
    latencyScore = Math.max(2, Math.min(45, Math.round(55 / (1 + (effectiveLatency as number) / 250))));
  } else if (config.ping === 'error' || config.realDelay === 'error') {
    latencyScore = -25;
  }

  // 2. Download Speed Score (0 to 35 pts)
  let downloadScore = 0;
  if (hasDownload) {
    const bps = config.downloadBps as number;
    if (bps < 100_000) {
      // Bandwidth under 100 kbps is throttled/blocked
      downloadScore = 0;
    } else {
      const mbps = bps / 1_000_000;
      downloadScore = Math.max(3, Math.min(35, Math.round(35 * mbps / (mbps + 2.5))));
    }
  } else if (config.downloadBps === 'error') {
    downloadScore = -15;
  } else if (isRealVerified) {
    downloadScore = 15;
  }

  // 3. Upload Speed Score (0 to 12 pts)
  let uploadScore = 0;
  if (hasUpload) {
    const bps = config.uploadBps as number;
    if (bps < 50_000) {
      uploadScore = 0;
    } else {
      const mbps = bps / 1_000_000;
      uploadScore = Math.max(1, Math.min(12, Math.round(12 * mbps / (mbps + 1.2))));
    }
  } else if (config.uploadBps === 'error') {
    uploadScore = -10;
  } else if (isRealVerified) {
    uploadScore = 5;
  }

  // 4. Reliability & Verification Score (0 to 8 pts)
  let reliabilityScore = 0;
  const failPenalty = Math.min(25, Math.max(0, config.failStreak ?? 0) * 8);
  if (isRealVerified) {
    reliabilityScore = 8 - failPenalty;
  } else if (typeof config.tcpPing === 'number') {
    reliabilityScore = 3 - failPenalty;
  }

  const fresh = hasFreshVerification(config);
  const ageFactor = fresh ? 1 : 0.35;
  const jitterVal = Math.max(0, config.jitter ?? 0);
  const jitterPenalty = jitterVal > 500
    ? 22
    : jitterVal > 250
      ? 14
      : Math.min(8, jitterVal / 30);
  const rawScore = (latencyScore + downloadScore + uploadScore + reliabilityScore - jitterPenalty) * ageFactor;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  const hasBlockedBandwidth = config.downloadBps === 'error'
    || (typeof config.downloadBps === 'number' && config.downloadBps < 100_000 && bandwidthFresh);
  const severePacketLoss = (config.failStreak ?? 0) >= 3;
  const usable = score > 0 && fresh && (config.retryAfter ?? 0) <= Date.now()
    && config.ping !== 'error' && config.realDelay !== 'error'
    && !hasBlockedBandwidth
    && !severePacketLoss;

  return {
    score,
    latencyScore: Math.round(latencyScore),
    downloadScore: Math.round(downloadScore),
    uploadScore: Math.round(uploadScore),
    reliabilityScore: Math.round(reliabilityScore),
    tested,
    usable,
  };
}

export function annotateConfigQuality(config: V2RayConfig, stamp = new Date().toISOString()): V2RayConfig {
  const quality = computeConfigQuality(config);
  return {
    ...config,
    qualityScore: quality.score,
    qualityUpdatedAt: stamp,
  };
}

export function rankConfigs(configs: V2RayConfig[]): V2RayConfig[] {
  return [...configs].sort((a, b) => {
    const qa = computeConfigQuality(a);
    const qb = computeConfigQuality(b);
    if (qa.usable !== qb.usable) return qa.usable ? -1 : 1;
    if (qb.score !== qa.score) return qb.score - qa.score;
    if (qa.tested !== qb.tested) return qa.tested ? -1 : 1;

    const aBalanced = typeof a.downloadBps === 'number' && typeof a.uploadBps === 'number'
      ? Math.min(a.downloadBps, a.uploadBps)
      : -1;
    const bBalanced = typeof b.downloadBps === 'number' && typeof b.uploadBps === 'number'
      ? Math.min(b.downloadBps, b.uploadBps)
      : -1;
    if (bBalanced !== aBalanced) return bBalanced - aBalanced;

    const aRealDelay = typeof a.realDelay === 'number' ? a.realDelay : Number.POSITIVE_INFINITY;
    const bRealDelay = typeof b.realDelay === 'number' ? b.realDelay : Number.POSITIVE_INFINITY;
    if (aRealDelay !== bRealDelay) return aRealDelay - bRealDelay;

    const aLatency = typeof a.tcpPing === 'number'
      ? a.tcpPing
      : typeof a.ping === 'number'
        ? a.ping
        : Number.POSITIVE_INFINITY;
    const bLatency = typeof b.tcpPing === 'number'
      ? b.tcpPing
      : typeof b.ping === 'number'
        ? b.ping
        : Number.POSITIVE_INFINITY;
    if (aLatency !== bLatency) return aLatency - bLatency;

    const bUpload = typeof b.uploadBps === 'number' ? b.uploadBps : -1;
    const aUpload = typeof a.uploadBps === 'number' ? a.uploadBps : -1;
    if (bUpload !== aUpload) return bUpload - aUpload;

    const bDownload = typeof b.downloadBps === 'number' ? b.downloadBps : -1;
    const aDownload = typeof a.downloadBps === 'number' ? a.downloadBps : -1;
    if (bDownload !== aDownload) return bDownload - aDownload;

    const aHint = extractHintLatency(a.name);
    const bHint = extractHintLatency(b.name);
    if (aHint !== bHint) return aHint - bHint;

    return a.name.localeCompare(b.name);
  });
}

function extractHintLatency(name?: string): number {
  if (!name) return Number.POSITIVE_INFINITY;
  const match = name.match(/(\d+)\s*ms/i);
  return match ? parseInt(match[1], 10) : Number.POSITIVE_INFINITY;
}

export function rankConfigsByRealDelay(configs: V2RayConfig[]): V2RayConfig[] {
  return [...configs].sort((a, b) => {
    const aState = typeof a.realDelay === 'number' ? 0 : a.realDelay === 'testing' ? 1 : 2;
    const bState = typeof b.realDelay === 'number' ? 0 : b.realDelay === 'testing' ? 1 : 2;
    if (aState !== bState) return aState - bState;
    if (aState === 0 && bState === 0 && a.realDelay !== b.realDelay) {
      return (a.realDelay as number) - (b.realDelay as number);
    }

    const aTcp = typeof a.tcpPing === 'number' ? 0 : a.tcpPing === 'testing' ? 1 : 2;
    const bTcp = typeof b.tcpPing === 'number' ? 0 : b.tcpPing === 'testing' ? 1 : 2;
    if (aTcp !== bTcp) return aTcp - bTcp;
    if (aTcp === 0 && bTcp === 0 && a.tcpPing !== b.tcpPing) {
      return (a.tcpPing as number) - (b.tcpPing as number);
    }

    const qa = computeConfigQuality(a);
    const qb = computeConfigQuality(b);
    if (qb.score !== qa.score) return qb.score - qa.score;
    return a.name.localeCompare(b.name);
  });
}

export function rankConfigsByTcpLatency(configs: V2RayConfig[]): V2RayConfig[] {
  return [...configs].sort((a, b) => {
    const aReal = typeof a.realDelay === 'number' ? 0 : 1;
    const bReal = typeof b.realDelay === 'number' ? 0 : 1;
    if (aReal !== bReal) return aReal - bReal;
    if (aReal === 0 && bReal === 0 && a.realDelay !== b.realDelay) {
      return (a.realDelay as number) - (b.realDelay as number);
    }

    const aState = typeof a.tcpPing === 'number' ? 0 : a.tcpPing === 'testing' ? 1 : 2;
    const bState = typeof b.tcpPing === 'number' ? 0 : b.tcpPing === 'testing' ? 1 : 2;
    if (aState !== bState) return aState - bState;
    if (aState === 0 && bState === 0 && a.tcpPing !== b.tcpPing) {
      return (a.tcpPing as number) - (b.tcpPing as number);
    }

    const qa = computeConfigQuality(a);
    const qb = computeConfigQuality(b);
    if (qb.score !== qa.score) return qb.score - qa.score;
    return a.name.localeCompare(b.name);
  });
}

export function rankConfigsByDownloadSpeed(configs: V2RayConfig[]): V2RayConfig[] {
  return [...configs].sort((a, b) => {
    const aBps = typeof a.downloadBps === 'number' ? a.downloadBps : a.downloadBps === 'testing' ? 0 : -1;
    const bBps = typeof b.downloadBps === 'number' ? b.downloadBps : b.downloadBps === 'testing' ? 0 : -1;
    if (bBps !== aBps) return bBps - aBps;

    const aReal = typeof a.realDelay === 'number' ? a.realDelay : 999999;
    const bReal = typeof b.realDelay === 'number' ? b.realDelay : 999999;
    if (aReal !== bReal) return aReal - bReal;

    const qa = computeConfigQuality(a);
    const qb = computeConfigQuality(b);
    if (qb.score !== qa.score) return qb.score - qa.score;
    return a.name.localeCompare(b.name);
  });
}

export function rankConfigsForInstagram(configs: V2RayConfig[]): V2RayConfig[] {
  const hasFreshBandwidth = configs.some(config => (
    typeof config.downloadBps === 'number' && typeof config.uploadBps === 'number'
      && isMeasurementFresh(config.bandwidthTestedAt ?? config.lastSuccessAt, BANDWIDTH_MAX_AGE_MS)
  ));
  if (hasFreshBandwidth) return rankConfigs(configs);
  if (configs.some(config => typeof config.realDelay === 'number')) {
    return rankConfigsByRealDelay(configs);
  }
  if (configs.some(config => typeof config.tcpPing === 'number')) {
    return rankConfigsByTcpLatency(configs);
  }
  return rankConfigs(configs);
}

export interface PickBestConfigOptions {
  excludeId?: string;
  minScore?: number;
  requireTested?: boolean;
  requiredDestinations?: string[];
  destinationPolicy?: DestinationPolicy;
  requiredCountry?: string;
  targetCountry?: string;
  requireMeasuredCountry?: boolean;
  requiredTier?: VerificationTier | string;
  maxLatencyMs?: number;
  minBytes?: number;
  now?: number;
}

export type DestinationEligibilityOptions = PickBestConfigOptions;

export function isConfigEligible(
  config: V2RayConfig,
  options: DestinationEligibilityOptions = {}
): boolean {
  const now = options.now ?? Date.now();
  const { excludeId, minScore = 1, requireTested = true } = options;

  if (excludeId && config.id === excludeId) return false;
  if (!isConnectableConfig(config)) return false;
  if ((config.retryAfter ?? 0) > now) return false;

  const quality = computeConfigQuality(config);
  if (requireTested) {
    if (!quality.tested || !quality.usable) return false;
  }
  if (quality.score < minScore) return false;
  if (config.ping === 'error' || config.realDelay === 'error') return false;

  // Country policy check (FAIL-CLOSED)
  const policy = options.destinationPolicy;
  const targetCountry = options.requiredCountry
    ?? options.targetCountry
    ?? policy?.requiredCountry
    ?? policy?.targetCountry;

  if (targetCountry) {
    if (!isCountryCompatible(config, targetCountry)) {
      return false;
    }
  }

  const requireMeasured = options.requireMeasuredCountry
    ?? policy?.requireMeasuredCountry
    ?? (policy?.failClosedCountry && targetCountry != null);

  if (requireMeasured) {
    if (config.exitCountryProvenance !== 'measured') {
      return false;
    }
  }

  // Destination policy check
  const requiredDestinations = options.requiredDestinations ?? policy?.requiredDestinations;
  if (requiredDestinations && requiredDestinations.length > 0) {
    const requiredTier = options.requiredTier ?? policy?.requiredTier;
    const maxLatencyMs = options.maxLatencyMs ?? policy?.maxLatencyMs;
    const minBytes = options.minBytes ?? policy?.minBytes;
    const requireAll = policy?.requireAll ?? true;
    const minPassing = policy?.minPassingDestinations ?? (requireAll ? requiredDestinations.length : 1);

    let passingCount = 0;
    for (const destKey of requiredDestinations) {
      const evidence = getDestinationEvidence(config, destKey);
      if (isDestinationEvidencePassing(evidence, {
        maxLatencyMs,
        minBytes,
        requiredTier,
        now,
      })) {
        passingCount += 1;
      }
    }

    if (requireAll && passingCount < requiredDestinations.length) {
      return false;
    }
    if (passingCount < minPassing) {
      return false;
    }
  }

  return true;
}

export function satisfiesDestinationPolicy(
  config: V2RayConfig,
  policy: DestinationPolicy,
  now = Date.now()
): boolean {
  return isConfigEligible(config, { destinationPolicy: policy, now });
}

function countPassingDestinations(
  config: V2RayConfig,
  destinations: string[],
  options: PickBestConfigOptions
): number {
  let count = 0;
  for (const d of destinations) {
    const ev = getDestinationEvidence(config, d);
    if (isDestinationEvidencePassing(ev, {
      maxLatencyMs: options.maxLatencyMs ?? options.destinationPolicy?.maxLatencyMs,
      minBytes: options.minBytes ?? options.destinationPolicy?.minBytes,
      requiredTier: options.requiredTier ?? options.destinationPolicy?.requiredTier,
      now: options.now,
    })) {
      count++;
    }
  }
  return count;
}

function getAverageDestinationLatency(config: V2RayConfig, destinations: string[]): number {
  let sum = 0;
  let count = 0;
  for (const d of destinations) {
    const ev = getDestinationEvidence(config, d);
    if (ev && typeof ev.latency === 'number' && ev.latency > 0) {
      sum += ev.latency;
      count++;
    }
  }
  return count > 0 ? sum / count : Number.POSITIVE_INFINITY;
}

export function rankConfigsByDestinationEvidence(
  configs: V2RayConfig[],
  destinations: string[] = []
): V2RayConfig[] {
  return [...configs].sort((a, b) => {
    if (destinations.length > 0) {
      const aPass = countPassingDestinations(a, destinations, {});
      const bPass = countPassingDestinations(b, destinations, {});
      if (bPass !== aPass) return bPass - aPass;

      const aLat = getAverageDestinationLatency(a, destinations);
      const bLat = getAverageDestinationLatency(b, destinations);
      if (aLat !== bLat) return aLat - bLat;
    }
    const qa = computeConfigQuality(a);
    const qb = computeConfigQuality(b);
    if (qb.score !== qa.score) return qb.score - qa.score;
    return a.name.localeCompare(b.name);
  });
}

export function pickBestConfig(
  configs: V2RayConfig[],
  options: PickBestConfigOptions = {}
): V2RayConfig | null {
  const reqDests = options.requiredDestinations ?? options.destinationPolicy?.requiredDestinations;
  const candidatePool = reqDests && reqDests.length > 0
    ? rankConfigsByDestinationEvidence(configs, reqDests)
    : rankConfigsForInstagram(configs);

  return candidatePool.find(config => isConfigEligible(config, options)) ?? null;
}
