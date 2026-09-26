import { FragmentSettings, V2RayConfig, DnsServer } from '../types';

export interface VpnStartPayload {
  shareUri: string;
  shareUris?: string[];
  balancedProfiles?: Array<{
    shareUri: string;
    cleanIp?: string;
    fragment?: FragmentSettings;
  }>;
  balanceMode?: 'single' | 'top5';
  dnsIp?: string;
  cleanIp?: string;
  fragment?: FragmentSettings;
  strictDns?: boolean;
  fakeDns?: boolean;
  doh?: boolean;
}

export function buildVpnStartPayload(
  config: V2RayConfig,
  dns: DnsServer | null,
  options?: { fakeDns?: boolean; doh?: boolean }
): VpnStartPayload {
  return {
    // Use the raw share link for runtime so cleanIp/DNS are applied exactly once natively.
    shareUri: config.rawUri,
    dnsIp: dns?.ip,
    cleanIp: config.cleanIp,
    fragment: config.fragment,
    // Prefer the selected DNS, but do not make it a single point of failure for
    // the live VPN. Native runtime adds stable fallbacks so apps keep resolving
    // even when the chosen DNS is slow from inside the tunnel.
    strictDns: false,
    fakeDns: options?.fakeDns,
    doh: options?.doh,
  };
}

export function serializeVpnPayload(payload: VpnStartPayload): string {
  return JSON.stringify(payload);
}
