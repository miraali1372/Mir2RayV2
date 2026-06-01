import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Power, ShieldCheck, Activity, Globe, Network, ArrowDownToLine, ArrowUpFromLine, HelpCircle, X, Share2, Copy, Check, RefreshCw } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { V2RayConfig, DnsServer } from '../types';
import { generateExportUri } from '../utils';
import { buildVpnStartPayload } from '../utils/vpnPayload';
import { getAppValue, removeAppValue, setAppValue } from '../utils/appStorage';
// Use Capacitor dynamic Plugins access for runtime permissions
import { Capacitor } from '@capacitor/core';
import Xray from '../plugins/xray';
import { measureConfigDelay } from '../utils';

interface DashboardProps {
  activeConfig: V2RayConfig | null;
  activeDns: DnsServer | null;
  setConfigs: React.Dispatch<React.SetStateAction<V2RayConfig[]>>;
  setActiveDns: React.Dispatch<React.SetStateAction<DnsServer | null>>;
  isVisible: boolean;
  globalOperation?: boolean;
  setGlobalOperation?: (val: boolean) => void;
  isConnected: boolean;
  setIsConnected: React.Dispatch<React.SetStateAction<boolean>>;
  isConnecting: boolean;
  setIsConnecting: React.Dispatch<React.SetStateAction<boolean>>;
  uptime: number;
  setUptime: React.Dispatch<React.SetStateAction<number>>;
  lastVpnState: boolean | null;
  lastVpnUpdatedAt: string | null;
}

function parsePackageList(value: string) {
  return value.split('\n').map(s => s.trim()).filter(Boolean);
}

function buildVpnSessionKey(
  config: V2RayConfig,
  dns: DnsServer | null,
  routingMode: 'global' | 'apps',
  allowedApps: string[],
  disallowedApps: string[]
) {
  return JSON.stringify({
    shareUri: config.rawUri,
    cleanIp: config.cleanIp || '',
    fragment: config.fragment || null,
    dnsIp: dns?.ip || '',
    strictDns: Boolean(dns?.ip),
    routingMode,
    allowedApps,
    disallowedApps,
  });
}

