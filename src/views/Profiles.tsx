"use client";
import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, CheckCircle2, Zap, Smartphone, Hash, Navigation as NavIcon, Link as LinkIcon, X, Clock3, Settings2, Download, Activity } from 'lucide-react';
import { V2RayConfig } from '../types';
import { parseV2rayUri, splitConfigLines, measureConfigDelay } from '../utils';
import { getAppValue, setAppValue } from '../utils/appStorage';
import { Virtuoso } from 'react-virtuoso';
import Xray from '../plugins/xray';
import { buildVpnStartPayload, serializeVpnPayload } from '../utils/vpnPayload';

const MAX_CONFIG_TEST_WORKERS = 100;
const DEFAULT_CONFIG_TEST_TIMEOUT_MS = 7000;
const MIN_CONFIG_TEST_TIMEOUT_MS = 3000;
const MAX_CONFIG_TEST_TIMEOUT_MS = 15000;
const MAX_DOWNLOAD_TEST_ITEMS = 10;
const DOWNLOAD_TEST_BYTES = 1_000_000;
const DOWNLOAD_TEST_TIMEOUT_MS = 12_000;
const DOWNLOAD_TEST_WORKERS = 2;
const DEFAULT_CONFIG_TEST_WORKERS = (() => {
  const cores =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(4, Math.min(MAX_CONFIG_TEST_WORKERS, Math.round(cores * 1.5)));
})();
const CONFIG_RESULT_FLUSH_INTERVAL_MS = 700;
const CONFIG_RESULT_FLUSH_SIZE = 250;
const CONFIG_PROGRESS_FLUSH_INTERVAL_MS = 120;
const CONFIG_TEST_URLS = [
  'https://cp.cloudflare.com/generate_204',
  'http://connectivitycheck.gstatic.com/generate_204',
];

const clampInt = (value: number, min: number, max: number) => {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
};

interface ProfilesProps {
  configs: V2RayConfig[];
  setConfigs: React.Dispatch<React.SetStateAction<V2RayConfig[]>>;
  activeConfigId: string | null;
  setActiveConfigId: (id: string | null) => void;
  activeDns: { ip: string; provider: string } | null;
  globalOperation?: boolean;
  setGlobalOperation?: (val: boolean) => void;
}

