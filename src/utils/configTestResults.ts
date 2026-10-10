import type { V2RayConfig } from '../types';

export function isValidLatency(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}

export function isSuccessfulConfigTest(config: V2RayConfig): boolean {
  return isValidLatency(config.tcpPing) && isValidLatency(config.realDelay, Number.MIN_VALUE) && isValidLatency(config.ping, Number.MIN_VALUE);
}

export function retainSuccessfulConfigTests(configs: V2RayConfig[]): V2RayConfig[] {
  return configs.filter(isSuccessfulConfigTest);
}

export function removeFailedConfig(configs: V2RayConfig[], id: string): V2RayConfig[] {
  return configs.filter(config => config.id !== id);
}
