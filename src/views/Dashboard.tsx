import React, { useState, useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { connectionCandidates, invalidateMeasurements, screenMobileConfigs } from '../utils/mobileSelection';
import { buildVpnStartPayload } from '../utils/vpnPayload';
import { CONFIG_REAL_DELAY_TEST_URLS } from '../constants/testTargets';
import { motion, AnimatePresence } from 'motion/react';
import { Power, Activity, X, Share2, Copy, Check, RefreshCw } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { V2RayConfig, DnsServer } from '../types';
import { generateExportUri } from '../utils';
import { removeAppValue, setAppValue } from '../utils/appStorage';
import Xray from '../plugins/xray';
import { annotateConfigQuality, configMeasurementKey, hasFreshVerification, isConnectableConfig, recordConfigFailure } from '../utils/profileQuality';
import { startVpn } from '../utils/vpnControl';
import { isNativeRuntime } from '../utils/platform';

type TrafficSample = { up: number; down: number };
const TRAFFIC_HISTORY_POINTS = 30;

interface DashboardProps {
  configs: V2RayConfig[];
  measurementContext: string;
  activeConfig: V2RayConfig | null;
  activeDns: DnsServer | null;
  setConfigs: React.Dispatch<React.SetStateAction<V2RayConfig[]>>;
  setActiveConfigId: (id: string | null) => void;
  isVisible: boolean;
  globalOperation?: boolean;
  setGlobalOperation?: (val: boolean) => void;
  isConnected: boolean;
  setIsConnected: React.Dispatch<React.SetStateAction<boolean>>;
  isConnecting: boolean;
  setIsConnecting: React.Dispatch<React.SetStateAction<boolean>>;
  uptime: number;
  setUptime: React.Dispatch<React.SetStateAction<number>>;
  fakeDnsEnabled?: boolean;
  dohEnabled?: boolean;
}

export function Dashboard({ 
  configs, measurementContext,
  activeConfig, activeDns, setConfigs, setActiveConfigId,
  isVisible, globalOperation, setGlobalOperation,
  isConnected, setIsConnected,
  isConnecting, setIsConnecting,
  uptime, setUptime,
  fakeDnsEnabled, dohEnabled
}: DashboardProps) {
  const mobile = Capacitor.getPlatform() === 'android';
  const connectionRun = useRef(false);
  const contextRef = useRef(measurementContext);
  contextRef.current = measurementContext;
  const [speeds, setSpeeds] = useState({ up: 0, down: 0 });
  const [trafficHistory, setTrafficHistory] = useState<TrafficSample[]>([]);
  const [livePing, setLivePing] = useState<number | string>('--');
  const [currentPublicIp, setCurrentPublicIp] = useState<string | null>(null);
  const [publicIpSource, setPublicIpSource] = useState<'vpn' | 'direct' | null>(null);
  const [isPublicIpLoading, setIsPublicIpLoading] = useState(true);
  const [publicIpError, setPublicIpError] = useState<string | null>(null);
  const publicIpRequestIdRef = useRef(0);
  const lastPublicIpRef = useRef<{ ip: string; source: 'vpn' | 'direct' } | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);

  useEffect(() => {
    setLivePing(
      typeof activeConfig?.realDelay === 'number'
        ? activeConfig.realDelay
        : typeof activeConfig?.ping === 'number'
          ? activeConfig.ping
          : '--'
    );
  }, [activeConfig?.ping, activeConfig?.realDelay]);

  useEffect(() => {
    try {
      window.localStorage.setItem('mir2ray_routing_mode', 'global');
      window.localStorage.setItem('mir2ray_auto_switch_enabled', '0');
      window.localStorage.setItem('mir2ray_top5_enabled', '0');
    } catch {
      // ignore storage errors
    }
    Promise.all([
      setAppValue('routing_mode', 'global'),
      setAppValue('auto_switch_enabled', '0'),
      setAppValue('top5_enabled', '0'),
      setAppValue('allowed_apps', ''),
      setAppValue('disallowed_apps', ''),
    ]).catch(error => {
      console.warn('Could not keep hidden dashboard switches off:', error);
    });
  }, []);

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

  // Real traffic stats when connected on Android
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;

    // Real throughput from the core's byte counters (delta / elapsed). Full delay probes are kept
    // out of this loop so the live tunnel is not competing with background tests.
    let prevUp: number | null = null;
    let prevDown: number | null = null;
    let prevAt: number | null = null;

    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const stats = await Xray.getTrafficStats();
        if (cancelled) return;
        const now = Date.now();
        if (prevUp !== null && prevDown !== null && prevAt !== null && now > prevAt) {
          const dt = (now - prevAt) / 1000;
          const upRate = Math.max(0, stats.up - prevUp) / dt;
          const downRate = Math.max(0, stats.down - prevDown) / dt;
          const nextSpeeds = {
            up: Math.round(upRate / 1024),
            down: Math.round(downRate / 1024),
          };
          setSpeeds(nextSpeeds);
          setTrafficHistory(previous => [...previous, nextSpeeds].slice(-TRAFFIC_HISTORY_POINTS));
        }
        prevUp = stats.up;
        prevDown = stats.down;
        prevAt = now;
      } catch {
        /* ignore */
      } finally {
        inFlight = false;
        if (!cancelled && isVisible && !globalOperation && isConnected && isNativeRuntime()) {
          timer = setTimeout(poll, 2000);
        }
      }
    };

    if (isVisible && !globalOperation && isConnected && isNativeRuntime()) {
      poll();
    } else if (!isConnected) {
      setSpeeds({ up: 0, down: 0 });
      setTrafficHistory([]);
      setLivePing(
        typeof activeConfig?.realDelay === 'number'
          ? activeConfig.realDelay
          : typeof activeConfig?.ping === 'number'
            ? activeConfig.ping
            : '--'
      );
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isConnected, isVisible, globalOperation, activeConfig?.ping, activeConfig?.realDelay]);

  const formatSpeed = (kbps: number) => {
    if (kbps > 1024) return (kbps / 1024).toFixed(1) + ' MB/s';
    return kbps + ' KB/s';
  };

  const refreshPublicIp = async () => {
    const requestId = ++publicIpRequestIdRef.current;
    const expectedSource: 'vpn' | 'direct' = isConnected ? 'vpn' : 'direct';
    setIsPublicIpLoading(true);
    try {
      const result = await Xray.getCurrentPublicIp({ timeoutMs: 7000 });
      if (requestId !== publicIpRequestIdRef.current) return;
      if (result.ok && result.ip && result.source === expectedSource) {
        lastPublicIpRef.current = { ip: result.ip, source: result.source };
        setCurrentPublicIp(result.ip);
        setPublicIpSource(result.source);
        setPublicIpError(null);
      } else {
        const cached = lastPublicIpRef.current;
        if (cached?.source === expectedSource) {
          setCurrentPublicIp(cached.ip);
          setPublicIpSource(cached.source);
        }
        setPublicIpError(
          isConnected && result.ok && result.source !== 'vpn'
            ? 'مسیر IP خروجی هنوز از تونل تأیید نشده'
            : isConnected
              ? null
              : (result.message || 'خطا در دریافت IP')
        );
      }
    } catch (error) {
      console.warn('Could not load public IP:', error);
      if (requestId !== publicIpRequestIdRef.current) return;
      const cached = lastPublicIpRef.current;
      if (cached?.source === expectedSource) {
        setCurrentPublicIp(cached.ip);
        setPublicIpSource(cached.source);
      }
      setPublicIpError(isConnected ? null : 'خطا در دریافت IP');
    } finally {
      if (requestId === publicIpRequestIdRef.current) {
        setIsPublicIpLoading(false);
      }
    }
  };

  useEffect(() => {
    publicIpRequestIdRef.current += 1;
    lastPublicIpRef.current = null;
    setCurrentPublicIp(null);
    setPublicIpSource(null);
    setPublicIpError(null);
  }, [isConnected]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (cancelled || !isVisible || globalOperation) return;
      await refreshPublicIp();
      if (!cancelled && isVisible && !globalOperation) {
        timer = setTimeout(poll, 60000);
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
        if (status.running) return status;
      } catch {
        // ignore transient errors while service starts
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    try {
      const status = await Xray.getStatus();
      if (status.running) return status;
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

  const persistVpnState = async (running: boolean) => {
    const stamp = new Date().toISOString();
    try {
      await Promise.all([
        setAppValue('vpn_last_state', running ? '1' : '0'),
        setAppValue('vpn_last_updated_at', stamp),
        removeAppValue('vpn_session_key'),
      ]);
    } catch (error) {
      console.warn('Could not persist VPN session state:', error);
    }
  };

  const startVpnForConfig = async (config: V2RayConfig) => {
    const primaryConfig = config;

    if (!primaryConfig || !isConnectableConfig(primaryConfig) || primaryConfig.type === 'hysteria2') {
      throw new Error('Hysteria2 is not supported for Android VPN connection yet.');
    }

    if (isNativeRuntime()) {
      try {
        await Xray.requestNotificationPermission();
      } catch {
        // Notification permission is best-effort; VPN start can still proceed.
      }
    }

    try {
      window.localStorage.setItem('mir2ray_routing_mode', 'global');
      window.localStorage.setItem('mir2ray_auto_switch_enabled', '0');
      window.localStorage.setItem('mir2ray_top5_enabled', '0');
    } catch {
      // secure storage persistence is handled below.
    }
    await Promise.all([
      setAppValue('routing_mode', 'global'),
      setAppValue('auto_switch_enabled', '0'),
      setAppValue('top5_enabled', '0'),
      setAppValue('allowed_apps', ''),
      setAppValue('disallowed_apps', ''),
    ]).catch(error => {
      console.warn('Could not keep hidden connection options off:', error);
    });

    const result = await startVpn(primaryConfig, activeDns, {
      fakeDns: fakeDnsEnabled,
      doh: dohEnabled,
      topFiveEnabled: false,
      balancedConfigs: [primaryConfig],
      routingMode: 'global',
      allowedApps: [],
      disallowedApps: [],
      recoveryConfigs: mobile ? connectionCandidates(configs).slice(0, 5) : undefined,
    });
    if (!result.success) {
      throw new Error(result.error || 'VPN start failed');
    }

    if (mobile) {
      try {
        const health = await Xray.checkVpnHealth({ timeoutMs: 3000 });
        if (health.ok) {
          console.log('VPN path verified with latency', health.latency);
        }
      } catch (e) {
        console.warn('VPN health check warning:', e);
      }
    } else {
      await waitForVpnReady();
    }

    setActiveConfigId(primaryConfig.id);
    setIsConnected(true);
    await persistVpnState(true);

    const stamp = new Date().toISOString();
    setConfigs(prev => prev.map(item => (
      item.id === primaryConfig.id
        ? annotateConfigQuality({ ...item, failStreak: 0, lastSuccessAt: stamp,
          verifiedAt: stamp, retryAfter: undefined, successCount: (item.successCount ?? 0) + 1,
          measurementKey: configMeasurementKey(item, measurementContext),
        }, stamp)
        : item
    )));
  };

  const handleToggle = async () => {
    if (connectionRun.current) return;
    if (!activeConfig && !isConnected && configs.length === 0) return;

    if (!isConnected && activeConfig?.type === 'hysteria2') {
      alert('Hysteria2 هنوز برای اتصال VPN پشتیبانی نمی‌شود. لطفاً از vless/vmess/trojan استفاده کنید.');
      return;
    }

    setIsConnecting(true);
    connectionRun.current = true;
    setGlobalOperation?.(true);
    try {
      // Pressing the power button while connected ALWAYS disconnects. Previously, if the DNS or
      // config had changed since connecting, the button reconnected with the new settings instead
      // of disconnecting — so the VPN could never be turned off after any settings change.
      const nativeStatus = mobile ? await Xray.getStatus() : null;
      if (isConnected || nativeStatus?.desired) {
        await Xray.stopVpn();
        await waitForVpnStopped();
        setIsConnected(false);
        await persistVpnState(false);
        return;
      }

      if (!activeConfig) {
        throw new Error('کانفیگ فعالی انتخاب نشده است.');
      }

      if (mobile) {
        window.dispatchEvent(new Event('mir2ray-stop-tests'));
        await Xray.cancelConfigTests();
        let candidates = connectionCandidates(configs.map(config => invalidateMeasurements(config, measurementContext)), activeConfig.id);
        if (!candidates.some(hasFreshVerification)) {
          const measured: V2RayConfig[] = [];
          await screenMobileConfigs({
            configs: candidates, context: measurementContext, targetCount: 1, budgetMs: 3_500, workers: 6,
            stopped: () => contextRef.current !== measurementContext,
            probe: config => Xray.measureConfigDelay({
              ...buildVpnStartPayload(config, activeDns, { fakeDns: fakeDnsEnabled, doh: dohEnabled }),
              timeoutMs: 2000, maxLatencyMs: -1, testUrls: CONFIG_REAL_DELAY_TEST_URLS,
            }),
            onResult: result => {
              measured.push(result);
              setConfigs(previous => previous.map(config => config.id === result.id ? result : config));
            },
          });
          candidates = connectionCandidates(measured);
        }
        const verified = candidates.filter(hasFreshVerification).slice(0, 3);
        let connected = false;
        for (const candidate of verified) {
          try {
            await startVpnForConfig(candidate);
            connected = true;
            break;
          } catch {
            await Xray.stopVpn();
            setConfigs(previous => previous.map(config => config.id === candidate.id ? recordConfigFailure(config) : config));
          }
        }
        if (!connected && activeConfig) {
          try {
            await startVpnForConfig(activeConfig);
            connected = true;
          } catch {
            await Xray.stopVpn();
            setConfigs(previous => previous.map(config => config.id === activeConfig.id ? recordConfigFailure(config) : config));
          }
        }
        if (!connected) throw new Error('در این نوبت مسیر سالم پیدا نشد. کانفیگ‌ها حفظ شدند؛ دوباره امتحان کنید.');
      } else {
        await startVpnForConfig(activeConfig);
      }
    } catch (err: unknown) {
      console.error('Failed to start VPN via native plugin', err);
      const msg = err instanceof Error ? err.message : 'اتصال VPN ناموفق بود';
      if (isNativeRuntime()) {
        alert(msg);
      } else {
        // Web preview only — no system VPN
        setTimeout(() => setIsConnected(true), 1500);
      }
    } finally {
      connectionRun.current = false;
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
  const connectionLabel = isConnecting ? 'در حال اتصال' : isConnected ? 'اتصال پایدار' : 'آماده اتصال';
  const connectionHint = isConnected
    ? (publicIpSource === 'vpn' ? 'ترافیک از تونل عبور می‌کند' : 'تونل روشن است؛ IP در حال بررسی است')
    : activeConfig
      ? 'برای شروع، دکمه اتصال را بزنید'
      : 'یک کانفیگ سالم انتخاب کنید';
  const publicIpLabel = currentPublicIp || (isPublicIpLoading ? 'در حال دریافت...' : '--');
  const publicIpDirection = currentPublicIp ? 'ltr' : 'rtl';
  const dnsLabel = activeDns ? `${activeDns.provider} · ${activeDns.ip}` : 'DNS سیستم';
  const pingLabel = isConnected && livePing !== '--' ? `${livePing} ms` : '--';
  const paddedTrafficHistory: TrafficSample[] = [
    ...Array.from(
      { length: Math.max(0, TRAFFIC_HISTORY_POINTS - trafficHistory.length) },
      () => ({ up: 0, down: 0 })
    ),
    ...trafficHistory,
  ].slice(-TRAFFIC_HISTORY_POINTS);
  const chartMaxKbps = Math.max(
    1,
    ...paddedTrafficHistory.flatMap(sample => [sample.up, sample.down])
  );
  const makeTrafficPoints = (direction: keyof TrafficSample) => paddedTrafficHistory.map((sample, index) => {
    const x = (index / Math.max(1, paddedTrafficHistory.length - 1)) * 100;
    const ratio = Math.log1p(sample[direction]) / Math.log1p(chartMaxKbps);
    const y = 72 - (ratio * 54);
    return `${x.toFixed(2)},${Math.max(12, Math.min(72, y)).toFixed(2)}`;
  }).join(' ');
  const downloadChartPoints = makeTrafficPoints('down');
  const uploadChartPoints = makeTrafficPoints('up');

  const handleCopyShare = () => {
    navigator.clipboard.writeText(currentExportUri);
    setCopiedShare(true);
    setTimeout(() => setCopiedShare(false), 2000);
  };

  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 px-6 py-3 overflow-hidden">
      
      {/* Main Connect Button Area */}
      <div className="relative w-48 h-48 flex items-center justify-center shrink-0">
        <AnimatePresence>
          {(isConnecting || isConnected) && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1.05 }}
              exit={{ opacity: 0, scale: 1.5 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className={`absolute inset-0 rounded-full border-2 
                ${isConnected ? 'border-emerald-500/30' : 'border-cyan-500/30'}`}
            />
          )}
        </AnimatePresence>

        <button
          onClick={handleToggle}
          disabled={!activeConfig && !isConnected}
          className={`relative z-10 w-32 h-32 rounded-full flex flex-col items-center justify-center shadow-2xl transition-all duration-500
            ${!activeConfig 
              ? 'bg-zinc-800/50 border-zinc-700/50 text-zinc-600 cursor-not-allowed' 
              : isConnected 
                ? 'bg-gradient-to-br from-emerald-400 to-teal-600 shadow-[0_0_40px_rgba(16,185,129,0.4)] text-zinc-950 scale-105'
                : isConnecting
                  ? 'bg-gradient-to-br from-cyan-500 to-blue-600 shadow-[0_0_40px_rgba(6,182,212,0.4)] text-zinc-50 animate-pulse'
                  : 'bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-cyan-500/50'
            }`}
        >
          <Power size={42} className={isConnecting ? "animate-spin" : ""} strokeWidth={isConnected ? 3 : 2} />
        </button>
      </div>

      <div className="w-full glass-panel rounded-2xl p-4 overflow-hidden">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={`flex items-center gap-2 text-sm font-semibold ${isConnected ? 'text-emerald-300' : isConnecting ? 'text-cyan-300' : 'text-zinc-300'}`}>
              <span className={`w-2.5 h-2.5 rounded-full ${isConnected ? 'bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.8)]' : isConnecting ? 'bg-cyan-400 animate-pulse' : 'bg-zinc-500'}`} />
              {connectionLabel}
            </div>
            <p className="mt-1 text-[11px] text-zinc-500 truncate">{connectionHint}</p>
          </div>
          <div className="flex items-center gap-2">
            {activeConfig && (
              <button
                onClick={() => setShowShare(true)}
                className="w-8 h-8 rounded-full bg-zinc-800/50 flex items-center justify-center text-zinc-400 hover:text-cyan-400 hover:bg-zinc-800 transition-colors"
                title="اشتراک‌گذاری کانفیگ"
              >
                <Share2 size={14} />
              </button>
            )}
            <button
              onClick={refreshPublicIp}
              disabled={isPublicIpLoading}
              className="w-8 h-8 rounded-full bg-zinc-800/50 flex items-center justify-center text-zinc-400 hover:text-cyan-400 hover:bg-zinc-800 transition-colors disabled:opacity-50"
              title="به‌روزرسانی IP"
            >
              {isPublicIpLoading ? <Activity size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
          </div>
        </div>

        <div
          className="mt-4 h-20 rounded-xl px-3 py-2 relative overflow-hidden"
          dir="ltr"
          style={{
            background: 'rgba(9, 9, 11, 0.46)',
            border: '1px solid rgba(39, 39, 42, 0.9)',
          }}
        >
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 80" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" y1="28" x2="100" y2="28" stroke="rgba(82,82,91,0.32)" strokeWidth="0.8" />
            <line x1="0" y1="50" x2="100" y2="50" stroke="rgba(82,82,91,0.24)" strokeWidth="0.8" />
            <line x1="0" y1="72" x2="100" y2="72" stroke="rgba(82,82,91,0.42)" strokeWidth="0.8" />
            <polygon
              points={`0,72 ${downloadChartPoints} 100,72`}
              fill={isConnected ? 'rgba(34,211,238,0.12)' : 'rgba(63,63,70,0.08)'}
            />
            <polyline
              points={downloadChartPoints}
              fill="none"
              stroke={isConnected ? '#67e8f9' : '#52525b'}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              opacity={isConnected ? 0.95 : 0.5}
            />
            <polyline
              points={uploadChartPoints}
              fill="none"
              stroke={isConnected ? '#34d399' : '#3f3f46'}
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              opacity={isConnected ? 0.9 : 0.4}
            />
          </svg>
          <div className="relative z-10 flex items-center justify-between gap-2 text-[9px] text-zinc-500" dir="rtl">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-cyan-300" />دریافت</span>
              <span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-emerald-400" />ارسال</span>
            </div>
            <span dir="ltr">{formatSpeed(chartMaxKbps)}</span>
          </div>
        </div>

        <div className="mt-3 space-y-2 text-[11px]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-zinc-500">IP خروجی</span>
            <span className="min-w-0 truncate font-mono text-zinc-100" dir={publicIpDirection}>{publicIpLabel}</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-zinc-500">دریافت</span>
              <span className="font-mono text-emerald-300" dir="ltr">{formatSpeed(speeds.down)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-zinc-500">ارسال</span>
              <span className="font-mono text-cyan-300" dir="ltr">{formatSpeed(speeds.up)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-zinc-500">پینگ</span>
              <span className="font-mono text-zinc-200" dir="ltr">{pingLabel}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-zinc-500">زمان</span>
              <span className="font-mono text-zinc-200" dir="ltr">{formatTime(uptime)}</span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-zinc-800/70 pt-2">
            <span className="text-zinc-500">DNS</span>
            <span className="min-w-0 truncate text-zinc-300" dir="ltr">{dnsLabel}</span>
          </div>
          {publicIpError && (
            <p className="text-[10px] text-amber-300 leading-5">{publicIpError}</p>
          )}
        </div>
      </div>

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