export function Dashboard({ 
  activeConfig, activeDns, setConfigs, setActiveDns,
  isVisible, globalOperation, setGlobalOperation,
  isConnected, setIsConnected,
  isConnecting, setIsConnecting,
  uptime, setUptime,
  lastVpnState, lastVpnUpdatedAt
}: DashboardProps) {
  const [routingMode, setRoutingMode] = useState<'global' | 'apps'>(() => {
    try {
      return window.localStorage.getItem('mir2ray_routing_mode') === 'apps' ? 'apps' : 'global';
    } catch {
      return 'global';
    }
  });
  const [speeds, setSpeeds] = useState({ up: 0, down: 0 });
  const [livePing, setLivePing] = useState<number | string>('--');
  const [currentPublicIp, setCurrentPublicIp] = useState<string | null>(null);
  const [publicIpSource, setPublicIpSource] = useState<'vpn' | 'direct' | null>(null);
  const [isPublicIpLoading, setIsPublicIpLoading] = useState(true);
  const [publicIpError, setPublicIpError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);
  const [showSplitTunnel, setShowSplitTunnel] = useState(false);
  const [connectedSessionKey, setConnectedSessionKey] = useState<string | null>(null);
  const [allowedAppsText, setAllowedAppsText] = useState<string>(() => {
    try { return window.localStorage.getItem('mir2ray_allowed_apps') || ''; } catch { return ''; }
  });
  const [disallowedAppsText, setDisallowedAppsText] = useState<string>(() => {
    try { return window.localStorage.getItem('mir2ray_disallowed_apps') || ''; } catch { return ''; }
  });
  const [arePrefsHydrated, setArePrefsHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [savedRoutingMode, savedAllowedApps, savedDisallowedApps, savedSessionKey] = await Promise.all([
          getAppValue('routing_mode'),
          getAppValue('allowed_apps'),
          getAppValue('disallowed_apps'),
          getAppValue('vpn_session_key'),
        ]);
        if (cancelled) return;
        if (savedRoutingMode === 'apps' || savedRoutingMode === 'global') {
          setRoutingMode(savedRoutingMode);
        }
        if (savedAllowedApps !== null) setAllowedAppsText(savedAllowedApps);
        if (savedDisallowedApps !== null) setDisallowedAppsText(savedDisallowedApps);
        if (savedSessionKey !== null) setConnectedSessionKey(savedSessionKey);
      } catch {
        // keep local defaults
      } finally {
        if (!cancelled) setArePrefsHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!arePrefsHydrated) return;
    try {
      window.localStorage.setItem('mir2ray_routing_mode', routingMode);
    } catch {
      // ignore storage errors
    }
    setAppValue('routing_mode', routingMode).catch(error => {
      console.warn('Could not persist routing mode:', error);
    });
  }, [routingMode, arePrefsHydrated]);

  useEffect(() => {
    if (!arePrefsHydrated) return;
    try {
      window.localStorage.setItem('mir2ray_allowed_apps', allowedAppsText);
      window.localStorage.setItem('mir2ray_disallowed_apps', disallowedAppsText);
    } catch {
      // ignore storage errors
    }
    Promise.all([
      setAppValue('allowed_apps', allowedAppsText),
      setAppValue('disallowed_apps', disallowedAppsText),
    ]).catch(error => {
      console.warn('Could not persist split tunnel prefs:', error);
    });
  }, [allowedAppsText, disallowedAppsText, arePrefsHydrated]);

  // Mock uptime counter
  useEffect(() => {
    let interval: any;
    if (isConnected) {
      interval = setInterval(() => setUptime(u => u + 1), 1000);
    } else {
      setUptime(0);
    }
    return () => clearInterval(interval);
  }, [isConnected]);

  // Real traffic stats + ping when connected on Android
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;

    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const stats = await Xray.getTrafficStats();
        if (cancelled) return;
        setSpeeds({ up: Math.round(stats.up / 1024), down: Math.round(stats.down / 1024) });
        if (activeConfig?.rawUri) {
          const delay = await measureConfigDelay(activeConfig.rawUri, activeDns?.ip, activeConfig.cleanIp);
          if (!cancelled && typeof delay === 'number') setLivePing(delay);
        }
      } catch {
        /* ignore */
      } finally {
        inFlight = false;
        if (!cancelled && isVisible && !globalOperation && isConnected && Capacitor.getPlatform() === 'android') {
          timer = setTimeout(poll, 3000);
        }
      }
    };

    if (isVisible && !globalOperation && isConnected && Capacitor.getPlatform() === 'android') {
      poll();
    } else if (!isConnected) {
      setSpeeds({ up: 0, down: 0 });
      setLivePing(typeof activeConfig?.ping === 'number' ? activeConfig.ping : '--');
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isConnected, activeConfig, activeDns, isVisible, globalOperation]);

  const formatSpeed = (kbps: number) => {
    if (kbps > 1024) return (kbps / 1024).toFixed(1) + ' MB/s';
    return kbps + ' KB/s';
  };

  const refreshPublicIp = async () => {
    setIsPublicIpLoading(true);
    try {
      const result = await Xray.getCurrentPublicIp({ timeoutMs: 4500 });
      if (result.ok && result.ip) {
        setCurrentPublicIp(result.ip);
        setPublicIpSource(result.source);
        setPublicIpError(null);
      } else {
        setPublicIpError(result.message || 'خطا در دریافت IP');
      }
    } catch (error) {
      console.warn('Could not load public IP:', error);
      setPublicIpError('خطا در دریافت IP');
    } finally {
      setIsPublicIpLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (cancelled || !isVisible || globalOperation) return;
      await refreshPublicIp();
      if (!cancelled && isVisible && !globalOperation) {
        timer = setTimeout(poll, isConnected ? 20000 : 60000);
      }
    };

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isConnected, activeDns?.ip, isVisible, globalOperation]);

  const waitForVpnReady = async (timeoutMs = 12000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const status = await Xray.getStatus();
        if (status.running) return;
      } catch {
        // ignore transient errors while service starts
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    try {
      const status = await Xray.getStatus();
      if (status.running) return;
    } catch {
      // use the clear timeout error below
    }
    throw new Error('هسته Xray در مدت زمان مورد انتظار آماده نشد. لطفاً Logcat را بررسی کنید.');
  };

  const waitForVpnStopped = async (timeoutMs = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const status = await Xray.getStatus();
        if (!status.running) return;
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  const persistVpnState = async (running: boolean, sessionKey?: string | null) => {
    const stamp = new Date().toISOString();
    try {
      const writes: Array<Promise<unknown>> = [
        setAppValue('vpn_last_state', running ? '1' : '0'),
        setAppValue('vpn_last_updated_at', stamp),
      ];
      if (running && sessionKey) {
        writes.push(setAppValue('vpn_session_key', sessionKey));
      } else {
        writes.push(removeAppValue('vpn_session_key'));
      }
      await Promise.all(writes);
    } catch (error) {
      console.warn('Could not persist VPN session state:', error);
    }
  };

  const handleToggle = async () => {
    if (!activeConfig && !isConnected) return;

    if (!isConnected && activeConfig?.type === 'hysteria2') {
      alert('Hysteria2 هنوز برای اتصال VPN پشتیبانی نمی‌شود. لطفاً از vless/vmess/trojan استفاده کنید.');
      return;
    }

    setIsConnecting(true);
    setGlobalOperation?.(true);
    try {
      const allowedApps = parsePackageList(allowedAppsText);
      const disallowedApps = parsePackageList(disallowedAppsText);
      const nextSessionKey = activeConfig
        ? buildVpnSessionKey(activeConfig, activeDns, routingMode, allowedApps, disallowedApps)
        : null;
      const shouldReconnect =
        Boolean(isConnected && activeConfig && connectedSessionKey && nextSessionKey && connectedSessionKey !== nextSessionKey);

      if (isConnected && !shouldReconnect) {
        await Xray.stopVpn();
        setIsConnected(false);
        await persistVpnState(false);
        return;
      }

      if (isConnected && shouldReconnect) {
        await Xray.stopVpn();
        await waitForVpnStopped();
        setIsConnected(false);
        await persistVpnState(false);
      }

      if (!activeConfig) {
        throw new Error('کانفیگ فعالی انتخاب نشده است.');
      }

      // Request notification permission on Android (API 33+)
      if (Capacitor.getPlatform() === 'android') {
        try {
          // dynamic access to avoid typing issues across Capacitor versions
          // @ts-ignore
          await (Capacitor as any).Plugins?.Permissions?.request({ name: 'android.permission.POST_NOTIFICATIONS' });
        } catch (e) {
          // ignore; plugin will still attempt to start
        }
      }

      const payload = buildVpnStartPayload(activeConfig, activeDns);
      if (routingMode === 'apps' && allowedApps.length > 0 && disallowedApps.length > 0) {
        throw new Error('در Split-Tunnel فقط یکی از لیست‌های Allowed یا Disallowed را پر کنید.');
      }
      const fullPayload = {
        ...payload,
        allowedApps: routingMode === 'apps' ? allowedApps : [],
        disallowedApps: routingMode === 'apps' ? disallowedApps : [],
      };
      // persist lists
      try { window.localStorage.setItem('mir2ray_allowed_apps', allowedAppsText); window.localStorage.setItem('mir2ray_disallowed_apps', disallowedAppsText); } catch {}
      const result = await Xray.startVpn({ config: JSON.stringify(fullPayload) });

      if (result.status === 'error') {
        throw new Error(result.message || 'VPN start failed');
      }

      await waitForVpnReady();

      setIsConnected(true);
      setConnectedSessionKey(nextSessionKey);
      await persistVpnState(true, nextSessionKey);
    } catch (err: unknown) {
      console.error('Failed to start VPN via native plugin', err);
      const msg = err instanceof Error ? err.message : 'اتصال VPN ناموفق بود';
      if (Capacitor.getPlatform() === 'android') {
        alert(msg);
      } else if (Capacitor.getPlatform() === 'web') {
        // Web preview only — no system VPN
        setTimeout(() => setIsConnected(true), 1500);
      }
    } finally {
      setIsConnecting(false);
      setGlobalOperation?.(false);
    }
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const currentExportUri = activeConfig ? generateExportUri(activeConfig, activeDns) : '';

  const clearCleanIp = () => {
    if (!activeConfig) return;
    setConfigs(prev => prev.map(c => c.id === activeConfig.id ? { ...c, cleanIp: undefined } : c));
  };

  const clearDnsOverride = () => {
    setActiveDns(null);
  };
  
  const handleCopyShare = () => {
    navigator.clipboard.writeText(currentExportUri);
    setCopiedShare(true);
    setTimeout(() => setCopiedShare(false), 2000);
  };

  return (
    <div className="flex-1 flex flex-col items-center pt-12 pb-24 px-6 overflow-y-auto">
      
      {/* Header Status */}
      <div className="w-full flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-zinc-100 to-zinc-400 bg-clip-text text-transparent">
              Mir2rayV2
            </h1>
            <p className="text-xs text-zinc-500 font-medium">Core: Xray (v2rayNG compatible)</p>
          </div>
          <button 
            onClick={() => setShowHelp(true)}
            className="w-8 h-8 rounded-full bg-zinc-800/50 flex items-center justify-center text-zinc-400 hover:text-cyan-400 hover:bg-zinc-800 transition-colors"
          >
            <HelpCircle size={18} />
          </button>
        </div>
        <div className={`px-3 py-1 rounded-full border text-xs font-medium flex items-center gap-2
          ${isConnected ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' : 'bg-rose-500/10 border-rose-500/50 text-rose-400'}`}>
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
          {isConnected ? 'متصل' : 'قطع شده'}
        </div>
      </div>

      {/* Main Connect Button Area */}
      <div className="relative w-56 h-56 flex items-center justify-center mb-8 shrink-0">
        <AnimatePresence>
          {(isConnecting || isConnected) && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1.2 }}
              exit={{ opacity: 0, scale: 1.5 }}
              transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
              className={`absolute inset-0 rounded-full border-2 
                ${isConnected ? 'border-emerald-500/30' : 'border-cyan-500/30'}`}
            />
          )}
        </AnimatePresence>

        <button
          onClick={handleToggle}
          disabled={!activeConfig && !isConnected}
          className={`relative z-10 w-36 h-36 rounded-full flex flex-col items-center justify-center shadow-2xl transition-all duration-500
            ${!activeConfig 
              ? 'bg-zinc-800/50 border-zinc-700/50 text-zinc-600 cursor-not-allowed' 
              : isConnected 
                ? 'bg-gradient-to-br from-emerald-400 to-teal-600 shadow-[0_0_40px_rgba(16,185,129,0.4)] text-zinc-950 scale-105'
                : isConnecting
                  ? 'bg-gradient-to-br from-cyan-500 to-blue-600 shadow-[0_0_40px_rgba(6,182,212,0.4)] text-zinc-50 animate-pulse'
                  : 'bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-cyan-500/50'
            }`}
        >
          <Power size={48} className={isConnecting ? "animate-spin" : ""} strokeWidth={isConnected ? 3 : 2} />
        </button>
      </div>

      <div className="w-full glass-panel rounded-2xl mb-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/70">
          <div className="flex items-center gap-2 text-cyan-400">
            <Network size={16} />
            <span className="text-sm font-medium text-zinc-300">وضعیت شبکه</span>
          </div>
          <button
            onClick={refreshPublicIp}
            disabled={isPublicIpLoading}
            className="w-8 h-8 rounded-full bg-zinc-800/50 flex items-center justify-center text-zinc-400 hover:text-cyan-400 hover:bg-zinc-800 transition-colors disabled:opacity-50"
            title="به‌روزرسانی IP"
          >
            {isPublicIpLoading ? <Activity size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
        </div>
        <div className="grid grid-cols-2">
          <div className="min-w-0 px-4 py-3 border-l border-zinc-800/70">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium tracking-wide text-zinc-500">IP فعلی</span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full border ${publicIpSource === 'vpn' ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10' : 'border-zinc-700 text-zinc-500 bg-zinc-800/50'}`}>
                {isPublicIpLoading ? '...' : publicIpSource === 'vpn' ? 'VPN' : 'Direct'}
              </span>
            </div>
            <p className="mt-1 text-sm font-mono text-zinc-100 truncate" dir="ltr">
              {isPublicIpLoading ? 'در حال دریافت...' : (currentPublicIp || '--')}
            </p>
            <p className={`mt-1 text-[10px] truncate ${publicIpError ? 'text-rose-400' : 'text-zinc-500'}`}>
              {publicIpError ? publicIpError : (publicIpSource === 'vpn' ? 'خروجی تونل فعال' : 'اتصال مستقیم اینترنت')}
            </p>
          </div>
          <div className="min-w-0 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium tracking-wide text-zinc-500">DNS فعلی</span>
              <Network size={13} className={activeDns ? 'text-purple-400' : 'text-zinc-500'} />
            </div>
            <p className="mt-1 text-sm font-mono text-zinc-100 truncate" dir="ltr">
              {activeDns?.ip || 'سیستم'}
            </p>
            <p className="mt-1 text-[10px] text-zinc-500 truncate">
              {activeDns?.provider || 'DNS پیش‌فرض دستگاه'}
            </p>
          </div>
        </div>
      </div>

      {/* Traffic Stats & Connectivity */}
      <div className="w-full grid grid-cols-2 gap-3 mb-4">
        {/* Upload/Download */}
        <div className="glass-panel p-3 rounded-2xl flex flex-col gap-3">
          <div className="flex justify-between items-center text-zinc-400">
            <span className="text-xs font-medium">ترافیک</span>
            <Activity size={14} className={isConnected ? "text-cyan-400" : ""} />
          </div>
          <div className="flex flex-col gap-1.5" dir="ltr">
            <div className="flex items-center gap-2 text-emerald-400">
              <ArrowDownToLine size={12} />
              <span className="text-sm font-mono">{formatSpeed(speeds.down)}</span>
            </div>
            <div className="flex items-center gap-2 text-cyan-400">
              <ArrowUpFromLine size={12} />
              <span className="text-sm font-mono">{formatSpeed(speeds.up)}</span>
            </div>
          </div>
        </div>

        {/* Uptime & Ping */}
        <div className="glass-panel p-3 rounded-2xl flex flex-col gap-3">
           <div className="flex justify-between items-center text-zinc-400">
            <span className="text-xs font-medium">وضعیت</span>
            <ShieldCheck size={14} className={isConnected ? "text-emerald-400" : ""} />
          </div>
          <div className="flex flex-col gap-1.5 text-right">
            <div className="flex justify-between items-center">
              <span className="text-xs text-zinc-500">پینگ</span>
              <span className="text-sm font-mono text-zinc-200" dir="ltr">{isConnected ? livePing : '--'} <span className="text-[10px] text-zinc-500">ms</span></span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-zinc-500">زمان</span>
              <span className="text-sm font-mono text-zinc-200" dir="ltr">{formatTime(uptime)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Selected Config Info */}
      <div className="w-full glass-panel rounded-2xl p-4 mb-4">
        <div className="flex justify-between items-center mb-2">
          <div className="flex items-center gap-2 text-cyan-400">
            <Globe size={16} />
            <span className="text-sm font-medium text-zinc-300">سرور فعال</span>
          </div>
          <div className="flex items-center gap-2">
            {activeDns && (
              <div className="flex items-center gap-1.5 text-purple-400 bg-purple-500/10 px-2 py-1 rounded text-[10px] font-mono border border-purple-500/20">
                <Network size={12} />
                DNS: {activeDns.ip}
              </div>
            )}
            {activeConfig && (
              <button
                onClick={() => setShowShare(true)}
                title="اشتراک‌گذاری کانفیگ نهایی"
                className="w-7 h-7 rounded bg-zinc-800/50 flex items-center justify-center text-zinc-400 hover:text-cyan-400 hover:bg-zinc-800 transition-colors border border-zinc-700/50"
              >
                <Share2 size={14} />
              </button>
            )}
          </div>
        </div>
        
        {activeConfig ? (
          <div>
            <p className="text-base font-bold text-zinc-100 truncate w-full" dir="ltr">{activeConfig.name}</p>
            <div className="flex flex-wrap gap-2 mt-2">
              <span className="text-[10px] px-2 py-1 bg-zinc-800 rounded text-cyan-400 uppercase tracking-widest border border-zinc-700/50">{activeConfig.type}</span>
              <span className={`text-[10px] px-2 py-1 bg-zinc-800 rounded border border-zinc-700/50 ${activeConfig.cleanIp ? 'line-through text-zinc-500 border-zinc-800/50' : 'text-zinc-400'}`}>
                {activeConfig.address}:{activeConfig.port}
              </span>
              {activeConfig.cleanIp && (
                <span className="text-[10px] px-2 py-1 bg-cyan-500/10 rounded text-cyan-400 border border-cyan-500/30 flex items-center gap-1">
                  <Activity size={10} />
                  {activeConfig.cleanIp}:{activeConfig.port} (Clean IP)
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {activeConfig.cleanIp && (
                <button
                  onClick={clearCleanIp}
                  className="text-[10px] px-2 py-1 bg-rose-500/10 text-rose-300 rounded-xl border border-rose-500/20 hover:bg-rose-500/15"
                >
                  حذف CDN
                </button>
              )}
              {activeDns && (
                <button
                  onClick={clearDnsOverride}
                  className="text-[10px] px-2 py-1 bg-purple-500/10 text-purple-200 rounded-xl border border-purple-500/20 hover:bg-purple-500/15"
                >
                  حذف DNS
                </button>
              )}
              <button
                onClick={() => setShowSplitTunnel(true)}
                className="text-[10px] px-2 py-1 bg-zinc-800/50 text-zinc-300 rounded-xl border border-zinc-700/50 hover:bg-zinc-800/60"
              >
                تنظیم Split-Tunnel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-500 py-2">موردی انتخاب نشده است.</p>
        )}
        <div className="mt-3 pt-3 border-t border-zinc-800/70 text-[11px] text-zinc-500 flex items-center justify-between gap-2">
          <span>آخرین وضعیت VPN</span>
          <span dir="ltr" className={lastVpnState === true ? 'text-emerald-400' : lastVpnState === false ? 'text-rose-400' : 'text-zinc-400'}>
            {lastVpnState === null ? '--' : lastVpnState ? 'connected' : 'disconnected'}
            {lastVpnUpdatedAt ? ` · ${new Date(lastVpnUpdatedAt).toLocaleString('fa-IR')}` : ''}
          </span>
        </div>
      </div>

      {/* Anti-Censorship Help Modal */}
      <AnimatePresence>
        {showHelp && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-sm overflow-hidden flex flex-col max-h-[85vh] shadow-2xl"
            >
              <div className="flex justify-between items-center p-4 border-b border-zinc-800 bg-zinc-900/50">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={18} className="text-cyan-400" />
                  <h3 className="font-bold text-zinc-100">راهنمای دور زدن فیلترینگ</h3>
                </div>
                <button 
                  onClick={() => setShowHelp(false)}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:bg-zinc-800 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>
              
              <div className="p-4 overflow-y-auto flex flex-col gap-5 text-sm text-zinc-300 leading-relaxed font-sans text-right">
                <div>
                  <h4 className="text-cyan-400 font-bold mb-1 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-cyan-400 inline-block"/>۱. تنظیمات فرگمنت (Fragment)</h4>
                  <p className="text-xs text-zinc-400 pr-3">با فعال‌سازی فرگمنت، بسته‌های داده به قطعات کوچکتر تقسیم شده و تشخیص آن‌ها برای سیستم فیلترینگ (DPI) دشوارتر می‌شود. مقادیر پیش‌فرض (10-20 برای هر سه فیلد) عموماً بهترین پاسخ را روی اپراتورهای موبایل می‌دهند.</p>
                </div>
                
                <div>
                  <h4 className="text-cyan-400 font-bold mb-1 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-cyan-400 inline-block"/>۲. تغییر DNS</h4>
                  <p className="text-xs text-zinc-400 pr-3">گاهی اختلالات به دلیل مسمومیت DNS در شبکه داخلی است. در تب ابزار DNS، ابتدا وضعیت DNS‌ها را تست کرده و موردی که کمترین پینگ را دارد انتخاب کنید.</p>
                </div>

                <div>
                  <h4 className="text-cyan-400 font-bold mb-1 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-cyan-400 inline-block"/>۳. استفاده از CDN (کلودفلر) همراه با IP تمیز (Clean IP)</h4>
                  <p className="text-xs text-zinc-400 pr-3">بسیاری از سرورها در ایران مسدود شده‌اند. با راه‌اندازی VLESS یا VMess روی پروتکل WebSocket یا gRPC و انتقال آن پشت CDNهای کلودفلر، می‌توانید فیلترینگ IP را دور بزنید. تکنیک مکمل: از آنجایی که کلودفلر هم در ایران دچار اختلال است، از اسکنرها برای پیدا کردن IPهای تمیز و سالم کلودفلر (Clean IPs) استفاده می‌شود.</p>
                </div>

                <div>
                  <h4 className="text-cyan-400 font-bold mb-1 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-cyan-400 inline-block"/>۴. استفاده از پروتکل Reality</h4>
                  <p className="text-xs text-zinc-400 pr-3">پروتکل VLESS Reality یکی از امن‌ترین روش‌های فعلی است که ترافیک شما را شبیه به گشت‌وگذار در یک سایت معتبر خارجی (مانند سایت اپل یا مایکروسافت) نشان می‌دهد. برای این مورد نیاز به تهیه کانفیگ‌های نوع Reality دارید.</p>
                </div>
              </div>

              <div className="p-4 border-t border-zinc-800 bg-zinc-900/50">
                <button 
                  onClick={() => setShowHelp(false)}
                  className="w-full py-2.5 rounded-xl bg-zinc-100 text-zinc-900 font-bold text-sm hover:bg-white transition-colors"
                >
                  متوجه شدم
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSplitTunnel && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[85vh] shadow-2xl"
            >
              <div className="flex justify-between items-center p-4 border-b border-zinc-800 bg-zinc-900/50">
                <h3 className="font-bold text-zinc-100">Split-Tunnel — لیست بسته‌ها</h3>
                <button onClick={() => setShowSplitTunnel(false)} className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:bg-zinc-800 transition-colors">×</button>
              </div>
              <div className="p-4 overflow-y-auto flex flex-col gap-3 text-sm text-zinc-300">
                <p className="text-xs text-zinc-400">در هر خط یک package name وارد کنید (مثال: com.android.chrome). اگر لیستی در <strong>allowed</strong> قرار گیرد، فقط آن‌ها از VPN استفاده می‌کنند. اگر در <strong>disallowed</strong> قرار گیرند، آن‌ها از VPN خارج می‌شوند.</p>
                <label className="text-xs text-zinc-400">Allowed apps (هر خط یک پکیج)</label>
                <textarea value={allowedAppsText} onChange={(e) => setAllowedAppsText(e.target.value)} className="bg-zinc-900 border border-zinc-800 rounded h-28 p-2 text-sm text-zinc-200" />
                <label className="text-xs text-zinc-400">Disallowed apps (هر خط یک پکیج)</label>
                <textarea value={disallowedAppsText} onChange={(e) => setDisallowedAppsText(e.target.value)} className="bg-zinc-900 border border-zinc-800 rounded h-28 p-2 text-sm text-zinc-200" />
              </div>
              <div className="p-4 border-t border-zinc-800 bg-zinc-900/50 flex gap-2">
                <button onClick={() => {
                  const allowed = allowedAppsText.split('\n').map(s => s.trim()).filter(Boolean);
                  const disallowed = disallowedAppsText.split('\n').map(s => s.trim()).filter(Boolean);
                  if (allowed.length > 0 && disallowed.length > 0) {
                    alert('فقط یکی از لیست‌های Allowed یا Disallowed را پر کنید.');
                    return;
                  }
                  setShowSplitTunnel(false);
                  try { window.localStorage.setItem('mir2ray_allowed_apps', allowedAppsText); window.localStorage.setItem('mir2ray_disallowed_apps', disallowedAppsText); } catch {}
                }} className="flex-1 py-2.5 rounded-xl bg-zinc-100 text-zinc-900 font-bold">ذخیره</button>
                <button onClick={() => { setAllowedAppsText(''); setDisallowedAppsText(''); }} className="flex-1 py-2.5 rounded-xl bg-rose-500/10 text-rose-300">پاک کن</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Share Config Modal */}
      <AnimatePresence>
        {showShare && activeConfig && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-sm overflow-hidden flex flex-col shadow-2xl"
            >
              <div className="flex justify-between items-center p-4 border-b border-zinc-800 bg-zinc-900/50">
                <div className="flex items-center gap-2">
                  <Share2 size={18} className="text-cyan-400" />
                  <h3 className="font-bold text-zinc-100">اشتراک‌گذاری کانفیگ</h3>
                </div>
                <button 
                  onClick={() => setShowShare(false)}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:bg-zinc-800 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>
              
              <div className="p-6 flex flex-col items-center gap-6">
                <div className="bg-white p-3 rounded-xl">
                  <QRCodeCanvas 
                    value={currentExportUri}
                    size={200}
                    bgColor={"#ffffff"}
                    fgColor={"#000000"}
                    level={"L"}
                    includeMargin={false}
                  />
                </div>
                
                <div className="w-full relative">
                  <div className="bg-black/50 border border-zinc-800 rounded-xl p-3 pr-10 overflow-hidden font-mono text-xs text-zinc-400 whitespace-nowrap text-ellipsis" dir="ltr">
                    {currentExportUri}
                  </div>
                  <button 
                    onClick={handleCopyShare}
                    className={`absolute right-1.5 top-1.5 bottom-1.5 aspect-square rounded-lg flex items-center justify-center transition-all ${
                      copiedShare ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white'
                    }`}
                  >
                    {copiedShare ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
              </div>

              <div className="p-4 border-t border-zinc-800 bg-zinc-900/50">
                <button 
                  onClick={() => setShowShare(false)}
                  className="w-full py-2.5 rounded-xl bg-zinc-100 text-zinc-900 font-bold text-sm hover:bg-white transition-colors"
                >
                  بستن
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
