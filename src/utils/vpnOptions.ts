import { V2RayConfig } from '../types';
import { isConnectableConfig, rankConfigsForInstagram } from './profileQuality';

export function parsePackageList(value: string | null | undefined): string[] {
  return (value ?? '').split('\n').map(s => s.trim()).filter(Boolean);
}

export function getBalancedConfigGroup(
  configs: V2RayConfig[],
  fallback: V2RayConfig | null,
  enabled: boolean
): V2RayConfig[] {
  if (!enabled) return fallback ? [fallback] : [];
  const ranked = rankConfigsForInstagram(configs)
    .filter(config => isConnectableConfig(config) && config.type !== 'hysteria2');
  if (ranked.length > 0) return ranked.slice(0, 5);
  return fallback && isConnectableConfig(fallback) && fallback.type !== 'hysteria2' ? [fallback] : [];
}
