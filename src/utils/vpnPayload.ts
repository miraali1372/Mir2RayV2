import { FragmentSettings, V2RayConfig, DnsServer } from '../types';

export interface VpnStartPayload {
  shareUri: string;
  dnsIp?: string;
  cleanIp?: string;
  fragment?: FragmentSettings;
  strictDns?: boolean;
}

export function buildVpnStartPayload(
  config: V2RayConfig,
  dns: DnsServer | null
): VpnStartPayload {
  return {
    // Use the raw share link for runtime so cleanIp/DNS are applied exactly once natively.
    shareUri: config.rawUri,
    dnsIp: dns?.ip,
    cleanIp: config.cleanIp,
    fragment: config.fragment,
    strictDns: Boolean(dns?.ip),
  };
}

export function serializeVpnPayload(payload: VpnStartPayload): string {
  return JSON.stringify(payload);
}
