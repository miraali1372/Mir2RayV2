import { V2RayConfig } from '../types';
import {
  annotateConfigQuality, configMeasurementKey, hasFreshVerification,
  isConnectableConfig, rankConfigs, recordConfigFailure,
} from './profileQuality';

export function invalidateMeasurements(config: V2RayConfig, context: string): V2RayConfig {
  if (config.measurementKey === configMeasurementKey(config, context)) return config;
  return {
    ...config, ping: undefined, tcpPing: undefined, realDelay: undefined,
    downloadBps: undefined, uploadBps: undefined, verifiedAt: undefined,
    latencyTestedAt: undefined, bandwidthTestedAt: undefined, lastSuccessAt: undefined,
    retryAfter: undefined, qualityScore: undefined, coldDelay: undefined, jitter: undefined,
    successCount: 0, failureCount: 0, failStreak: 0,
    measurementKey: configMeasurementKey(config, context),
  };
}

export function connectionCandidates(configs: V2RayConfig[], preferredId?: string | null): V2RayConfig[] {
  const eligible = configs.filter(config => isConnectableConfig(config) && (config.retryAfter ?? 0) <= Date.now());
  const ranked = rankConfigs(eligible);
  const verified = ranked.filter(hasFreshVerification);
  const unverified = ranked.filter(config => !hasFreshVerification(config));
  const preferred = unverified.find(config => config.id === preferredId);
  return [...verified, ...(preferred ? [preferred] : []), ...unverified.filter(config => config !== preferred)].slice(0, 24);
}

export interface MobileProbeResult {
  ok: boolean;
  latency: number;
  coldLatency?: number;
  jitter?: number;
}

export async function screenMobileConfigs(options: {
  configs: V2RayConfig[];
  context: string;
  probe: (config: V2RayConfig) => Promise<MobileProbeResult>;
  stopped: () => boolean;
  onResult: (config: V2RayConfig) => void;
  budgetMs?: number;
  targetCount?: number;
  workers?: number;
}): Promise<{ tested: number; verified: number }> {
  const candidates = connectionCandidates(options.configs.map(config => invalidateMeasurements(config, options.context)));
  const deadline = Date.now() + (options.budgetMs ?? 8_000);
  let nextIndex = 0;
  let tested = 0;
  let verified = 0;
  const worker = async () => {
    while (!options.stopped() && Date.now() < deadline && verified < (options.targetCount ?? 3)) {
      const candidate = candidates[nextIndex++];
      if (!candidate) return;
      let result: MobileProbeResult;
      try { result = await options.probe(candidate); }
      catch { result = { ok: false, latency: -1 }; }
      if (options.stopped()) return;
      tested += 1;
      if (result.ok && Number.isFinite(result.latency) && result.latency > 0) {
        verified += 1;
        const stamp = new Date().toISOString();
        options.onResult(annotateConfigQuality({
          ...candidate, ping: result.latency, realDelay: result.latency,
          coldDelay: result.coldLatency, jitter: result.jitter,
          latencyTestedAt: stamp, lastSuccessAt: stamp, failStreak: 0,
          successCount: (candidate.successCount ?? 0) + 1, retryAfter: undefined,
        }, stamp));
      } else {
        options.onResult(recordConfigFailure(candidate));
      }
    }
  };
  const concurrency = Math.min(options.workers ?? 4, candidates.length);
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { tested, verified };
}