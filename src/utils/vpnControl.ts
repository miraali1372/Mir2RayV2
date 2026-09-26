import Xray from '../plugins/xray';
import { Capacitor } from '@capacitor/core';
import { V2RayConfig, DnsServer } from '../types';
import { buildVpnStartPayload } from './vpnPayload';

/**
 * Start VPN with the given configuration
 */
export async function startVpn(
  config: V2RayConfig,
  activeDns: DnsServer | null,
  options: {
    fakeDns?: boolean;
    doh?: boolean;
    topFiveEnabled?: boolean;
    balancedConfigs?: V2RayConfig[];
    routingMode?: 'global' | 'apps';
    allowedApps?: string[];
    disallowedApps?: string[];
    recoveryConfigs?: V2RayConfig[];
  } = {}
): Promise<{ success: boolean; error?: string; fallbackToSingle?: boolean }> {
  const payload = buildVpnStartPayload(config, activeDns, {
    fakeDns: options.fakeDns,
    doh: options.doh,
  });

  const useTopFive = options.topFiveEnabled && options.balancedConfigs && options.balancedConfigs.length > 1;

  const buildFullPayload = (topFive: boolean) => ({
      ...payload,
      configId: config.id,
      autoRecover: Capacitor.getPlatform() === 'android',
      recoveryProfiles: options.recoveryConfigs?.slice(0, 5).map(candidate => ({
        configId: candidate.id, shareUri: candidate.rawUri,
        cleanIp: candidate.cleanIp, fragment: candidate.fragment,
      })),
      balanceMode: topFive ? 'top5' : 'single',
      shareUris: topFive ? options.balancedConfigs!.map(item => item.rawUri) : undefined,
      balancedProfiles: topFive
        ? options.balancedConfigs!.map(item => ({
            shareUri: item.rawUri,
            cleanIp: item.cleanIp,
            fragment: item.fragment,
          }))
        : undefined,
      allowedApps: options.routingMode === 'apps' ? options.allowedApps : [],
      disallowedApps: options.routingMode === 'apps' ? options.disallowedApps : [],
  });

  const invokeStart = async (topFive: boolean): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = await Xray.startVpn({ config: JSON.stringify(buildFullPayload(topFive)) });
      if (result.status === 'error') {
        return { success: false, error: result.message || 'VPN start failed' };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'VPN start failed' };
    }
  };

  if (!useTopFive) {
    return invokeStart(false);
  }

  const balancedResult = await invokeStart(true);
  if (balancedResult.success) {
    return { success: true };
  }

  const singleResult = await invokeStart(false);
  if (singleResult.success) {
    return { success: true, fallbackToSingle: true, error: balancedResult.error };
  }

  return {
    success: false,
    error: `${balancedResult.error || 'Top 5 VPN start failed'}; single retry failed: ${singleResult.error || 'VPN start failed'}`,
  };
}

/**
 * Stop VPN
 */
export async function stopVpn(): Promise<{ success: boolean; error?: string }> {
  try {
    await Xray.stopVpn();
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'VPN stop failed' };
  }
}

/**
 * Check VPN status
 */
export async function getVpnStatus(): Promise<{ running: boolean; version: string }> {
  try {
    const status = await Xray.getStatus();
    return { running: status.running, version: status.version };
  } catch (error) {
    return { running: false, version: 'unknown' };
  }
}

/**
 * Toggle VPN (connect if disconnected, disconnect if connected)
 */
export async function toggleVpn(
  isConnected: boolean,
  config: V2RayConfig | null,
  activeDns: DnsServer | null,
  options: {
    fakeDns?: boolean;
    doh?: boolean;
    topFiveEnabled?: boolean;
    balancedConfigs?: V2RayConfig[];
    routingMode?: 'global' | 'apps';
    allowedApps?: string[];
    disallowedApps?: string[];
  } = {}
): Promise<{ success: boolean; error?: string; action: 'connected' | 'disconnected' }> {
  if (isConnected) {
    const result = await stopVpn();
    return { ...result, action: 'disconnected' };
  }
  
  if (!config) {
    return { success: false, error: 'No config selected', action: 'disconnected' };
  }
  
  const result = await startVpn(config, activeDns, options);
  return { ...result, action: result.success ? 'connected' : 'disconnected' };
}
