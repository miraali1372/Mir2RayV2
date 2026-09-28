import React, { useRef, useState, useEffect } from 'react';
import { Search, Play, Activity, Globe, WifiHigh, ArrowDownWideNarrow, Check, X, Zap, Trash2 } from 'lucide-react';
import { DnsServer, V2RayConfig } from '../types';
import { Virtuoso } from 'react-virtuoso';
import { loadDnsCatalog } from '../utils';
import { getJsonValue, setJsonValue } from '../utils/appStorage';
import Xray from '../plugins/xray';
import { buildVpnStartPayload, serializeVpnPayload } from '../utils/vpnPayload';
import {
  CONFIG_DELAY_TEST_URL,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DNS_DOWNLOAD_TEST_URL,
  DOWNLOAD_TEST_BYTES,
  DOWNLOAD_TEST_URL,
  UPLOAD_TEST_BYTES,
  UPLOAD_TEST_URL,
  getTestHost,
} from '../constants/testTargets';
import { progressPercent } from '../utils/progress';

const DNS_TEST_DOMAIN = getTestHost(CONFIG_DELAY_TEST_URL);
const DNS_TEST_TIMEOUT_MS = 3500;
const DNS_CONFIG_DELAY_TIMEOUT_MS = 7000;
const DNS_DOWNLOAD_TIMEOUT_MS = DEFAULT_DOWNLOAD_TIMEOUT_MS; // 8 s — allows 3-stream parallel download
const DNS_WORKERS = (() => {
  const cores =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(4, Math.min(40, cores * 2));
})();
const DNS_DIRECT_DOWNLOAD_WORKERS = 3;
const DNS_CONFIG_DOWNLOAD_WORKERS = 3;

interface DNSTesterProps {
  activeDns: DnsServer | null;
  setActiveDns: (dns: DnsServer | null) => void;
  activeConfig: V2RayConfig | null;
  globalOperation?: boolean;
  setGlobalOperation?: (val: boolean) => void;
}

