"use client";
import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { screenMobileConfigs } from '../utils/mobileSelection';
import { ClipboardPaste, Trash2, CheckCircle2, Zap, Smartphone, Hash, Navigation as NavIcon, Link as LinkIcon, X, Download, Activity, Gauge } from 'lucide-react';
import { DnsServer, V2RayConfig } from '../types';
import { parseV2rayUri, splitConfigLines, testLatencyReal, testLatencyAndIp } from '../utils';
import { getDisplayCountry, extractCountryFromName } from '../utils/country';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import Xray from '../plugins/xray';
import { buildVpnStartPayload, serializeVpnPayload } from '../utils/vpnPayload';
import {
  CONFIG_REAL_DELAY_TEST_URLS,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DOWNLOAD_TEST_BYTES,
  DOWNLOAD_TEST_URL,
  META_REAL_DELAY_TEST_URL,
  MIN_CONFIG_BANDWIDTH_BPS,
  UPLOAD_TEST_BYTES,
  UPLOAD_TEST_URL,
} from '../constants/testTargets';
import {
  annotateConfigQuality,
  computeConfigQuality,
  pickBestConfig,
  rankConfigs,
  rankConfigsForInstagram,
  rankConfigsByRealDelay,
  rankConfigsByTcpLatency,
  rankConfigsByDownloadSpeed,
  configMeasurementKey,
  hasFreshVerification,
} from '../utils/profileQuality';
import { progressPercent } from '../utils/progress';
import { fetchTextResource } from '../utils/platformFetch';
import { isWindowsDesktop } from '../utils/platform';

const TCP_CONFIG_TEST_WORKERS = 64;
const TCP_CONFIG_TEST_TIMEOUT_MS = 1500;
const TCP_FAILURE_CONFIRMATION_ATTEMPTS = 1;
const TCP_REQUIRED_CONSECUTIVE_PASSES = 1;
const REAL_CONFIG_TEST_WORKERS = 24;
const REAL_CONFIG_TEST_WORKER_RAMP_MS = 10;
const REAL_CONFIG_TEST_TIMEOUT_MS = 3000;
const REAL_CONFIG_BATCH_TIMEOUT_MS = 5000;
const DOWNLOAD_TEST_TIMEOUT_MS = DEFAULT_DOWNLOAD_TIMEOUT_MS;
const BAD_CONFIG_LATENCY_LIMIT_MS = 500;
const BANDWIDTH_TEST_WORKERS = 3;
const SUBSCRIPTION_SOURCES = [
  {
    name: 'MirSub2',
    url: 'https://raw.githubusercontent.com/miraali1372/mirsub2/main/subscription.txt',
  },
  {
    name: 'vmess',
    url: 'https://raw.githubusercontent.com/barry-far/V2ray-config/main/Splitted-By-Protocol/vmess.txt',
  },
  {
    name: 'mirsub',
    url: 'https://raw.githubusercontent.com/miraali1372/mirsub/main/subscription.txt',
  },
] as const;
const CONFIG_RESULT_FLUSH_INTERVAL_MS = 700;
const CONFIG_RESULT_FLUSH_SIZE = 250;
const CONFIG_PROGRESS_FLUSH_INTERVAL_MS = 120;
const PROBE_TIMEOUT_GRACE_MS = 800;
type BandwidthTestOutcome = {
  downloadBps: number;
  uploadBps: number;
} | 'error' | 'below-minimum';

interface ProfilesProps {
  configs: V2RayConfig[];
  setConfigs: React.Dispatch<React.SetStateAction<V2RayConfig[]>>;
  activeConfigId: string | null;
  setActiveConfigId: (id: string | null) => void;
  activeDns: DnsServer | null;
  globalOperation?: boolean;
  setGlobalOperation?: (val: boolean) => void;
  measurementContext?: string;
  fakeDnsEnabled?: boolean;
  dohEnabled?: boolean;
}