export function Profiles({ configs, setConfigs, activeConfigId, setActiveConfigId, activeDns, globalOperation, setGlobalOperation }: ProfilesProps) {
  const [clipboardUrl, setClipboardUrl] = useState('');
  const [isPingingAll, setIsPingingAll] = useState(false);
  const [isFetchingSub, setIsFetchingSub] = useState(false);
  const [isBulkImporting, setIsBulkImporting] = useState(false);
  const [importTotal, setImportTotal] = useState(0);
  const [importCompleted, setImportCompleted] = useState(0);
  const [removeBadConfigs, setRemoveBadConfigs] = useState(false);
  const [configTestTotal, setConfigTestTotal] = useState(0);
  const [configTestCompleted, setConfigTestCompleted] = useState(0);
  const [isDownloadTesting, setIsDownloadTesting] = useState(false);
  const [downloadTestTotal, setDownloadTestTotal] = useState(0);
  const [downloadTestCompleted, setDownloadTestCompleted] = useState(0);
  const [fetchSubProgress, setFetchSubProgress] = useState(0);
  const [fetchSubTotal, setFetchSubTotal] = useState(0);
  const [configTestWorkers, setConfigTestWorkers] = useState(DEFAULT_CONFIG_TEST_WORKERS);
  const [configTestTimeoutMs, setConfigTestTimeoutMs] = useState(DEFAULT_CONFIG_TEST_TIMEOUT_MS);
  const [isTestSettingsHydrated, setIsTestSettingsHydrated] = useState(false);
  const stopPingRequestedRef = useRef(false);
  const stopDownloadRequestedRef = useRef(false);
  const pingRunIdRef = useRef(0);
  const downloadRunIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [savedWorkers, savedTimeout] = await Promise.all([
          getAppValue('profiles_test_workers'),
          getAppValue('profiles_test_timeout_ms'),
        ]);

        if (cancelled) return;

        if (savedWorkers !== null) {
          const parsed = Number.parseInt(savedWorkers, 10);
          if (!Number.isNaN(parsed)) {
            setConfigTestWorkers(clampInt(parsed, 1, MAX_CONFIG_TEST_WORKERS));
          }
        }

        if (savedTimeout !== null) {
          const parsed = Number.parseInt(savedTimeout, 10);
          if (!Number.isNaN(parsed)) {
            setConfigTestTimeoutMs(clampInt(parsed, MIN_CONFIG_TEST_TIMEOUT_MS, MAX_CONFIG_TEST_TIMEOUT_MS));
          }
        }
      } catch (error) {
        console.warn('Could not hydrate test settings:', error);
      } finally {
        if (!cancelled) setIsTestSettingsHydrated(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isTestSettingsHydrated) return;
    setAppValue('profiles_test_workers', String(configTestWorkers)).catch(error => {
      console.warn('Could not persist config test worker count:', error);
    });
    setAppValue('profiles_test_timeout_ms', String(configTestTimeoutMs)).catch(error => {
      console.warn('Could not persist config test timeout:', error);
    });
  }, [configTestWorkers, configTestTimeoutMs, isTestSettingsHydrated]);

  const createConfigId = () => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  };

  const isConnectableProtocol = (type?: V2RayConfig['type']) => {
    return type === 'vless' || type === 'vmess' || type === 'trojan' || type === 'shadowsocks';
  };

  const formatBandwidth = (bps: number | 'error' | 'testing' | undefined) => {
    if (typeof bps !== 'number') return bps === 'testing' ? '...' : '--';
    const mbps = bps / 1_000_000;
    if (mbps >= 1) {
      const digits = mbps >= 100 ? 0 : mbps >= 10 ? 1 : 2;
      return `${mbps.toFixed(digits)} Mbps`;
    }
    return `${Math.max(1, Math.round(bps / 1000))} kbps`;
  };

  const requestStopPing = () => {
    stopPingRequestedRef.current = true;
  };

  const requestStopDownload = () => {
    stopDownloadRequestedRef.current = true;
  };

  const fetchSub = async (url: string) => {
    if (globalOperation) { alert('یک عملیات در حال اجرا است، لطفاً صبر کنید.'); return; }
    setIsFetchingSub(true);
    setFetchSubProgress(0);
    setFetchSubTotal(1);
    setGlobalOperation && setGlobalOperation(true);
    try {
        const res = await fetch(url);
        let text = await res.text();
        
        if (!text.includes('://')) {
            try {
               text = atob(text);
            } catch(e) {
               try {
                   text = atob(text + '='.repeat((4 - text.length % 4) % 4));
               } catch(e2) {
                   console.log("Could not base64 decode.");
               }
            }
        }

        const lines = splitConfigLines(text);
        setFetchSubTotal(lines.length);
        setFetchSubProgress(0);
        
        const newConfigs: V2RayConfig[] = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const parsed = parseV2rayUri(line);
            if (parsed && isConnectableProtocol(parsed.type)) {
                newConfigs.push({
                    id: createConfigId(),
                    name: parsed.name || 'Config',
                    type: parsed.type || 'vless',
                    address: parsed.address || 'Unknown',
                    port: parsed.port || '',
                    rawUri: parsed.rawUri || line
                });
            }
            setFetchSubProgress(i + 1);
            if (i % 20 === 0) await new Promise(r => setTimeout(r, 5));
        }
        
        if (newConfigs.length > 0) {
            setConfigs(prev => {
                const combined = [...prev, ...newConfigs];
                const seen = new Set<string>();
                const unique: V2RayConfig[] = [];
                for (const item of combined) {
                    if (!seen.has(item.rawUri)) {
                        seen.add(item.rawUri);
                        unique.push(item);
                    }
                }
                return unique;
            });
            if (!activeConfigId && newConfigs.length > 0) {
                setActiveConfigId(newConfigs[0].id);
            }
            alert(`تعداد ${newConfigs.length} کانفیگ با موفقیت اضافه شد.`);
        } else {
            alert('کانفیگی در سابسکریپشن یافت نشد.');
        }

    } catch (e) {
        alert('خطا در دریافت سابسکریپشن: ' + e);
    }
    setIsFetchingSub(false);
    setFetchSubProgress(0);
    setFetchSubTotal(0);
    setGlobalOperation && setGlobalOperation(false);
  };

  const handleAddConfig = () => {
    if (globalOperation) { alert('یک عملیات در حال اجرا است، لطفاً صبر کنید.'); return; }
    if (!clipboardUrl) return;

    // Bulk import if multiple lines or many URIs provided
    const lines = splitConfigLines(clipboardUrl);
    if (lines.length > 1) {
      (async () => {
        setIsBulkImporting(true);
        setImportTotal(lines.length);
        setImportCompleted(0);
        const newConfigs: V2RayConfig[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) {
            setImportCompleted(prev => prev + 1);
            await new Promise(r => setTimeout(r, 0));
            continue;
          }
          const parsed = parseV2rayUri(line);
          if (parsed && isConnectableProtocol(parsed.type)) {
            newConfigs.push({
              id: createConfigId(),
              name: parsed.name || 'Config',
              type: parsed.type || 'vless',
              address: parsed.address || 'Unknown',
              port: parsed.port || '',
              rawUri: parsed.rawUri || line
            });
          }
          setImportCompleted(prev => prev + 1);
          // allow UI to update
          await new Promise(r => setTimeout(r, 0));
        }

        if (newConfigs.length > 0) {
          // Batch-add large imports to avoid UI freeze
          const BATCH = 200;
          for (let i = 0; i < newConfigs.length; i += BATCH) {
            const batch = newConfigs.slice(i, i + BATCH);
            setConfigs(prev => {
              const combined = [...prev, ...batch];
              const seen = new Set<string>();
              const unique: V2RayConfig[] = [];
              for (const item of combined) {
                if (!seen.has(item.rawUri)) {
                  seen.add(item.rawUri);
                  unique.push(item);
                }
              }
              return unique;
            });
            // yield to event loop so UI can update
            // eslint-disable-next-line no-await-in-loop
            await new Promise(r => setTimeout(r, 50));
          }
          if (!activeConfigId && newConfigs.length > 0) {
            setActiveConfigId(newConfigs[0].id);
          }
          alert(`تعداد ${newConfigs.length} کانفیگ با موفقیت اضافه شد.`);
        } else {
          alert('کانفیگی از متن وارد شده شناسایی نشد.');
        }

        setClipboardUrl('');
        setIsBulkImporting(false);
        setImportTotal(0);
        setImportCompleted(0);
      })();
      return;
    }

    const parsed = parseV2rayUri(clipboardUrl);
    
    if (parsed && isConnectableProtocol(parsed.type)) {
      const newConfig: V2RayConfig = {
        id: createConfigId(),
        name: parsed.name || 'Config',
        type: parsed.type || 'vless',
        address: parsed.address || 'Unknown',
        port: parsed.port || '',
        rawUri: clipboardUrl
      };
      setConfigs(prev => [...prev, newConfig]);
      setClipboardUrl('');
      
      if (!activeConfigId) {
        setActiveConfigId(newConfig.id);
      }
    } else {
      alert('لینک نامعتبر است. پشتیبانی: vless, vmess, trojan, shadowsocks (اتصال VPN: بدون hysteria2).');
    }
  };

  const removeConfig = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setConfigs(prev => prev.filter(c => c.id !== id));
    if (activeConfigId === id) {
      setActiveConfigId(null);
    }
  };

  const pingConfig = async (e: React.MouseEvent, conf: V2RayConfig) => {
    e.stopPropagation();
    setConfigs(prev => prev.map(c => c.id === conf.id ? { ...c, ping: 'testing' } : c));
    const latency: number | 'error' = await measureConfigDelay(conf.rawUri, activeDns?.ip, conf.cleanIp, configTestTimeoutMs, -1, false, [
      'https://cp.cloudflare.com/generate_204',
      'http://connectivitycheck.gstatic.com/generate_204',
    ]);
    setConfigs(prev => prev.map(c => c.id === conf.id ? { ...c, ping: latency } : c));
  };

  const pingAll = async () => {
    if (isPingingAll) return;
    if (globalOperation) { alert('یک عملیات در حال اجرا است، لطفاً صبر کنید.'); return; }
    if (configs.length === 0) return;

    setGlobalOperation && setGlobalOperation(true);
    stopPingRequestedRef.current = false;
    const runId = pingRunIdRef.current + 1;
    pingRunIdRef.current = runId;

    const currentConfigs = configs;
    setIsPingingAll(true);
    setConfigTestTotal(currentConfigs.length);
    setConfigTestCompleted(0);

    setConfigs(prev => prev.map(c => ({ ...c, ping: 'testing' })));
    await new Promise(r => setTimeout(r, 0));

    const concurrency = Math.min(clampInt(configTestWorkers, 1, MAX_CONFIG_TEST_WORKERS), currentConfigs.length);
    const timeoutMs = clampInt(configTestTimeoutMs, MIN_CONFIG_TEST_TIMEOUT_MS, MAX_CONFIG_TEST_TIMEOUT_MS);
    const yieldEvery = Math.max(5, Math.floor(concurrency / 2));
    let nextIndex = 0;
    let completed = 0;
    let lastProgressFlushAt = 0;
    let lastResultFlushAt = 0;
    const finalResults = new Map<string, number | 'error'>();

    const isRunCurrent = () => pingRunIdRef.current === runId;

    const updateProgress = (force = false) => {
      if (!isRunCurrent()) return;
      const now = Date.now();
      if (!force && now - lastProgressFlushAt < CONFIG_PROGRESS_FLUSH_INTERVAL_MS) return;
      lastProgressFlushAt = now;
      setConfigTestCompleted(completed);
    };

    const worker = async () => {
      while (true) {
        if (stopPingRequestedRef.current || !isRunCurrent()) break;
        const index = nextIndex++;
        if (index >= currentConfigs.length) break;
        const conf = currentConfigs[index];
        let latency: number | 'error' = 'error';
        try {
          latency = await measureConfigDelay(
            conf.rawUri,
            activeDns?.ip,
            conf.cleanIp,
            timeoutMs,
            -1,
            false,
            CONFIG_TEST_URLS
          );
        } catch (e) {
          latency = 'error';
          console.warn('measureConfigDelay failed for', conf.id, e);
        }
        if (!isRunCurrent()) break;
        completed += 1;
        finalResults.set(conf.id, latency);
        updateProgress();
        batchResultUpdates.push({ id: conf.id, latency });
        applyBatchUpdates();
        if (completed % yieldEvery === 0) await new Promise(r => setTimeout(r, 0));
      }
    };

    let batchResultUpdates: { id: string; latency: number | 'error' }[] = [];

    const applyBatchUpdates = (force = false) => {
      if (!isRunCurrent() || batchResultUpdates.length === 0) return;
      const now = Date.now();
      if (
        !force &&
        batchResultUpdates.length < CONFIG_RESULT_FLUSH_SIZE &&
        now - lastResultFlushAt < CONFIG_RESULT_FLUSH_INTERVAL_MS
      ) {
        return;
      }

      lastResultFlushAt = now;
      const updates = batchResultUpdates;
      batchResultUpdates = [];
      setConfigs(prev => {
        const updatesMap = new Map<string, number | 'error'>();
        for (const update of updates) {
          updatesMap.set(update.id, update.latency);
        }

        return prev.map(c => {
          const latency = updatesMap.get(c.id);
          return latency !== undefined ? { ...c, ping: latency } : c;
        });
      });
    };

    const interval = setInterval(() => applyBatchUpdates(true), CONFIG_RESULT_FLUSH_INTERVAL_MS);

    try {
      const workers = Array.from({ length: concurrency }, () => worker());
      await Promise.all(workers);
    } catch (e) {
      console.warn('pingAll encountered an unexpected error', e);
    } finally {
      clearInterval(interval);
      applyBatchUpdates(true);
      updateProgress(true);

      if (isRunCurrent()) {
        setConfigs(prev => {
          const next = prev.map(c => {
            const latency = finalResults.get(c.id);
            if (latency !== undefined) return { ...c, ping: latency };
            return c.ping === 'testing' ? { ...c, ping: undefined } : c;
          });

          const filtered = removeBadConfigs
            ? next.filter(c => c.ping === undefined || (typeof c.ping === 'number' && c.ping <= 800))
            : next;

          return [...filtered].sort((a, b) => {
            const valA = typeof a.ping === 'number' ? a.ping : 999999;
            const valB = typeof b.ping === 'number' ? b.ping : 999999;
            return valA - valB;
          });
        });
      }
      setIsPingingAll(false);
      stopPingRequestedRef.current = false;
      setGlobalOperation && setGlobalOperation(false);
    }
  };

  const runDownloadTest = async () => {
    if (isDownloadTesting) return;
    if (globalOperation) { alert('غŒع© ط¹ظ…ظ„غŒط§طھ ط¯ط± ط­ط§ظ„ ط§ط¬ط±ط§ ط§ط³طھطŒ ظ„ط·ظپط§ظ‹ طµط¨ط± ع©ظ†غŒط¯.'); return; }
    if (configs.length === 0) return;

    const targets = configs.slice(0, MAX_DOWNLOAD_TEST_ITEMS);
    if (targets.length === 0) return;

    setGlobalOperation && setGlobalOperation(true);
    stopDownloadRequestedRef.current = false;
    const runId = downloadRunIdRef.current + 1;
    downloadRunIdRef.current = runId;

    setIsDownloadTesting(true);
    setDownloadTestTotal(targets.length);
    setDownloadTestCompleted(0);

    setConfigs(prev => prev.map(c => (
      targets.some(target => target.id === c.id)
        ? { ...c, downloadBps: 'testing' }
        : c
    )));
    await new Promise(r => setTimeout(r, 0));

    const isRunCurrent = () => downloadRunIdRef.current === runId;
    const timeoutMs = DOWNLOAD_TEST_TIMEOUT_MS;
    let batchResultUpdates: { id: string; downloadBps: number | 'error' }[] = [];
    let nextIndex = 0;
    let completed = 0;
    let lastFlushAt = 0;

    const applyBatchUpdates = (force = false) => {
      if (!isRunCurrent() || batchResultUpdates.length === 0) return;
      const now = Date.now();
      if (!force && now - lastFlushAt < CONFIG_RESULT_FLUSH_INTERVAL_MS && batchResultUpdates.length < 2) {
        return;
      }

      lastFlushAt = now;
      const updates = batchResultUpdates;
      batchResultUpdates = [];
      setConfigs(prev => {
        const updatesMap = new Map<string, number | 'error'>();
        for (const update of updates) {
          updatesMap.set(update.id, update.downloadBps);
        }
        return prev.map(c => {
          const downloadBps = updatesMap.get(c.id);
          return downloadBps !== undefined ? { ...c, downloadBps } : c;
        });
      });
    };

    const worker = async () => {
      while (true) {
        if (stopDownloadRequestedRef.current || !isRunCurrent()) break;
        const index = nextIndex++;
        if (index >= targets.length) break;
        const conf = targets[index];
        let downloadBps: number | 'error' = 'error';

        if (isConnectableProtocol(conf.type)) {
          try {
            const payload = {
              ...buildVpnStartPayload(conf, activeDns),
              strictDns: Boolean(activeDns?.ip),
              bytes: DOWNLOAD_TEST_BYTES,
              timeoutMs,
            };
            const result = await Xray.measureConfigDownload({
              config: serializeVpnPayload(payload),
            });
            if (result.ok && result.downloadBps >= 0) {
              downloadBps = result.downloadBps;
            }
          } catch (error) {
            console.warn('Download test failed for config', conf.id, error);
          }
        }

        if (!isRunCurrent()) break;
        completed += 1;
        setDownloadTestCompleted(completed);
        batchResultUpdates.push({ id: conf.id, downloadBps });
        applyBatchUpdates();
        if (completed % DOWNLOAD_TEST_WORKERS === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      }
    };

    const interval = setInterval(() => applyBatchUpdates(true), CONFIG_RESULT_FLUSH_INTERVAL_MS);

    try {
      const workers = Array.from({ length: Math.min(DOWNLOAD_TEST_WORKERS, targets.length) }, () => worker());
      await Promise.all(workers);
    } finally {
      clearInterval(interval);
      applyBatchUpdates(true);
      setDownloadTestCompleted(completed);
      setIsDownloadTesting(false);
      stopDownloadRequestedRef.current = false;
      setGlobalOperation && setGlobalOperation(false);
    }
  };

  // Limit rendering count so DOM doesn't crash on 60,000 items
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden pt-12 pb-24 px-6">
      
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-col gap-3">
          <div className="flex justify-between items-end">
            <div>
              <h2 className="text-xl font-bold tracking-tight text-zinc-100">پروفایل‌ها</h2>
              <p className="text-xs text-zinc-500 mt-1">مدیریت کانفیگ‌ها و V2Ray Links</p>
            </div>
            <div className="flex gap-2">
              <button 
                onClick={pingAll}
                disabled={isPingingAll || isDownloadTesting || configs.length === 0 || !!globalOperation}
                className="text-xs px-3 py-2 bg-zinc-800/80 hover:bg-zinc-700 rounded-lg flex items-center gap-2 border border-zinc-700/50 transition-colors"
              >
                <Zap size={14} className={isPingingAll ? "animate-pulse text-yellow-400" : "text-zinc-400"} />
                <span>{isPingingAll ? 'درحال تست' : 'پینگ همه'}</span>
              </button>
              <button 
                onClick={runDownloadTest}
                disabled={isDownloadTesting || isPingingAll || configs.length === 0 || !!globalOperation}
                className="text-xs px-3 py-2 bg-cyan-600/10 hover:bg-cyan-600/20 rounded-lg flex items-center gap-2 border border-cyan-500/20 transition-colors text-cyan-300"
              >
                {isDownloadTesting ? <Activity size={14} className="animate-spin" /> : <Download size={14} />}
                <span>{isDownloadTesting ? 'در حال دانلود' : 'دانلود 10'}</span>
              </button>
              {isPingingAll && (
                <button 
                  onClick={requestStopPing}
                  className="text-xs px-3 py-2 bg-rose-600/20 hover:bg-rose-600/30 rounded-lg flex items-center gap-2 border border-rose-500/30 transition-colors text-rose-400"
                >
                  <X size={14} />
                  <span>توقف</span>
                </button>
              )}
              {isDownloadTesting && (
                <button 
                  onClick={requestStopDownload}
                  className="text-xs px-3 py-2 bg-rose-600/20 hover:bg-rose-600/30 rounded-lg flex items-center gap-2 border border-rose-500/30 transition-colors text-rose-400"
                >
                  <X size={14} />
                  <span>توقف</span>
                </button>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className={`flex items-center gap-2 rounded-lg border border-zinc-700/50 bg-zinc-900/70 px-3 py-2 text-[11px] text-zinc-400 ${isPingingAll || isDownloadTesting ? 'opacity-60' : ''}`}>
              <Settings2 size={13} className="text-cyan-400 shrink-0" />
              <span className="shrink-0">ورکر</span>
              <input
                type="number"
                min={1}
                max={MAX_CONFIG_TEST_WORKERS}
                step={1}
                value={configTestWorkers}
                onChange={(e) => {
                  const next = Number.parseInt(e.target.value || '0', 10);
                  setConfigTestWorkers(clampInt(next, 1, MAX_CONFIG_TEST_WORKERS));
                }}
                disabled={isPingingAll || isDownloadTesting}
                className="ml-auto w-16 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-100 text-center focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                dir="ltr"
              />
            </label>
            <label className={`flex items-center gap-2 rounded-lg border border-zinc-700/50 bg-zinc-900/70 px-3 py-2 text-[11px] text-zinc-400 ${isPingingAll || isDownloadTesting ? 'opacity-60' : ''}`}>
              <Clock3 size={13} className="text-amber-400 shrink-0" />
              <span className="shrink-0">timeout</span>
              <input
                type="number"
                min={MIN_CONFIG_TEST_TIMEOUT_MS}
                max={MAX_CONFIG_TEST_TIMEOUT_MS}
                step={500}
                value={configTestTimeoutMs}
                onChange={(e) => {
                  const next = Number.parseInt(e.target.value || '0', 10);
                  setConfigTestTimeoutMs(clampInt(next, MIN_CONFIG_TEST_TIMEOUT_MS, MAX_CONFIG_TEST_TIMEOUT_MS));
                }}
                disabled={isPingingAll || isDownloadTesting}
                className="ml-auto w-20 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-100 text-center focus:outline-none focus:border-amber-500 disabled:opacity-50"
                dir="ltr"
              />
            </label>
          </div>
          {isPingingAll && (
            <div className="space-y-2">
              <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-cyan-500 transition-all"
                  style={{ width: `${Math.floor((configTestCompleted / Math.max(configTestTotal, 1)) * 100)}%` }}
                />
              </div>
              <div className="text-xs text-zinc-400">
                {configTestCompleted.toLocaleString('fa-IR')} / {configTestTotal.toLocaleString('fa-IR')} کانفیگ تست شده ({Math.floor((configTestCompleted / Math.max(configTestTotal, 1)) * 100)}%)
              </div>
            </div>
          )}
          {isDownloadTesting && (
            <div className="space-y-2">
              <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-cyan-500 transition-all"
                  style={{ width: `${Math.floor((downloadTestCompleted / Math.max(downloadTestTotal, 1)) * 100)}%` }}
                />
              </div>
              <div className="text-xs text-zinc-400">
                {downloadTestCompleted.toLocaleString('fa-IR')} / {downloadTestTotal.toLocaleString('fa-IR')} دانلود تست شده ({Math.floor((downloadTestCompleted / Math.max(downloadTestTotal, 1)) * 100)}%)
              </div>
            </div>
          )}
        </div>

        {/* Subscription Import */}
        <div className="flex gap-2">
          <button 
            onClick={() => fetchSub('https://raw.githubusercontent.com/miraali1372/mirsub2/main/subscription.txt')}
            disabled={isFetchingSub}
            className="flex-1 text-[10px] px-3 py-2 bg-purple-600/10 text-purple-400 hover:bg-purple-600/20 rounded-lg flex items-center gap-1.5 border border-purple-500/20 transition-colors justify-center"
          >
            <LinkIcon size={12} />
            <span>{isFetchingSub ? 'درحال دریافت...' : 'دریافت کانفیگ'}</span>
          </button>
        </div>
        {isFetchingSub && fetchSubTotal > 0 && (
          <div className="space-y-2 mb-3">
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-purple-500 transition-all"
                style={{ width: `${Math.floor((fetchSubProgress / Math.max(fetchSubTotal, 1)) * 100)}%` }}
              />
            </div>
            <div className="text-xs text-zinc-400">
              درحال پردازش {fetchSubProgress.toLocaleString('fa-IR')} / {fetchSubTotal.toLocaleString('fa-IR')} کانفیگ ({Math.floor((fetchSubProgress / Math.max(fetchSubTotal, 1)) * 100)}%)
            </div>
          </div>
        )}
      </div>

      {/* Add Config Input */}
      <div className="w-full flex gap-2 mb-4">
        <input 
          type="text" 
          value={clipboardUrl}
          onChange={(e) => setClipboardUrl(e.target.value)}
          placeholder="vmess://... یا vless://..." 
          dir="ltr"
          className="flex-1 bg-zinc-900/50 border border-zinc-700/50 rounded-xl px-4 py-3 text-sm font-mono text-zinc-300 focus:outline-none focus:border-cyan-500/50"
        />
        <button 
          onClick={handleAddConfig}
          disabled={isBulkImporting || isFetchingSub || isPingingAll || isDownloadTesting}
          className={`bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl aspect-square w-12 flex items-center justify-center transition-colors shrink-0 ${isBulkImporting || isFetchingSub || isPingingAll || isDownloadTesting ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <Plus size={20} />
        </button>
      </div>

      {isBulkImporting && (
        <div className="mb-3 px-1">
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-500 transition-all"
              style={{ width: `${Math.floor((importCompleted / Math.max(importTotal, 1)) * 100)}%` }}
            />
          </div>
          <div className="text-xs text-zinc-400 mt-2">
            در حال افزودن {importCompleted.toLocaleString('fa-IR')} / {importTotal.toLocaleString('fa-IR')} کانفیگ ({Math.floor((importCompleted / Math.max(importTotal, 1)) * 100)}%)
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 mb-4 px-1">
         <input 
            type="checkbox" 
            id="removeBad" 
            checked={removeBadConfigs} 
            onChange={e => setRemoveBadConfigs(e.target.checked)} 
            className="accent-cyan-500 w-4 h-4 rounded bg-zinc-800 border-zinc-700"
          />
         <label htmlFor="removeBad" className="text-xs text-zinc-400 cursor-pointer select-none">
           حذف تایم‌اوت بالا + مرتب‌سازی براساس پینگ
         </label>
      </div>

      {/* Configs List */}
      <div className="flex-1 -mx-2 px-2 pb-4">
        {configs.length === 0 ? (
           <div className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-4 pt-10">
              <Smartphone size={48} className="opacity-20" />
              <p className="text-sm">هیچ سروری افزوده نشده است.</p>
           </div>
        ) : (
          <Virtuoso
            style={{ height: '100%' }}
            data={configs}
            itemContent={(index, config) => {
              const isActive = activeConfigId === config.id;
              return (
                <div 
                  key={config.id}
                  onClick={() => setActiveConfigId(config.id)}
                  className={`w-full relative p-4 mb-3 rounded-2xl border transition-all cursor-pointer flex flex-col gap-3
                    ${isActive 
                      ? 'bg-cyan-950/20 border-cyan-500/50 shadow-[0_0_15px_rgba(6,182,212,0.1)]' 
                      : 'glass-panel hover:bg-zinc-800/40'}`}
                >
                  {isActive && (
                    <div className="absolute top-4 left-4 text-cyan-400">
                      <CheckCircle2 size={20} />
                    </div>
                  )}
                  
                  <div className="flex justify-between items-start pl-8 border-b border-zinc-800/50 pb-2">
                    <div className="truncate pr-2 w-full text-right">
                      <h4 className="font-bold text-sm text-zinc-100 truncate" dir="ltr">{config.name}</h4>
                      <span className="text-[10px] text-zinc-500 font-mono tracking-wider uppercase mt-1 inline-block">ID: {config.id}</span>
                    </div>
                  </div>

                  <div className="flex justify-between items-center w-full gap-3">
                     <div className="flex gap-3 text-xs text-zinc-400 font-mono items-center" dir="ltr">
                       <span className="flex items-center gap-1"><Hash size={12}/> {config.type}</span>
                       <span className="flex items-center gap-1 truncate max-w-[120px]"><NavIcon size={12}/> {config.address}:{config.port}</span>
                     </div>

                     <div className="flex items-end gap-3">
                       <div className="flex flex-col items-end gap-1 text-right">
                         <button
                            onClick={(e) => pingConfig(e, config)}
                            className={`text-xs font-mono min-w-[50px] text-center transition-colors
                              ${config.ping === 'testing' ? 'text-yellow-400 animate-pulse' : 
                                (typeof config.ping === 'number' && config.ping < 300) ? 'text-emerald-400' :
                                (typeof config.ping === 'number' && config.ping >= 300) ? 'text-amber-400' : 
                                config.ping === 'error' ? 'text-rose-500' : 'text-zinc-500 hover:text-cyan-400'}`}
                         >
                           {config.ping === 'testing' ? '...' : config.ping === 'error' ? 'Timeout' : config.ping !== undefined ? `${config.ping}ms` : '--'}
                         </button>
                         <div className="min-h-[14px] text-[10px] font-mono whitespace-nowrap flex items-center gap-2">
                           {config.downloadBps !== undefined && (
                             <span className={typeof config.downloadBps === 'number' ? 'text-emerald-400' : config.downloadBps === 'testing' ? 'text-yellow-400 animate-pulse' : 'text-zinc-500'}>
                               D {formatBandwidth(config.downloadBps)}
                             </span>
                           )}
                           {config.uploadBps !== undefined && (
                             <span className={typeof config.uploadBps === 'number' ? 'text-cyan-400' : config.uploadBps === 'testing' ? 'text-yellow-400 animate-pulse' : 'text-zinc-500'}>
                               U {formatBandwidth(config.uploadBps)}
                             </span>
                           )}
                         </div>
                       </div>

                       <button onClick={(e) => removeConfig(e, config.id)} className="text-zinc-600 hover:text-rose-500 p-1 transition-colors">
                         <Trash2 size={16} />
                       </button>
                     </div>
                  </div>
                </div>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}