export function DNSTester({ activeDns, setActiveDns, activeConfig, globalOperation, setGlobalOperation }: DNSTesterProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [dnsList, setDnsList] = useState<DnsServer[]>([]);
  const [isTesting, setIsTesting] = useState(false);
  const [isSpeedTesting, setIsSpeedTesting] = useState(false);
  const [abortRequested, setAbortRequested] = useState(false);
  const [filter, setFilter] = useState<'all' | 'iran' | 'global'>('all');
  const [sortMode, setSortMode] = useState<'bandwidth' | 'latency'>('bandwidth');
  const [strictDns, setStrictDns] = useState(true);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [dnsTestTotal, setDnsTestTotal] = useState(0);
  const [dnsTestCompleted, setDnsTestCompleted] = useState(0);
  const [speedTestTotal, setSpeedTestTotal] = useState(0);
  const [speedTestCompleted, setSpeedTestCompleted] = useState(0);
  const [speedTestFailed, setSpeedTestFailed] = useState(0);
  const [speedTestStage, setSpeedTestStage] = useState('');
  const [isDnsStorageHydrated, setIsDnsStorageHydrated] = useState(false);
  const abortRequestedRef = useRef(false);
  const abortSpeedRequestedRef = useRef(false);
  const dnsTestPercent = progressPercent(dnsTestCompleted, dnsTestTotal);
  const speedTestPercent = progressPercent(speedTestCompleted, speedTestTotal);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    (async () => {
      try {
        const saved = await getJsonValue<DnsServer[]>('dns_list', []);
        if (cancelled) return;
        if (saved.length > 0) {
          setDnsList(saved);
          setIsLoadingList(false);
          return;
        }
      } catch {
        // ignore parse failure and reload catalog
      }

      const list = await loadDnsCatalog();
      if (!cancelled) {
        setDnsList(list);
        setIsLoadingList(false);
      }
    })().finally(() => {
      if (!cancelled) setIsDnsStorageHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isDnsStorageHydrated) return;
    if (dnsList.length > 0) {
      setJsonValue('dns_list', dnsList).catch(error => {
        console.warn('Could not persist DNS list:', error);
      });
    }
  }, [dnsList, isDnsStorageHydrated]);

  let displayList = dnsList.filter(dns => {
    const matchesSearch = dns.ip.includes(searchTerm) || dns.provider.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = filter === 'all' ? true : dns.category === filter;
    return matchesSearch && matchesFilter;
  });

  const latencyScore = (val: number | 'error' | 'testing' | undefined) => {
    if (typeof val === 'number') return val;
    if (val === 'testing') return 999998;
    if (val === 'error') return 999999;
    return 1000000;
  };

  const bandwidthScore = (val: number | 'error' | 'testing' | undefined) => {
    if (typeof val === 'number') return val;
    if (val === 'testing') return -1;
    if (val === 'error') return -1;
    return -1;
  };

  const primaryLatency = (dns: DnsServer) => {
    return dns.configLatency !== undefined ? dns.configLatency : dns.latency;
  };

  const primaryDownload = (dns: DnsServer) => {
    return dns.configDownloadBps !== undefined
      ? dns.configDownloadBps
      : dns.directDownloadBps !== undefined
        ? dns.directDownloadBps
        : dns.downloadBps;
  };

  const primaryUpload = (dns: DnsServer) => {
    return dns.configUploadBps !== undefined
      ? dns.configUploadBps
      : dns.directUploadBps !== undefined
        ? dns.directUploadBps
        : dns.uploadBps;
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

  const isConnectableProtocol = (type?: V2RayConfig['type']) => {
    return type === 'vless' || type === 'vmess' || type === 'trojan' || type === 'shadowsocks';
  };

  displayList.sort((a, b) => {
    if (sortMode === 'bandwidth') {
      const aDownload = bandwidthScore(primaryDownload(a));
      const aUpload = bandwidthScore(primaryUpload(a));
      const bDownload = bandwidthScore(primaryDownload(b));
      const bUpload = bandwidthScore(primaryUpload(b));
      const balancedDiff = Math.min(bDownload, bUpload) - Math.min(aDownload, aUpload);
      if (balancedDiff !== 0) return balancedDiff;
      const uploadDiff = bUpload - aUpload;
      if (uploadDiff !== 0) return uploadDiff;
      const downDiff = bDownload - aDownload;
      if (downDiff !== 0) return downDiff;
    }

    return latencyScore(primaryLatency(a)) - latencyScore(primaryLatency(b));
  });

  const bestDns = displayList[0];
  const bestDnsHasLatency = typeof (bestDns ? primaryLatency(bestDns) : undefined) === 'number';
  const bestDnsHasSpeed = typeof (bestDns ? primaryDownload(bestDns) : undefined) === 'number'
    && typeof (bestDns ? primaryUpload(bestDns) : undefined) === 'number';

  const clearDnsTestResults = () => {
    setDnsList(prev => prev.map(dns => {
      const {
        latency,
        configLatency,
        downloadBps,
        directDownloadBps,
        configDownloadBps,
        uploadBps,
        directUploadBps,
        configUploadBps,
        ...rest
      } = dns;
      void latency;
      void configLatency;
      void downloadBps;
      void directDownloadBps;
      void configDownloadBps;
      void uploadBps;
      void directUploadBps;
      void configUploadBps;
      return rest;
    }));
  };

  const runDNSTest = async () => {
    if (isTesting) return;
    if (globalOperation) { alert('یک عملیات در حال اجرا است، لطفاً صبر کنید.'); return; }
    setSortMode('latency');
    const targets = displayList.map(d => d.ip);
    if (targets.length === 0) return;
    const canConfigTest = Boolean(activeConfig && isConnectableProtocol(activeConfig.type));

    setIsTesting(true);
    setGlobalOperation && setGlobalOperation(true);
    abortRequestedRef.current = false;
    setAbortRequested(false);
    setDnsTestTotal(targets.length * (canConfigTest ? 2 : 1));
    setDnsTestCompleted(0);

    let stateMap = new Map<string, DnsServer>(dnsList.map(d => [d.ip, d]));
    for (const ip of targets) {
      if (stateMap.has(ip)) {
        stateMap.set(ip, {
          ...stateMap.get(ip)!,
          latency: 'testing',
          configLatency: canConfigTest ? 'testing' : undefined,
        });
      }
    }
    setDnsList(Array.from(stateMap.values()));

    let completed = 0;
    const jobs: Array<{ ip: string; kind: 'direct' | 'config' }> = [];
    for (const ip of targets) {
      jobs.push({ ip, kind: 'direct' });
      if (canConfigTest) jobs.push({ ip, kind: 'config' });
    }
    const queue = [...jobs];
    const updateQueue = async (): Promise<void> => {
      if (abortRequestedRef.current) return;
      const job = queue.shift();
      if (!job) return;
      let latency: number | 'error' = 'error';
      try {
        if (job.kind === 'direct') {
          const result = await Xray.testDnsResolve({
            dnsIp: job.ip,
            domain: DNS_TEST_DOMAIN,
            timeoutMs: DNS_TEST_TIMEOUT_MS,
          });
          latency = result.ok && result.latency >= 0 ? result.latency : 'error';
        } else if (activeConfig) {
          const result = await Xray.measureConfigDelay({
            shareUri: activeConfig.rawUri,
            dnsIp: job.ip,
            cleanIp: activeConfig.cleanIp,
            strictDns,
            timeoutMs: DNS_CONFIG_DELAY_TIMEOUT_MS,
            testUrl: CONFIG_DELAY_TEST_URL,
          });
          latency = result.ok && result.latency >= 0 ? result.latency : 'error';
        }
      } catch (e) {
        latency = 'error';
      }

      if (stateMap.has(job.ip)) {
        const current = stateMap.get(job.ip)!;
        stateMap.set(job.ip, job.kind === 'direct'
          ? { ...current, latency }
          : { ...current, configLatency: latency }
        );
      }

      completed += 1;
      setDnsTestCompleted(completed);
      if (completed % 8 === 0 || queue.length === 0) {
        setDnsList(Array.from(stateMap.values()));
      }

      return updateQueue();
    };

    const CONCURRENCY = Math.min(DNS_WORKERS, queue.length);
    const workers = Array.from({ length: CONCURRENCY }, () => updateQueue());
    try {
      await Promise.all(workers);
    } finally {
      setDnsList(Array.from(stateMap.values()));
      setIsTesting(false);
      abortRequestedRef.current = false;
      setAbortRequested(false);
      setGlobalOperation && setGlobalOperation(false);
    }
  };


  const runTrafficTest = async () => {
    if (isSpeedTesting) return;
    if (globalOperation) { alert('یک عملیات در حال اجرا است، لطفاً صبر کنید.'); return; }
    const canConfigTest = Boolean(activeConfig && isConnectableProtocol(activeConfig.type));

    setSortMode('bandwidth');
    const targets = [...displayList];
    if (targets.length === 0) return;

    setIsSpeedTesting(true);
    setGlobalOperation?.(true);
    abortSpeedRequestedRef.current = false;
    setAbortRequested(false);
    setSpeedTestTotal(targets.length * (canConfigTest ? 2 : 1));
    setSpeedTestCompleted(0);
    setSpeedTestFailed(0);
    setSpeedTestStage('مرحله ۱: دانلود و آپلود مستقیم با DNS');

    const timeoutMs = DNS_DOWNLOAD_TIMEOUT_MS;
    const downloadBytes = DOWNLOAD_TEST_BYTES;
    const uploadBytes = UPLOAD_TEST_BYTES;
    const originalByIp = new Map(targets.map(dns => [dns.ip, dns]));
    let stateMap = new Map<string, DnsServer>(dnsList.map(d => [d.ip, d]));
    for (const dns of targets) {
      if (stateMap.has(dns.ip)) {
        stateMap.set(dns.ip, {
          ...stateMap.get(dns.ip)!,
          downloadBps: 'testing',
          uploadBps: 'testing',
          directDownloadBps: 'testing',
          directUploadBps: 'testing',
          configDownloadBps: undefined,
          configUploadBps: undefined,
        });
      }
    }
    setDnsList(Array.from(stateMap.values()));

    let completed = 0;
    const failedTests = new Set<string>();

    const commitResult = (
      dns: DnsServer,
      kind: 'direct' | 'config',
      downloadBps: number | 'error',
      uploadBps: number | 'error'
    ) => {
      if (downloadBps === 'error' || uploadBps === 'error') {
        failedTests.add(`${dns.ip}:${kind}`);
        setSpeedTestFailed(failedTests.size);
      }

      if (stateMap.has(dns.ip)) {
        const current = stateMap.get(dns.ip)!;
        stateMap.set(dns.ip, kind === 'direct'
          ? {
              ...current,
              directDownloadBps: downloadBps,
              directUploadBps: uploadBps,
              downloadBps,
              uploadBps,
            }
          : {
              ...current,
              configDownloadBps: downloadBps,
              configUploadBps: uploadBps,
              downloadBps,
              uploadBps,
            }
        );
      }

      completed += 1;
      setSpeedTestCompleted(completed);
      setDnsList(Array.from(stateMap.values()));
    };

    const runPool = async (
      laneTargets: DnsServer[],
      kind: 'direct' | 'config',
      concurrency: number
    ) => {
      let nextIndex = 0;
      const worker = async () => {
        while (!abortSpeedRequestedRef.current) {
          const index = nextIndex++;
          if (index >= laneTargets.length) break;
          const dns = laneTargets[index];
          if (!stateMap.has(dns.ip)) {
            completed += 1;
            setSpeedTestCompleted(completed);
            continue;
          }

          let downloadBps: number | 'error' = 'error';
          let uploadBps: number | 'error' = 'error';
          try {
            if (kind === 'direct') {
              const result = await Xray.measureDnsBandwidth({
                dnsIp: dns.ip,
                downloadUrl: DNS_DOWNLOAD_TEST_URL,
                uploadUrl: UPLOAD_TEST_URL,
                timeoutMs,
                downloadBytes,
                uploadBytes,
              });
              if (result.ok && result.downloadBps > 0 && result.uploadBps > 0) {
                downloadBps = result.downloadBps;
                uploadBps = result.uploadBps;
              }
            } else if (activeConfig) {
              const payload = {
                ...buildVpnStartPayload(activeConfig, dns),
                strictDns,
                downloadBytes,
                uploadBytes,
                timeoutMs,
                downloadUrl: DOWNLOAD_TEST_URL,
                uploadUrl: UPLOAD_TEST_URL,
              };
              const result = await Xray.measureConfigBandwidth({
                config: serializeVpnPayload(payload),
              });
              if (result.ok && result.downloadBps > 0 && result.uploadBps > 0) {
                downloadBps = result.downloadBps;
                uploadBps = result.uploadBps;
              }
            }
          } catch (e) {
            console.warn('Bandwidth test failed for a DNS entry', kind, e);
          }

          commitResult(dns, kind, downloadBps, uploadBps);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      };

      await Promise.all(Array.from(
        { length: Math.min(concurrency, laneTargets.length) },
        () => worker()
      ));
    };

    try {
      await runPool(targets, 'direct', DNS_DIRECT_DOWNLOAD_WORKERS);

      if (canConfigTest && !abortSpeedRequestedRef.current) {
        const configTargets = targets.filter(dns => stateMap.has(dns.ip));

        for (const dns of configTargets) {
          const current = stateMap.get(dns.ip);
          if (current) {
            stateMap.set(dns.ip, {
              ...current,
              configDownloadBps: 'testing',
              configUploadBps: 'testing',
              downloadBps: 'testing',
              uploadBps: 'testing',
            });
          }
        }
        setSpeedTestStage('مرحله ۲: دانلود و آپلود از داخل کانفیگ');
        setDnsList(Array.from(stateMap.values()));
        await runPool(configTargets, 'config', DNS_CONFIG_DOWNLOAD_WORKERS);
      }
    } finally {
      for (const dns of targets) {
        const current = stateMap.get(dns.ip);
        if (!current) continue;
        const original = originalByIp.get(dns.ip);
        const directDownloadBps = current.directDownloadBps === 'testing'
          ? original?.directDownloadBps
          : current.directDownloadBps;
        const configDownloadBps = current.configDownloadBps === 'testing'
          ? original?.configDownloadBps
          : current.configDownloadBps;
        const directUploadBps = current.directUploadBps === 'testing'
          ? original?.directUploadBps
          : current.directUploadBps;
        const configUploadBps = current.configUploadBps === 'testing'
          ? original?.configUploadBps
          : current.configUploadBps;
        const downloadBps = current.downloadBps === 'testing'
          ? configDownloadBps !== undefined
            ? configDownloadBps
            : directDownloadBps !== undefined
              ? directDownloadBps
              : original?.downloadBps
          : current.downloadBps;
        const uploadBps = current.uploadBps === 'testing'
          ? configUploadBps !== undefined
            ? configUploadBps
            : directUploadBps !== undefined
              ? directUploadBps
              : original?.uploadBps
          : current.uploadBps;
        stateMap.set(dns.ip, {
          ...current,
          directDownloadBps,
          configDownloadBps,
          directUploadBps,
          configUploadBps,
          downloadBps,
          uploadBps,
        });
      }

      setDnsList(Array.from(stateMap.values()));
      setIsSpeedTesting(false);
      abortSpeedRequestedRef.current = false;
      setAbortRequested(false);
      setSpeedTestStage('');
      setGlobalOperation?.(false);
    }
  };
  
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden pt-8 pb-4 px-4">
      
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold tracking-tight text-zinc-100 flex items-center gap-2">
          <Globe size={18} className="text-purple-400" />
          جعبه ابزار DNS
        </h2>
      </div>

      {(activeDns || (bestDns && !isTesting && !isSpeedTesting && ((sortMode === 'latency' && bestDnsHasLatency) || (sortMode === 'bandwidth' && bestDnsHasSpeed)))) && (
        <div className="mb-2 grid grid-cols-1 gap-1.5">
          {activeDns && (
            <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg px-2.5 py-2 flex justify-between items-center gap-2">
              <div className="min-w-0 flex items-center gap-2">
                <Check size={14} className="text-purple-300 shrink-0" />
                <div className="truncate">
                  <p className="text-xs font-bold text-zinc-100 truncate">{activeDns.provider}</p>
                  <p className="text-[10px] text-zinc-400 font-mono truncate" dir="ltr">{activeDns.ip}</p>
                </div>
              </div>
              <button
                onClick={() => setActiveDns(null)}
                className="text-[10px] px-2 py-1 bg-zinc-800 text-zinc-400 rounded-lg hover:text-rose-400 transition-colors shrink-0"
              >
                لغو
              </button>
            </div>
          )}

          {bestDns && !isTesting && !isSpeedTesting && ((sortMode === 'latency' && bestDnsHasLatency) || (sortMode === 'bandwidth' && bestDnsHasSpeed)) && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-2.5 py-2 flex justify-between items-center gap-2">
              <div className="min-w-0 truncate">
                <p className="text-xs font-bold text-zinc-100 truncate">بهترین: {bestDns.provider}</p>
                <p className="text-[10px] text-emerald-400 font-mono truncate" dir="ltr">
                  {bestDns.ip} - {sortMode === 'bandwidth'
                    ? `D ${formatBandwidth(primaryDownload(bestDns))} / U ${formatBandwidth(primaryUpload(bestDns))}`
                    : `${primaryLatency(bestDns)}ms`}
                </p>
              </div>
              <button
                onClick={() => setActiveDns(bestDns)}
                className="text-[10px] px-2 py-1 bg-emerald-600/20 text-emerald-300 rounded-lg border border-emerald-500/30 hover:bg-emerald-600/30 transition-colors shrink-0"
              >
                اعمال
              </button>
            </div>
          )}
        </div>
      )}

      <div className="mb-2 flex flex-col gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 text-zinc-500 w-4 h-4" />
          <input 
            type="text" 
            placeholder="جستجوی IP یا نام..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-[13px] text-zinc-300 focus:outline-none focus:border-purple-500/50"
            dir="auto"
          />
        </div>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
          <button 
            onClick={runDNSTest}
            disabled={isTesting || isLoadingList || !!globalOperation}
            className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-lg px-2 py-2 flex items-center justify-center gap-1.5 transition-colors text-[11px] font-medium whitespace-nowrap"
          >
            {isTesting ? <Activity className="animate-spin w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {isTesting ? 'در حال پینگ' : 'پینگ DNS'}
          </button>
          <button 
            onClick={runTrafficTest}
            disabled={isSpeedTesting || isLoadingList || !!globalOperation}
            className="bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded-lg px-2 py-2 flex items-center justify-center gap-1.5 transition-colors text-[11px] font-medium whitespace-nowrap"
          >
            {isSpeedTesting ? <Activity className="animate-spin w-3.5 h-3.5" /> : <Zap className="w-3.5 h-3.5" />}
            {isSpeedTesting ? 'در حال تست' : 'تست دانلود/آپلود'}
          </button>
          {(isTesting || isSpeedTesting) ? (
            <button
              onClick={() => {
                abortRequestedRef.current = true;
                abortSpeedRequestedRef.current = true;
                setAbortRequested(true);
              }}
              className="bg-rose-600 hover:bg-rose-500 text-white rounded-lg px-2 flex items-center justify-center"
              title="توقف"
            >
              <X className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={clearDnsTestResults}
              disabled={isLoadingList || !!globalOperation}
              className="bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-400 rounded-lg px-2 flex items-center justify-center"
              title="پاک‌کردن نتایج تست"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {isTesting && dnsTestTotal > 0 && (
        <div className="mb-2 px-1">
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-500 transition-all"
              style={{ width: `${dnsTestPercent}%` }}
            />
          </div>
          <p className="text-[11px] text-zinc-400 mt-1.5">
            {dnsTestCompleted.toLocaleString('fa-IR')} / {dnsTestTotal.toLocaleString('fa-IR')} تست انجام شده - {dnsTestPercent}%
          </p>
        </div>
      )}

      {isSpeedTesting && speedTestTotal > 0 && (
        <div className="mb-2 px-1">
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-500 transition-all"
              style={{ width: `${speedTestPercent}%` }}
            />
          </div>
          <p className="text-[11px] text-zinc-400 mt-1.5">
            {speedTestCompleted.toLocaleString('fa-IR')} / {speedTestTotal.toLocaleString('fa-IR')} تست دانلود/آپلود انجام شده - {speedTestPercent}%
            {speedTestFailed > 0 && ` - ${speedTestFailed.toLocaleString('fa-IR')} ناموفق`}
          </p>
          {speedTestStage && <p className="text-[10px] text-cyan-300 mt-1">{speedTestStage}</p>}
        </div>
      )}

      <div className="flex gap-1.5 mb-2 overflow-x-auto no-scrollbar pb-1">
        <button 
          onClick={() => setFilter('all')} 
          className={`px-2.5 py-1 rounded-lg text-[11px] font-medium whitespace-nowrap transition-colors ${filter === 'all' ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 text-zinc-400'}`}
        >
          همه
        </button>
        <button 
          onClick={() => setFilter('iran')} 
          className={`px-2.5 py-1 rounded-lg text-[11px] font-medium whitespace-nowrap transition-colors ${filter === 'iran' ? 'bg-purple-500 text-white' : 'bg-zinc-800 text-zinc-400'}`}
        >
          ایران
        </button>
        <button 
          onClick={() => setFilter('global')} 
          className={`px-2.5 py-1 rounded-lg text-[11px] font-medium whitespace-nowrap transition-colors ${filter === 'global' ? 'bg-cyan-500 text-white' : 'bg-zinc-800 text-zinc-400'}`}
        >
          جهانی
        </button>
        <div className="w-px h-5 bg-zinc-800 my-auto mx-0.5 shrink-0"></div>
        <button
          onClick={() => setSortMode('bandwidth')}
          className={`px-2.5 py-1 rounded-lg text-[11px] font-medium whitespace-nowrap transition-colors flex items-center gap-1 ${sortMode === 'bandwidth' ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' : 'bg-zinc-800 text-zinc-400'}`}
        >
          <ArrowDownWideNarrow size={12} />
          سرعت
        </button>
        <button
          onClick={() => setSortMode('latency')}
          className={`px-2.5 py-1 rounded-lg text-[11px] font-medium whitespace-nowrap transition-colors flex items-center gap-1 ${sortMode === 'latency' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' : 'bg-zinc-800 text-zinc-400'}`}
        >
          <Activity size={12} />
          پینگ
        </button>
        <button
          onClick={() => setStrictDns(!strictDns)}
          className={`px-2.5 py-1 rounded-lg text-[11px] font-medium whitespace-nowrap transition-colors ${strictDns ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-zinc-800 text-zinc-400'}`}
        >
          Strict DNS
        </button>
      </div>

      <div className="flex-1 min-h-0 -mx-1.5 px-1.5 pb-2">
        {isLoadingList && displayList.length === 0 ? (
           <div className="flex flex-col items-center justify-center p-10 text-zinc-500 font-medium text-sm gap-3">
             <Activity className="animate-spin text-purple-500" />
             در حال دریافت لیست DNS...
           </div>
        ) : displayList.length === 0 ? (
          <div className="text-center text-zinc-500 py-10 text-sm">موردی یافت نشد.</div>
        ) : (
          <Virtuoso
            style={{ height: '100%' }}
            data={displayList}
            itemContent={(_index, dns) => {
              const isActive = activeDns?.ip === dns.ip;
              const hasConfigLatency = dns.configLatency !== undefined;
              const hasDirectBandwidth = dns.directDownloadBps !== undefined || dns.directUploadBps !== undefined;
              const hasConfigBandwidth = dns.configDownloadBps !== undefined || dns.configUploadBps !== undefined;
              return (
                <div
                  onClick={() => setActiveDns(isActive ? null : dns)}
                  className={`flex justify-between items-center p-2.5 mb-1.5 rounded-lg cursor-pointer transition-all border ${
                    isActive
                      ? 'bg-purple-900/30 border-purple-500/50'
                      : 'glass-panel border-transparent hover:bg-zinc-800/40'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 pr-1">
                    {isActive ? <Check size={15} className="text-purple-300 shrink-0" /> : <WifiHigh size={15} className="text-zinc-500 shrink-0" />}
                    <div className="min-w-0 truncate">
                      <p className="text-[12px] font-bold text-zinc-200 truncate">{dns.provider}</p>
                      <p className="text-[10px] text-zinc-500 font-mono truncate" dir="ltr">{dns.ip}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-right font-mono text-[11px] flex flex-col items-end gap-0.5">
                      <span title="Direct DNS resolve" className={
                        dns.latency === 'testing' ? 'text-yellow-400 animate-pulse' :
                        dns.latency === 'error' ? 'text-rose-400' :
                        typeof dns.latency === 'number' ? 'text-emerald-400' : 'text-zinc-500'
                      }>
                        {dns.latency === 'testing' ? '...' :
                         dns.latency === 'error' ? 'Timeout' :
                         dns.latency !== undefined ? `${dns.latency}ms` : '--'}
                      </span>
                      {hasConfigLatency && (
                        <span className="text-[10px] text-purple-300 whitespace-nowrap" dir="ltr" title="Config delay with this DNS">
                          CFG {dns.configLatency === 'testing' ? '...' :
                            dns.configLatency === 'error' ? 'Timeout' :
                            typeof dns.configLatency === 'number' ? `${dns.configLatency}ms` : '--'}
                        </span>
                      )}
                      {(hasDirectBandwidth || hasConfigBandwidth || dns.downloadBps !== undefined || dns.uploadBps !== undefined) && (
                        <span className="text-[10px] text-zinc-400 flex flex-col items-end leading-4 whitespace-nowrap" dir="ltr">
                          {hasDirectBandwidth && (
                            <span className="text-emerald-400">
                              Direct D {formatBandwidth(dns.directDownloadBps)} / U {formatBandwidth(dns.directUploadBps)}
                            </span>
                          )}
                          {hasConfigBandwidth && (
                            <span className="text-cyan-400">
                              CFG D {formatBandwidth(dns.configDownloadBps)} / U {formatBandwidth(dns.configUploadBps)}
                            </span>
                          )}
                          {!hasDirectBandwidth && !hasConfigBandwidth && (
                            <span className="text-emerald-400">
                              D {formatBandwidth(dns.downloadBps)} / U {formatBandwidth(dns.uploadBps)}
                            </span>
                          )}
                        </span>
                      )}
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