export function Profiles({ configs, setConfigs, activeConfigId, setActiveConfigId, activeDns, globalOperation, setGlobalOperation, measurementContext = '', fakeDnsEnabled, dohEnabled }: ProfilesProps) {
  const mobile = Capacitor.getPlatform() === 'android';
  const configsRef = useRef(configs);
  configsRef.current = configs;
  const contextRef = useRef(measurementContext);
  contextRef.current = measurementContext;
  const [isPingingAll, setIsPingingAll] = useState(false);
  const [isFetchingSub, setIsFetchingSub] = useState(false);
  const [isBulkImporting, setIsBulkImporting] = useState(false);
  const [isReadingClipboard, setIsReadingClipboard] = useState(false);
  const [importTotal, setImportTotal] = useState(0);
  const [importCompleted, setImportCompleted] = useState(0);
  const [configTestTotal, setConfigTestTotal] = useState(0);
  const [configTestCompleted, setConfigTestCompleted] = useState(0);
  const [isDownloadTesting, setIsDownloadTesting] = useState(false);
  const [downloadTestTotal, setDownloadTestTotal] = useState(0);
  const [downloadTestCompleted, setDownloadTestCompleted] = useState(0);
  const [downloadTestFailed, setDownloadTestFailed] = useState(0);
  const [downloadTestBelowMinimum, setDownloadTestBelowMinimum] = useState(0);
  const [fetchSubProgress, setFetchSubProgress] = useState(0);
  const [fetchSubTotal, setFetchSubTotal] = useState(0);
  const [configTestMessage, setConfigTestMessage] = useState('');
  const [selectedSubSourceIndex, setSelectedSubSourceIndex] = useState(0);
  const [showSubSourceMenu, setShowSubSourceMenu] = useState(false);
  const stopPingRequestedRef = useRef(false);
  const stopDownloadRequestedRef = useRef(false);
  const configListRef = useRef<VirtuosoHandle>(null);
  const subSourceLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subSourceLongPressTriggeredRef = useRef(false);
  const pingRunIdRef = useRef(0);
  const downloadRunIdRef = useRef(0);
  const configTestPercent = progressPercent(configTestCompleted, configTestTotal);
  const downloadTestPercent = progressPercent(downloadTestCompleted, downloadTestTotal);
  const fetchSubPercent = progressPercent(fetchSubProgress, fetchSubTotal);
  const importPercent = progressPercent(importCompleted, importTotal);

  const createConfigId = () => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  };

  const isConnectableProtocol = (type?: V2RayConfig['type'], rawUri?: string) => {
    if (!type || (type !== 'vless' && type !== 'vmess' && type !== 'trojan' && type !== 'shadowsocks')) return false;
    if (rawUri && (type === 'vless' || type === 'trojan') && rawUri.toLowerCase().includes('security=none')) {
      return false;
    }
    return true;
  };

  const configDedupeKey = (config: V2RayConfig) => {
    const raw = (config.rawUri || '').trim();
    const hashIdx = raw.indexOf('#');
    const base = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    if (base) return base.toLowerCase();
    const host = (config.cleanIp || config.address || '').toLowerCase().trim();
    return `${config.type}:${host}:${config.port}`;
  };

  const dedupeConfigs = (items: V2RayConfig[]) => {
    const seen = new Set<string>();
    const unique: V2RayConfig[] = [];
    for (const item of items) {
      const key = configDedupeKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }
    return unique;
  };

  const mergeUniqueConfigs = (existing: V2RayConfig[], incoming: V2RayConfig[]) => {
    return dedupeConfigs([...existing, ...incoming]);
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

  const markLatencyResult = (
    config: V2RayConfig,
    latency: number | 'error',
    stamp = new Date().toISOString(),
    options: { preservePreviousLatency?: boolean; source?: 'tcp' | 'real' } = {}
  ) => {
    const previousLatency = typeof config.ping === 'number' ? config.ping : undefined;
    const shouldPreserveLatency = latency === 'error' && options.preservePreviousLatency && previousLatency !== undefined;
    const displayLatency = shouldPreserveLatency ? previousLatency : latency;
    return annotateConfigQuality({
      ...config,
      ping: displayLatency,
      ...(options.source === 'tcp' ? { tcpPing: latency } : {}),
      ...(options.source === 'real' ? { realDelay: latency } : {}),
      ...(options.source === 'real' && typeof latency === 'number' ? {
        latencyTestedAt: stamp,
        measurementKey: configMeasurementKey(config, measurementContext),
        successCount: (config.successCount ?? 0) + 1,
        retryAfter: undefined,
      } : {}),
      failStreak: typeof latency === 'number' ? 0 : Math.min(99, (config.failStreak ?? 0) + 1),
      lastSuccessAt: typeof latency === 'number' ? stamp : config.lastSuccessAt,
      lastFailureAt: latency === 'error' ? stamp : config.lastFailureAt,
    }, stamp);
  };

  const markBandwidthResult = (
    config: V2RayConfig,
    downloadBps: number,
    uploadBps: number,
    stamp = new Date().toISOString()
  ) => {
    return annotateConfigQuality({
      ...config,
      downloadBps,
      uploadBps,
      bandwidthTestedAt: stamp,
      failStreak: 0,
      lastSuccessAt: stamp,
    }, stamp);
  };

  const bestConfig = pickBestConfig(configs);

  useEffect(() => {
    if (isPingingAll || isDownloadTesting || isFetchingSub || isBulkImporting || globalOperation) {
      return;
    }
    setConfigs(previous => {
      const ranked = rankConfigsForInstagram(previous);
      const unchanged = ranked.every((config, index) => config.id === previous[index]?.id);
      return unchanged ? previous : ranked;
    });
  }, [
    configs,
    globalOperation,
    isBulkImporting,
    isDownloadTesting,
    isFetchingSub,
    isPingingAll,
    setConfigs,
  ]);

  const selectBestConfig = () => {
    const best = pickBestConfig(configs);
    if (!best) return;
    setActiveConfigId(best.id);
    setConfigs(prev => rankConfigsForInstagram(prev.map(config => annotateConfigQuality(config))));
  };

  const openSubSourceMenu = () => {
    subSourceLongPressTriggeredRef.current = true;
    setShowSubSourceMenu(true);
  };

  const startSubSourceLongPress = () => {
    if (isFetchingSub) return;
    if (subSourceLongPressTimerRef.current) {
      clearTimeout(subSourceLongPressTimerRef.current);
    }
    subSourceLongPressTimerRef.current = setTimeout(openSubSourceMenu, 550);
  };

  const cancelSubSourceLongPress = () => {
    if (subSourceLongPressTimerRef.current) {
      clearTimeout(subSourceLongPressTimerRef.current);
      subSourceLongPressTimerRef.current = null;
    }
  };

  const fetchSelectedSubSource = () => {
    const source = SUBSCRIPTION_SOURCES[selectedSubSourceIndex] || SUBSCRIPTION_SOURCES[0];
    fetchSub(source.url);
  };

  const chooseSubSource = (index: number) => {
    const source = SUBSCRIPTION_SOURCES[index] || SUBSCRIPTION_SOURCES[0];
    setSelectedSubSourceIndex(index);
    setShowSubSourceMenu(false);
    fetchSub(source.url);
  };

  const requestStopPing = () => {
    stopPingRequestedRef.current = true;
    if (mobile) void Xray.cancelConfigTests();
  };

  const requestStopDownload = () => {
    stopDownloadRequestedRef.current = true;
    if (mobile) void Xray.cancelConfigTests();
  };

  useEffect(() => {
    if (!mobile) return;
    const stop = () => {
      stopPingRequestedRef.current = true;
      stopDownloadRequestedRef.current = true;
      void Xray.cancelConfigTests();
    };
    window.addEventListener('mir2ray-stop-tests', stop);
    return () => { window.removeEventListener('mir2ray-stop-tests', stop); };
  }, [mobile]);

  const fetchSub = async (url: string) => {
    if (globalOperation) { alert('یک عملیات در حال اجرا است، لطفاً صبر کنید.'); return; }
    setIsFetchingSub(true);
    setFetchSubProgress(0);
    setFetchSubTotal(1);
    setGlobalOperation?.(true);
    try {
        const res = await fetchTextResource(url, { timeoutMs: 20_000 });
        if (!res.ok) throw new Error(res.message || `HTTP ${res.status}`);
        let text = res.text;
        
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
            const result = parseV2rayUri(line);
            if (result.config && isConnectableProtocol(result.config.type, result.config.rawUri || line)) {
                newConfigs.push(annotateConfigQuality({
                    id: createConfigId(),
                    name: result.config.name || 'Config',
                    type: result.config.type || 'vless',
                    address: result.config.address || 'Unknown',
                    port: result.config.port || '',
                    rawUri: result.config.rawUri || line
                }));
            }
            setFetchSubProgress(i + 1);
            if (i % 20 === 0) await new Promise(r => setTimeout(r, 5));
        }
        
        if (newConfigs.length > 0) {
            const existingUnique = dedupeConfigs(configs);
            const nextConfigs = mergeUniqueConfigs(existingUnique, newConfigs);
            const addedCount = Math.max(0, nextConfigs.length - existingUnique.length);
            setConfigs(nextConfigs);
            if (!activeConfigId && nextConfigs.length > 0) {
                setActiveConfigId(nextConfigs[0].id);
            }
            setIsFetchingSub(false);
            setFetchSubProgress(0);
            setFetchSubTotal(0);
            setConfigTestMessage(`دریافت کامل شد. ${addedCount.toLocaleString('fa-IR')} کانفیگ جدید اضافه شد؛ پینگ همه شروع شد.`);
            stopPingRequestedRef.current = false;
            const runId = pingRunIdRef.current + 1;
            pingRunIdRef.current = runId;
            await runConfigTestPipeline(runId, nextConfigs);
        } else {
            alert('کانفیگی در سابسکریپشن یافت نشد.');
        }

    } catch (e) {
        alert('خطا در دریافت سابسکریپشن: ' + e);
    }
    setIsFetchingSub(false);
    setFetchSubProgress(0);
    setFetchSubTotal(0);
    setGlobalOperation?.(false);
  };

  const importConfigText = async (text: string) => {
    const trimmedText = text.trim();
    if (!trimmedText) {
      alert('کلیپ‌بورد خالی است یا متن قابل استفاده‌ای داخل آن نیست.');
      return;
    }

    const lines = splitConfigLines(trimmedText);
    if (lines.length > 1) {
      setIsBulkImporting(true);
      setImportTotal(lines.length);
      setImportCompleted(0);
      try {
        const newConfigs: V2RayConfig[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) {
            setImportCompleted(prev => prev + 1);
            await new Promise(r => setTimeout(r, 0));
            continue;
          }
          const result = parseV2rayUri(line);
          if (result.config && isConnectableProtocol(result.config.type, result.config.rawUri || line)) {
            newConfigs.push(annotateConfigQuality({
              id: createConfigId(),
              name: result.config.name || 'Config',
              type: result.config.type || 'vless',
              address: result.config.address || 'Unknown',
              port: result.config.port || '',
              rawUri: result.config.rawUri || line
            }));
          }
          setImportCompleted(prev => prev + 1);
          await new Promise(r => setTimeout(r, 0));
        }

        if (newConfigs.length > 0) {
          const existingUnique = dedupeConfigs(configs);
          const nextConfigs = mergeUniqueConfigs(existingUnique, newConfigs);
          const addedCount = Math.max(0, nextConfigs.length - existingUnique.length);
          setConfigs(nextConfigs);
          if (!activeConfigId && nextConfigs.length > 0) {
            setActiveConfigId(nextConfigs[0].id);
          }
          alert(`افزودن کامل شد. ${addedCount} کانفیگ جدید اضافه شد و تکراری‌ها حذف شدند.`);
        } else {
          alert('کانفیگی از کلیپ‌بورد شناسایی نشد.');
        }
      } finally {
        setIsBulkImporting(false);
        setImportTotal(0);
        setImportCompleted(0);
      }
      return;
    }

    const line = lines[0]?.trim() || trimmedText;
    const result = parseV2rayUri(line);
    
    if (result.config && isConnectableProtocol(result.config.type, result.config.rawUri || line)) {
      const newConfig: V2RayConfig = annotateConfigQuality({
        id: createConfigId(),
        name: result.config.name || 'Config',
        type: result.config.type || 'vless',
        address: result.config.address || 'Unknown',
        port: result.config.port || '',
        rawUri: result.config.rawUri || line
      });
      const existingUnique = dedupeConfigs(configs);
      const nextConfigs = mergeUniqueConfigs(existingUnique, [newConfig]);
      const addedCount = Math.max(0, nextConfigs.length - existingUnique.length);
      setConfigs(nextConfigs);
      
      if (!activeConfigId && nextConfigs.length > 0) {
        setActiveConfigId(nextConfigs[0].id);
      }
      if (addedCount === 0) {
        alert('این کانفیگ از قبل در لیست بود.');
      }
    } else {
      const errorMsg = result.errors.length > 0 ? result.errors.join(', ') : 'لینک نامعتبر است';
      alert(`لینک نامعتبر است: ${errorMsg}. پشتیبانی: vless, vmess, trojan, shadowsocks (اتصال VPN: بدون hysteria2).`);
    }
  };

  const handleAddFromClipboard = async () => {
    if (globalOperation) { alert('یک عملیات در حال اجرا است، لطفاً صبر کنید.'); return; }
    if (isReadingClipboard || isBulkImporting) return;
    setIsReadingClipboard(true);
    try {
      const result = await Xray.readClipboardText();
      await importConfigText(result.text || '');
    } catch {
      alert('خواندن کلیپ‌بورد ناموفق بود. لطفاً متن کانفیگ را دوباره کپی کنید.');
    } finally {
      setIsReadingClipboard(false);
    }
  };

  const removeConfig = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setConfigs(prev => prev.filter(c => c.id !== id));
    if (activeConfigId === id) {
      setActiveConfigId(null);
    }
  };

  const removeAllConfigs = () => {
    if (globalOperation) {
      alert('یک عملیات در حال اجراست، لطفاً صبر کنید.');
      return;
    }
    if (configs.length === 0) return;
    if (typeof window !== 'undefined' && !window.confirm('همه کانفیگ‌ها حذف شوند؟')) return;
    setConfigs([]);
    setActiveConfigId(null);
  };

  const pingConfig = async (e: React.MouseEvent, conf: V2RayConfig) => {
    e.stopPropagation();
    setConfigs(prev => prev.map(c => c.id === conf.id ? { ...c, ping: 'testing', tcpPing: 'testing', realDelay: 'testing' } : c));

    // 1. TCP test + IP resolution
    const tcpRes = await testLatencyAndIp(conf.cleanIp || conf.address, conf.port || 443, 1200);
    const tcpLatency = tcpRes.latency;

    // Purge immediately if TCP timed out, failed, or missing IP
    if (typeof tcpLatency !== 'number' || tcpLatency < 0 || !tcpRes.ip) {
      setConfigs(prev => prev.filter(c => c.id !== conf.id));
      if (activeConfigId === conf.id) setActiveConfigId(null);
      return;
    }

    // 2. Real Delay test + Exit IP
    let realLatency: number | 'error' = 'error';
    let exitIp: string | undefined = undefined;
    let exitCountry: string | undefined = undefined;
    try {
      const result = await Xray.measureConfigDelay({
        shareUri: conf.rawUri,
        dnsIp: activeDns?.ip,
        cleanIp: conf.cleanIp,
        fragment: conf.fragment,
        fakeDns: fakeDnsEnabled,
        doh: dohEnabled,
        strictDns: false,
        timeoutMs: 2500,
        maxLatencyMs: -1,
        testUrls: CONFIG_REAL_DELAY_TEST_URLS,
        preferredTestUrl: META_REAL_DELAY_TEST_URL,
      });
      if (result.ok && typeof result.latency === 'number' && result.latency > 0 && result.exitIp) {
        realLatency = result.latency;
        exitIp = result.exitIp;
        exitCountry = result.exitCountry;
      }
    } catch (error) {
      console.warn('Single config real delay probe failed for', conf.id, error);
    }

    // Purge immediately if Real Delay timed out or missing exit IP
    if (typeof realLatency !== 'number' || realLatency <= 0 || !exitIp) {
      setConfigs(prev => prev.filter(c => c.id !== conf.id));
      if (activeConfigId === conf.id) setActiveConfigId(null);
      return;
    }

    setConfigs(prev => {
      const updated = prev.map(c => c.id === conf.id ? annotateConfigQuality({
        ...c,
        tcpPing: tcpLatency,
        realDelay: realLatency,
        ping: realLatency,
        resolvedIp: tcpRes.ip,
        exitIp: exitIp,
        exitCountry: exitCountry,
        latencyTestedAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
      }) : c);
      return rankConfigsByRealDelay(updated);
    });
  };

  const runConfigTestPipeline = async (runId: number, sourceConfigs?: V2RayConfig[]) => {
    const isRunCurrent = () => pingRunIdRef.current === runId;

    try {
      setIsPingingAll(true);
      stopPingRequestedRef.current = false;
      setConfigTestCompleted(0);

      const baseConfigs = dedupeConfigs(sourceConfigs ?? configsRef.current)
        .filter(c => isConnectableProtocol(c.type, c.rawUri));

      if (baseConfigs.length === 0) {
        setConfigTestMessage('کانفیگی برای تست وجود ندارد.');
        return;
      }

      // Purge duplicates immediately from the UI and state before testing starts
      setConfigs(baseConfigs);

      // 1. Group unique endpoints for high-speed TCP testing
      const endpointGroups = new Map<string, V2RayConfig[]>();
      for (const conf of baseConfigs) {
        const host = (conf.cleanIp || conf.address || '').trim().toLowerCase();
        const port = String(conf.port || 443);
        const key = `${host}:${port}`;
        const group = endpointGroups.get(key);
        if (group) group.push(conf);
        else endpointGroups.set(key, [conf]);
      }

      const uniqueEndpoints: { host: string; port: number; configs: V2RayConfig[] }[] = [];
      for (const [key, group] of endpointGroups.entries()) {
        const lastColon = key.lastIndexOf(':');
        const host = key.slice(0, lastColon);
        const port = parseInt(key.slice(lastColon + 1), 10) || 443;
        uniqueEndpoints.push({ host, port, configs: group });
      }

      // Initialize all configs with testing state
      let aliveMap = new Map<string, V2RayConfig>(baseConfigs.map(c => [
        c.id,
        { ...c, tcpPing: 'testing' as const, realDelay: undefined, ping: 'testing' as const },
      ]));

      setConfigs(Array.from(aliveMap.values()));
      setConfigTestTotal(baseConfigs.length);
      setConfigTestCompleted(0);
      setConfigTestMessage(`مرحله ۱: تست سریع TCP و بررسی IP برای ${baseConfigs.length.toLocaleString('fa-IR')} کانفیگ روی ${uniqueEndpoints.length.toLocaleString('fa-IR')} مقصد...`);

      // Phase 1: High-Speed TCP Ping & IP Resolution with instant purge
      // 64 workers, 1000ms timeout for ultra-fast throughput
      const TCP_WORKERS = Math.min(64, Math.max(12, uniqueEndpoints.length));
      let processedConfigsCount = 0;
      let nextEndpointIdx = 0;
      let purgedTcpCount = 0;
      let lastFlushTime = Date.now();

      const flushTcp = (force = false) => {
        if (!isRunCurrent()) return;
        const now = Date.now();
        if (!force && now - lastFlushTime < 140) return;
        lastFlushTime = now;

        const sortedAlive = rankConfigsByTcpLatency(Array.from(aliveMap.values()));
        setConfigs(sortedAlive);
        setConfigTestMessage(`مرحله ۱: تست سریع TCP و IP (${sortedAlive.length.toLocaleString('fa-IR')} سالم، ${purgedTcpCount.toLocaleString('fa-IR')} حذف شد)...`);
      };

      const tcpWorker = async () => {
        while (true) {
          if (stopPingRequestedRef.current || !isRunCurrent()) break;
          const idx = nextEndpointIdx++;
          if (idx >= uniqueEndpoints.length) break;

          const endpoint = uniqueEndpoints[idx];
          let latency: number | 'error' = 'error';
          let resolvedIp: string | undefined = undefined;

          try {
            const res = await testLatencyAndIp(endpoint.host, endpoint.port, 1000);
            latency = res.latency;
            resolvedIp = res.ip;
          } catch {
            latency = 'error';
          }

          if (!isRunCurrent()) break;

          const passed = typeof latency === 'number' && latency >= 0 && !!resolvedIp;

          if (passed) {
            for (const conf of endpoint.configs) {
              const existing = aliveMap.get(conf.id);
              if (existing) {
                const countryInfo = extractCountryFromName(existing.name);
                aliveMap.set(conf.id, annotateConfigQuality({
                  ...existing,
                  tcpPing: latency,
                  ping: latency,
                  resolvedIp: resolvedIp,
                  exitCountry: existing.exitCountry || countryInfo?.code,
                  latencyTestedAt: new Date().toISOString(),
                }));
              }
            }
          } else {
            // PURGE IMMEDIATELY ON TIMEOUT OR FAILURE
            for (const conf of endpoint.configs) {
              aliveMap.delete(conf.id);
              purgedTcpCount++;
            }
          }

          processedConfigsCount += endpoint.configs.length;
          setConfigTestCompleted(processedConfigsCount);
          flushTcp();
        }
      };

      await Promise.all(Array.from({ length: TCP_WORKERS }, () => tcpWorker()));
      flushTcp(true);

      if (stopPingRequestedRef.current || !isRunCurrent()) return;

      const tcpSurviving = rankConfigsByTcpLatency(Array.from(aliveMap.values()));
      if (tcpSurviving.length === 0) {
        setConfigs([]);
        setActiveConfigId(null);
        setConfigTestMessage('تمام کانفیگ‌ها در تست TCP یا عدم دریافت IP ناموفق بودند و پاک شدند.');
        return;
      }

      // Phase 2: True Real Delay & Exit IP & Country on ALL TCP survivors (no artificial limit!)
      setConfigTestMessage(
        `مرحله ۲: تست Real Delay و استخراج IP خروجی برای تمامی ${tcpSurviving.length.toLocaleString('fa-IR')} کانفیگ سالم TCP...`
      );
      setConfigTestTotal(tcpSurviving.length);
      setConfigTestCompleted(0);

      // Mark survivors as testing real delay
      for (const conf of tcpSurviving) {
        aliveMap.set(conf.id, { ...conf, realDelay: 'testing' as const, ping: 'testing' as const });
      }
      setConfigs(rankConfigsByRealDelay(Array.from(aliveMap.values())));

      // Use 8 concurrent workers on mobile, 10 on desktop for maximum throughput without contention
      const REAL_WORKERS = Math.min(mobile ? 8 : 10, Math.max(2, tcpSurviving.length));
      let nextRealIdx = 0;
      let completedRealCount = 0;
      let verifiedRealCount = 0;
      let purgedRealCount = 0;
      let lastRealFlush = Date.now();

      const flushReal = (force = false) => {
        if (!isRunCurrent()) return;
        const now = Date.now();
        if (!force && now - lastRealFlush < 200) return;
        lastRealFlush = now;

        const sortedAlive = rankConfigsByRealDelay(Array.from(aliveMap.values()));
        setConfigs(sortedAlive);
        setConfigTestMessage(
          `مرحله ۲: تست Real Delay (${verifiedRealCount.toLocaleString('fa-IR')} تأیید شد، ${purgedRealCount.toLocaleString('fa-IR')} حذف شد)...`
        );
      };

      const realWorker = async () => {
        while (true) {
          if (stopPingRequestedRef.current || !isRunCurrent()) break;
          const idx = nextRealIdx++;
          if (idx >= tcpSurviving.length) break;

          const conf = tcpSurviving[idx];
          let realLatency: number | 'error' = 'error';
          let exitIp: string | undefined = undefined;
          let exitCountry: string | undefined = undefined;

          try {
            const result = await Xray.measureConfigDelay({
              shareUri: conf.rawUri,
              dnsIp: activeDns?.ip,
              cleanIp: conf.cleanIp,
              fragment: conf.fragment,
              fakeDns: fakeDnsEnabled,
              doh: dohEnabled,
              timeoutMs: 2500,
              maxLatencyMs: -1,
              testUrls: CONFIG_REAL_DELAY_TEST_URLS,
              preferredTestUrl: META_REAL_DELAY_TEST_URL,
            });
            if (result.ok && typeof result.latency === 'number' && result.latency > 0) {
              realLatency = result.latency;
              exitIp = result.exitIp;
              exitCountry = result.exitCountry;
            }
          } catch (e) {
            console.warn('Real delay probe failed for', conf.id, e);
          }

          if (!isRunCurrent()) break;

          // A config is verified if it successfully tunnels HTTP traffic (realLatency > 0)
          const passed = typeof realLatency === 'number' && realLatency > 0;

          if (passed) {
            const existing = aliveMap.get(conf.id);
            if (existing) {
              const countryInfo = extractCountryFromName(existing.name);
              aliveMap.set(conf.id, annotateConfigQuality({
                ...existing,
                realDelay: realLatency,
                ping: realLatency,
                exitIp: exitIp || existing.resolvedIp,
                exitCountry: exitCountry || existing.exitCountry || countryInfo?.code,
                latencyTestedAt: new Date().toISOString(),
                lastSuccessAt: new Date().toISOString(),
              }));
              verifiedRealCount++;
            }
          } else {
            // PURGE IMMEDIATELY IF REAL DELAY TIMED OUT OR FAILED
            aliveMap.delete(conf.id);
            purgedRealCount++;
          }

          completedRealCount++;
          setConfigTestCompleted(completedRealCount);
          flushReal();
        }
      };

      await Promise.all(Array.from({ length: REAL_WORKERS }, () => realWorker()));
      flushReal(true);

      if (stopPingRequestedRef.current || !isRunCurrent()) return;

      // Phase 3: Final ranking & auto-select top config
      const finalRanked = rankConfigsByRealDelay(Array.from(aliveMap.values()));
      setConfigs(finalRanked);

      if (finalRanked.length > 0 && finalRanked[0].id) {
        setActiveConfigId(finalRanked[0].id);
      }

      requestAnimationFrame(() => {
        configListRef.current?.scrollToIndex({ index: 0, align: 'start' });
      });

      setConfigTestMessage(
        `تست کامل شد: ${finalRanked.length.toLocaleString('fa-IR')} کانفیگ سالم و باکیفیت تأیید و مرتب شدند؛ تمام موارد تایم‌اوت، بدون IP و ریل‌دیلی حذف شدند.`
      );
    } catch (e) {
      console.warn('Config test pipeline failed', e);
      setConfigTestMessage('تست کانفیگ‌ها با خطا متوقف شد.');
    } finally {
      setIsPingingAll(false);
      stopPingRequestedRef.current = false;
      setGlobalOperation?.(false);
    }
  };

  const pingAll = async () => {
    if (isPingingAll) return;
    if (globalOperation) { alert('یک عملیات در حال اجرا است، لطفاً صبر کنید.'); return; }
    const unique = dedupeConfigs(configsRef.current).filter(c => isConnectableProtocol(c.type, c.rawUri));
    if (unique.length === 0) return;

    setConfigs(unique);
    setGlobalOperation?.(true);
    stopPingRequestedRef.current = false;
    const runId = pingRunIdRef.current + 1;
    pingRunIdRef.current = runId;
    await runConfigTestPipeline(runId, unique);
  };

  const runDownloadTest = async () => {
    if (isDownloadTesting) return;
    if (globalOperation) { alert('یک عملیات در حال اجرا است، لطفاً صبر کنید.'); return; }
    const targets = dedupeConfigs(configsRef.current).filter(c => isConnectableProtocol(c.type, c.rawUri));
    if (targets.length === 0) return;

    setConfigs(targets);
    setGlobalOperation?.(true);
    stopDownloadRequestedRef.current = false;
    const runId = downloadRunIdRef.current + 1;
    downloadRunIdRef.current = runId;

    setIsDownloadTesting(true);
    setDownloadTestTotal(targets.length);
    setDownloadTestCompleted(0);
    setDownloadTestFailed(0);
    setDownloadTestBelowMinimum(0);

    let aliveDownloadMap = new Map<string, V2RayConfig>(targets.map(target => [
      target.id,
      { ...target, downloadBps: 'testing' as const, uploadBps: 'testing' as const },
    ]));
    setConfigs(Array.from(aliveDownloadMap.values()));
    await new Promise(r => setTimeout(r, 0));

    const isRunCurrent = () => downloadRunIdRef.current === runId;
    const timeoutMs = DOWNLOAD_TEST_TIMEOUT_MS;
    let nextIndex = 0;
    let completed = 0;
    let failed = 0;
    let lastFlushAt = 0;

    const flushDownload = (force = false) => {
      if (!isRunCurrent()) return;
      const now = Date.now();
      if (!force && now - lastFlushAt < 200) return;
      lastFlushAt = now;
      const sorted = rankConfigsByDownloadSpeed(Array.from(aliveDownloadMap.values()));
      setConfigs(sorted);
    };

    const testConfigBandwidth = async (
      conf: V2RayConfig,
      testTimeoutMs: number
    ): Promise<BandwidthTestOutcome> => {
      if (!isConnectableProtocol(conf.type, conf.rawUri)) return 'error';
      try {
        const payload = {
          ...buildVpnStartPayload(conf, activeDns, { fakeDns: fakeDnsEnabled, doh: dohEnabled }),
          strictDns: false,
          downloadBytes: DOWNLOAD_TEST_BYTES,
          uploadBytes: UPLOAD_TEST_BYTES,
          timeoutMs: testTimeoutMs,
          downloadUrl: DOWNLOAD_TEST_URL,
          uploadUrl: mobile ? 'https://speed.cloudflare.com/__up' : UPLOAD_TEST_URL,
        };
        const result = await Xray.measureConfigBandwidth({
          config: serializeVpnPayload(payload),
        });
        if (!result.ok || result.downloadBps <= 0 || result.uploadBps <= 0) return 'error';
        return { downloadBps: result.downloadBps, uploadBps: result.uploadBps };
      } catch (error) {
        console.warn('Bandwidth test failed for config', conf.id, error);
        return 'error';
      }
    };

    const worker = async () => {
      while (true) {
        if (stopDownloadRequestedRef.current || !isRunCurrent()) break;
        const index = nextIndex++;
        if (index >= targets.length) break;
        const conf = targets[index];
        const outcome = await testConfigBandwidth(conf, timeoutMs);

        if (!isRunCurrent() || stopDownloadRequestedRef.current) break;
        completed += 1;
        setDownloadTestCompleted(completed);

        if (outcome === 'error' || outcome === 'below-minimum') {
          failed += 1;
          setDownloadTestFailed(failed);
          // PURGE IMMEDIATELY ON DOWNLOAD FAILURE
          aliveDownloadMap.delete(conf.id);
        } else if (typeof outcome === 'object') {
          const existing = aliveDownloadMap.get(conf.id);
          if (existing) {
            aliveDownloadMap.set(
              conf.id,
              annotateConfigQuality(markBandwidthResult(existing, outcome.downloadBps, outcome.uploadBps))
            );
          }
        }
        flushDownload();
      }
    };

    try {
      const workers = Array.from({ length: Math.min(mobile ? 3 : BANDWIDTH_TEST_WORKERS, targets.length) }, () => worker());
      await Promise.all(workers);
    } finally {
      flushDownload(true);
      if (isRunCurrent()) {
        const finalRanked = rankConfigsByDownloadSpeed(Array.from(aliveDownloadMap.values()));
        setConfigs(finalRanked);
        if (finalRanked.length > 0 && !finalRanked.some(c => c.id === activeConfigId)) {
          setActiveConfigId(finalRanked[0].id);
        }
      }
      setIsDownloadTesting(false);
      stopDownloadRequestedRef.current = false;
      setGlobalOperation?.(false);
    }
  };

  // Limit rendering count so DOM doesn't crash on 60,000 items
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden pt-8 pb-4 px-4">
      
      <div className="mb-3 flex flex-col gap-2">
        <div className="flex flex-col gap-2">
          <div className="flex justify-between items-end">
            <div>
              <h2 className="text-lg font-bold tracking-tight text-zinc-100">پروفایل‌ها</h2>
              <p className="text-[11px] text-zinc-500 mt-0.5">مدیریت کانفیگ‌ها و V2Ray Links</p>
            </div>
            <div className="flex flex-wrap justify-end gap-1.5">
              <button 
                onClick={pingAll}
                disabled={isPingingAll || isDownloadTesting || configs.length === 0 || !!globalOperation}
                className="text-[11px] px-2.5 py-1.5 bg-zinc-800/80 hover:bg-zinc-700 rounded-lg flex items-center gap-1.5 border border-zinc-700/50 transition-colors"
              >
                <Zap size={13} className={isPingingAll ? "animate-pulse text-yellow-400" : "text-zinc-400"} />
                <span>{isPingingAll ? 'درحال تست' : 'پینگ همه'}</span>
              </button>
              <button 
                onClick={runDownloadTest}
                disabled={isDownloadTesting || isPingingAll || configs.length === 0 || !!globalOperation}
                className="text-[11px] px-2.5 py-1.5 bg-cyan-600/10 hover:bg-cyan-600/20 rounded-lg flex items-center gap-1.5 border border-cyan-500/20 transition-colors text-cyan-300"
              >
                {isDownloadTesting ? <Activity size={13} className="animate-spin" /> : <Download size={13} />}
                <span>{isDownloadTesting ? 'در حال تست سرعت' : 'تست دانلود/آپلود'}</span>
              </button>
              <button
                onClick={selectBestConfig}
                disabled={!bestConfig || (!mobile && (isPingingAll || isDownloadTesting || !!globalOperation)) || configs.length === 0}
                className="text-[11px] px-2.5 py-1.5 bg-emerald-600/10 hover:bg-emerald-600/20 rounded-lg flex items-center gap-1.5 border border-emerald-500/20 transition-colors text-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed"
                title={bestConfig ? `Best score: ${computeConfigQuality(bestConfig).score}` : 'Run tests first'}
              >
                <Gauge size={13} />
                <span>بهترین</span>
                {bestConfig && <span className="font-mono text-[10px]" dir="ltr">{computeConfigQuality(bestConfig).score}</span>}
              </button>
              <button
                onClick={removeAllConfigs}
                disabled={isPingingAll || isDownloadTesting || isFetchingSub || isBulkImporting || configs.length === 0 || !!globalOperation}
                className="text-[11px] px-2.5 py-1.5 bg-rose-600/10 hover:bg-rose-600/20 rounded-lg flex items-center gap-1.5 border border-rose-500/20 transition-colors text-rose-300 disabled:opacity-50 disabled:cursor-not-allowed"
                title="حذف همه کانفیگ‌ها"
              >
                <Trash2 size={13} />
                <span>حذف همه</span>
              </button>
              {isPingingAll && (
                <button 
                  onClick={requestStopPing}
                  className="text-[11px] px-2.5 py-1.5 bg-rose-600/20 hover:bg-rose-600/30 rounded-lg flex items-center gap-1.5 border border-rose-500/30 transition-colors text-rose-400"
                >
                  <X size={13} />
                  <span>توقف</span>
                </button>
              )}
              {isDownloadTesting && (
                <button 
                  onClick={requestStopDownload}
                  className="text-[11px] px-2.5 py-1.5 bg-rose-600/20 hover:bg-rose-600/30 rounded-lg flex items-center gap-1.5 border border-rose-500/30 transition-colors text-rose-400"
                >
                  <X size={13} />
                  <span>توقف</span>
                </button>
              )}
            </div>
          </div>
          {isPingingAll && (
            <div className="space-y-1.5">
              <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-cyan-500 transition-all"
                  style={{ width: `${configTestPercent}%` }}
                />
              </div>
              <div className="text-xs text-zinc-400">
                {configTestCompleted.toLocaleString('fa-IR')} / {configTestTotal.toLocaleString('fa-IR')} کانفیگ تست شده ({configTestPercent}%)
              </div>
              {configTestMessage && (
                <div className="text-xs text-cyan-300 leading-5">
                  {configTestMessage}
                </div>
              )}
            </div>
          )}
          {isDownloadTesting && (
            <div className="space-y-1.5">
              <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-cyan-500 transition-all"
                  style={{ width: `${downloadTestPercent}%` }}
                />
              </div>
              <div className="text-xs text-zinc-400">
                {downloadTestCompleted.toLocaleString('fa-IR')} / {downloadTestTotal.toLocaleString('fa-IR')} کانفیگ؛ IP خروجی، دانلود و آپلود تست شد ({downloadTestPercent}%)
                {downloadTestFailed > 0 && ` - ${downloadTestFailed.toLocaleString('fa-IR')} حذف شد`}
                {downloadTestBelowMinimum > 0 && ` (${downloadTestBelowMinimum.toLocaleString('fa-IR')} مورد زیر ۱ Mbps)`}
              </div>
            </div>
          )}
        </div>

        {/* Subscription / clipboard import */}
        <div className="relative flex gap-2">
          <button 
            onClick={() => {
              if (subSourceLongPressTriggeredRef.current) {
                subSourceLongPressTriggeredRef.current = false;
                return;
              }
              fetchSelectedSubSource();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              openSubSourceMenu();
            }}
            onMouseDown={startSubSourceLongPress}
            onMouseUp={cancelSubSourceLongPress}
            onMouseLeave={cancelSubSourceLongPress}
            onTouchStart={startSubSourceLongPress}
            onTouchEnd={cancelSubSourceLongPress}
            onTouchCancel={cancelSubSourceLongPress}
            disabled={isFetchingSub}
            className="min-w-0 flex-1 text-[10px] px-2.5 py-1.5 bg-purple-600/10 text-purple-400 hover:bg-purple-600/20 rounded-lg flex items-center gap-1.5 border border-purple-500/20 transition-colors justify-center"
          >
            <LinkIcon size={12} />
            <span>{isFetchingSub ? 'درحال دریافت...' : 'دریافت کانفیگ'}</span>
            <span className="text-[9px] text-purple-300/70 truncate max-w-[72px]">
              {SUBSCRIPTION_SOURCES[selectedSubSourceIndex]?.name}
            </span>
          </button>
          <button
            onClick={handleAddFromClipboard}
            disabled={isReadingClipboard || isBulkImporting || isFetchingSub || isPingingAll || isDownloadTesting || !!globalOperation}
            className="shrink-0 text-[10px] px-2.5 py-1.5 bg-cyan-600/10 text-cyan-300 hover:bg-cyan-600/20 rounded-lg flex items-center gap-1.5 border border-cyan-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="افزودن کانفیگ از کلیپ‌بورد"
          >
            <ClipboardPaste size={12} />
            <span>{isReadingClipboard ? 'خواندن...' : 'افزودن از کلیپ‌بورد'}</span>
          </button>
          {showSubSourceMenu && (
            <div className="absolute right-0 left-0 top-full z-30 mt-2 rounded-xl border border-zinc-700/70 bg-zinc-950/95 p-2 shadow-2xl">
              <div className="flex items-center justify-between gap-2 px-2 pb-2">
                <span className="text-[11px] text-zinc-400">منبع دریافت</span>
                <button
                  onClick={() => setShowSubSourceMenu(false)}
                  className="w-6 h-6 rounded-lg bg-zinc-800 text-zinc-400 flex items-center justify-center hover:text-rose-400"
                >
                  <X size={12} />
                </button>
              </div>
              <div className="flex flex-col gap-1">
                {SUBSCRIPTION_SOURCES.map((source, index) => (
                  <button
                    key={source.url}
                    onClick={() => chooseSubSource(index)}
                    className={`w-full rounded-lg px-3 py-2 text-right text-[11px] transition-colors border
                      ${selectedSubSourceIndex === index
                        ? 'bg-purple-500/15 text-purple-200 border-purple-500/30'
                        : 'bg-zinc-900/80 text-zinc-300 border-zinc-800 hover:bg-zinc-800'
                      }`}
                  >
                    <div className="font-medium">{source.name}</div>
                    <div className="mt-1 truncate font-mono text-[9px] text-zinc-500" dir="ltr">{source.url}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {isFetchingSub && fetchSubTotal > 0 && (
          <div className="space-y-1.5 mb-2">
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-purple-500 transition-all"
                style={{ width: `${fetchSubPercent}%` }}
              />
            </div>
            <div className="text-xs text-zinc-400">
              درحال پردازش {fetchSubProgress.toLocaleString('fa-IR')} / {fetchSubTotal.toLocaleString('fa-IR')} کانفیگ ({fetchSubPercent}%)
            </div>
          </div>
        )}
      </div>

      {isBulkImporting && (
        <div className="mb-2 px-1">
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-500 transition-all"
              style={{ width: `${importPercent}%` }}
            />
          </div>
          <div className="text-xs text-zinc-400 mt-1.5">
            در حال افزودن {importCompleted.toLocaleString('fa-IR')} / {importTotal.toLocaleString('fa-IR')} کانفیگ ({importPercent}%)
          </div>
        </div>
      )}

      {/* Configs List */}
      <div className="flex-1 -mx-1.5 px-1.5 pb-2">
        {configs.length === 0 ? (
           <div className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-4 pt-10">
              <Smartphone size={48} className="opacity-20" />
              <p className="text-sm">هیچ سروری افزوده نشده است.</p>
           </div>
        ) : (
          <Virtuoso
            ref={configListRef}
            style={{ height: '100%' }}
            data={configs}
            itemContent={(index, config) => {
              const isActive = activeConfigId === config.id;
              const quality = computeConfigQuality(config);
              const latencySource = config.realDelay !== undefined
                ? 'real'
                : config.tcpPing !== undefined
                  ? 'tcp'
                  : 'legacy';
              const displayedLatency = latencySource === 'real'
                ? config.realDelay
                : latencySource === 'tcp'
                  ? config.tcpPing
                  : config.ping;
              const latencyPrefix = latencySource === 'real' ? 'R ' : latencySource === 'tcp' ? 'T ' : '';
              return (
                <div 
                  key={config.id}
                  onClick={() => setActiveConfigId(config.id)}
                  className={`w-full relative p-2.5 mb-1.5 rounded-lg border transition-all cursor-pointer flex flex-col gap-1.5
                    ${isActive 
                      ? 'bg-cyan-950/20 border-cyan-500/50 shadow-[0_0_15px_rgba(6,182,212,0.1)]' 
                      : 'glass-panel hover:bg-zinc-800/40'}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {isActive && <CheckCircle2 size={15} className="shrink-0 text-cyan-400" />}
                    <h4 className="flex-1 font-bold text-[12px] text-zinc-100 truncate text-right" dir="ltr">{config.name}</h4>
                    <span
                      className={`shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                        quality.score >= 70
                          ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
                          : quality.score >= 40
                            ? 'text-amber-300 border-amber-500/30 bg-amber-500/10'
                            : 'text-zinc-400 border-zinc-700 bg-zinc-800/50'
                      }`}
                      dir="ltr"
                    >
                      Q {quality.score}
                    </span>
                  </div>

                  <div className="flex justify-between items-center w-full gap-2 min-w-0">
                     <div className="flex gap-1.5 text-[10px] text-zinc-400 font-mono items-center min-w-0 flex-wrap" dir="ltr">
                       <span className="flex items-center gap-1 shrink-0"><Hash size={11}/> {config.type}</span>
                       <span className="flex items-center gap-1 truncate max-w-[130px]" title={config.resolvedIp ? `IP سرور: ${config.resolvedIp}` : undefined}>
                         <NavIcon size={11}/> {config.address}:{config.port}
                       </span>
                       {(config.exitIp || config.resolvedIp) && (
                         <span className="shrink-0 text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-700/50 flex items-center gap-1" title={`IP: ${config.exitIp || config.resolvedIp}`}>
                           <span>{config.exitIp || config.resolvedIp}</span>
                           <span className="text-[9px] font-sans text-emerald-200">
                             {getDisplayCountry(config.exitCountry, config.name)}
                           </span>
                         </span>
                       )}
                     </div>

                     <div className="flex items-center gap-2 shrink-0">
                       <button
                          onClick={(e) => pingConfig(e, config)}
                          className={`text-[11px] font-mono min-w-[54px] text-center transition-colors
                            ${displayedLatency === 'testing' ? 'text-yellow-400 animate-pulse' :
                              (typeof displayedLatency === 'number' && displayedLatency < 300) ? 'text-emerald-400' :
                              (typeof displayedLatency === 'number' && displayedLatency >= 300) ? 'text-amber-400' :
                              displayedLatency === 'error' ? 'text-rose-500' : 'text-zinc-500 hover:text-cyan-400'}`}
                       >
                         {displayedLatency === 'testing'
                           ? `${latencyPrefix}...`
                           : displayedLatency === 'error'
                             ? `${latencyPrefix}Timeout`
                             : typeof displayedLatency === 'number'
                               ? `${latencyPrefix}${displayedLatency}ms`
                               : '--'}
                       </button>
                       <div className="flex min-h-[24px] w-[92px] flex-col items-end justify-center gap-0.5 overflow-hidden text-[9px] font-mono whitespace-nowrap">
                         {config.downloadBps !== undefined && (
                           <span className={`max-w-full truncate ${typeof config.downloadBps === 'number' ? 'text-emerald-400' : config.downloadBps === 'testing' ? 'text-yellow-400 animate-pulse' : 'text-zinc-500'}`}>
                             D {formatBandwidth(config.downloadBps)}
                           </span>
                         )}
                         {config.uploadBps !== undefined && (
                           <span className={`max-w-full truncate ${typeof config.uploadBps === 'number' ? 'text-cyan-400' : config.uploadBps === 'testing' ? 'text-yellow-400 animate-pulse' : 'text-zinc-500'}`}>
                             U {formatBandwidth(config.uploadBps)}
                           </span>
                         )}
                       </div>

                       <button onClick={(e) => removeConfig(e, config.id)} className="text-zinc-600 hover:text-rose-500 p-0.5 transition-colors">
                         <Trash2 size={15} />
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


