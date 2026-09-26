import { V2RayConfig } from '../types';

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

export function configMeasurementKey(config: V2RayConfig, context: string): string {
  return JSON.stringify([config.rawUri, config.cleanIp ?? '', config.fragment ?? null, context]);
}

export function hasFreshVerification(config: V2RayConfig): boolean {
  return isMeasurementFresh(config.verifiedAt)
    || (typeof config.realDelay === 'number' && config.realDelay > 0
      && isMeasurementFresh(config.latencyTestedAt ?? config.lastSuccessAt));
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

  const effectiveLatency = typeof config.realDelay === 'number'
    ? config.realDelay
    : typeof config.tcpPing === 'number'
      ? config.tcpPing
      : typeof config.ping === 'number'
        ? config.ping
        : undefined;

  const hasLatency = typeof effectiveLatency === 'number' && Number.isFinite(effectiveLatency) && effectiveLatency >= 0;
  const isRealVerified = typeof config.realDelay === 'number' && config.realDelay > 0;
  const bandwidthFresh = isMeasurementFresh(config.bandwidthTestedAt ?? config.lastSuccessAt, BANDWIDTH_MAX_AGE_MS);
  const hasDownload = bandwidthFresh && typeof config.downloadBps === 'number' && config.downloadBps > 0;
  const hasUpload = bandwidthFresh && typeof config.uploadBps === 'number' && config.uploadBps > 0;

  const tested = hasLatency
    || hasDownload
    || hasUpload
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
    const mbps = (config.downloadBps as number) / 1_000_000;
    downloadScore = Math.max(3, Math.min(35, Math.round(35 * mbps / (mbps + 2.5))));
  } else if (isRealVerified) {
    downloadScore = 15;
  }

  // 3. Upload Speed Score (0 to 12 pts)
  let uploadScore = 0;
  if (hasUpload) {
    const mbps = (config.uploadBps as number) / 1_000_000;
    uploadScore = Math.max(1, Math.min(12, Math.round(12 * mbps / (mbps + 1.2))));
  } else if (isRealVerified) {
    uploadScore = 5;
  }

  // 4. Reliability & Verification Score (0 to 8 pts)
  let reliabilityScore = 0;
  const failPenalty = Math.min(18, Math.max(0, config.failStreak ?? 0) * 6);
  if (isRealVerified) {
    reliabilityScore = 8 - failPenalty;
  } else if (typeof config.tcpPing === 'number') {
    reliabilityScore = 3 - failPenalty;
  }

  const fresh = hasFreshVerification(config);
  const ageFactor = fresh ? 1 : 0.35;
  const jitterPenalty = Math.min(8, Math.max(0, config.jitter ?? 0) / 30);
  const rawScore = (latencyScore + downloadScore + uploadScore + reliabilityScore - jitterPenalty) * ageFactor;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const usable = score > 0 && fresh && (config.retryAfter ?? 0) <= Date.now()
    && config.ping !== 'error' && config.realDelay !== 'error';

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

export function pickBestConfig(
  configs: V2RayConfig[],
  options: { excludeId?: string; minScore?: number; requireTested?: boolean } = {}
): V2RayConfig | null {
  const { excludeId, minScore = 1, requireTested = true } = options;
  return rankConfigsForInstagram(configs).find(config => {
    if (excludeId && config.id === excludeId) return false;
    const quality = computeConfigQuality(config);
    if (!quality.usable || quality.score < minScore) return false;
    if (requireTested && !quality.tested) return false;
    return true;
  }) ?? null;
}
