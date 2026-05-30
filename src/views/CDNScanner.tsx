import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Crosshair, Info, Layers, Play } from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import { DnsServer, V2RayConfig } from '../types';
import { generateCdnIps, measureConfigDelay, testCdnIpDirect } from '../utils';
import { getJsonValue, setJsonValue } from '../utils/appStorage';

interface CDNScannerProps {
  activeConfigId: string | null;
  configs: V2RayConfig[];
  setConfigs: React.Dispatch<React.SetStateAction<V2RayConfig[]>>;
  activeDns: DnsServer | null;
  setActiveDns?: (dns: DnsServer | null) => void;
  globalOperation?: boolean;
  setGlobalOperation?: (val: boolean) => void;
}

interface CleanIP {
  ip: string;
  provider: string;
  tcpLatency?: number | 'testing' | 'error';
  latency: number | 'testing' | 'error';
  verified?: boolean;
  scanDnsIp?: string;
  scanDnsProvider?: string;
  scanDnsCategory?: DnsServer['category'];
}

interface CdnScanSnapshot {
  ips: CleanIP[];
  scanProgress: number;
  scanTotal: number;
  scanCompleted: number;
}

const POOL_SIZE = 300;
const VERIFY_TOP_COUNT = 30;

function latencyScore(value: number | 'testing' | 'error' | undefined): number {
  if (typeof value === 'number') return value;
  if (value === 'testing') return 999998;
  return 999999;
}

export function CDNScanner({
  activeConfigId,
  configs,
  setConfigs,
  activeDns,
  setActiveDns,
  globalOperation,
  setGlobalOperation,
}: CDNScannerProps) {
  const [ips, setIps] = useState<CleanIP[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanTotal, setScanTotal] = useState(0);
  const [scanCompleted, setScanCompleted] = useState(0);
  const [abortRequested, setAbortRequested] = useState(false);
  const [isCdnStorageHydrated, setIsCdnStorageHydrated] = useState(false);
  const abortRequestedRef = useRef(false);
  const ipPool = useMemo(() => generateCdnIps(POOL_SIZE), []);

  const activeConfig = configs.find(c => c.id === activeConfigId);
  const sortedIps = [...ips].sort((a, b) => {
    if (a.verified && !b.verified) return -1;
    if (!a.verified && b.verified) return 1;
    return latencyScore(a.latency) - latencyScore(b.latency);
  });
  const bestVerifiedIp = sortedIps.find(item => item.verified && typeof item.latency === 'number');
  const bestTcpFallbackIp = sortedIps.find(item => typeof item.tcpLatency === 'number');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    (async () => {
      try {
        const saved = await getJsonValue<CdnScanSnapshot | null>('cdn_scan_snapshot', null);
        if (cancelled || !saved) return;
        setIps(saved.ips || []);
        setScanProgress(saved.scanProgress || 0);
        setScanTotal(saved.scanTotal || 0);
        setScanCompleted(saved.scanCompleted || 0);
      } catch {
        // ignore invalid storage
      } finally {
        if (!cancelled) setIsCdnStorageHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isCdnStorageHydrated) return;
    setJsonValue<CdnScanSnapshot>('cdn_scan_snapshot', {
      ips,
      scanProgress,
      scanTotal,
      scanCompleted,
    }).catch(error => {
      console.warn('Could not persist CDN scan:', error);
    });
  }, [ips, scanProgress, scanTotal, scanCompleted, isCdnStorageHydrated]);

  const startScan = async () => {
    if (isScanning) return;
    if (globalOperation) {
      alert('یک عملیات در حال اجرا است، لطفا صبر کنید.');
      return;
    }
    if (!activeConfig) {
      alert('برای تست واقعی CDN ابتدا یک کانفیگ فعال انتخاب کنید.');
      return;
    }

    abortRequestedRef.current = false;
    setAbortRequested(false);
    setIsScanning(true);
    setScanProgress(0);
    setGlobalOperation && setGlobalOperation(true);

    const sample = [...ipPool].sort(() => Math.random() - 0.5);
    const initialIps: CleanIP[] = sample.map(ip => ({
      ip: ip.ip,
      provider: ip.provider,
      tcpLatency: 'testing',
      latency: 'testing',
      verified: false,
      scanDnsIp: activeDns?.ip,
      scanDnsProvider: activeDns?.provider,
      scanDnsCategory: activeDns?.category,
    }));
    setIps(initialIps);
    setScanTotal(sample.length + VERIFY_TOP_COUNT);
    setScanCompleted(0);

    let completed = 0;
    const queue = [...sample];
    let latestResults = initialIps;

    const updateNext = async (): Promise<void> => {
      if (abortRequestedRef.current) return;
      const item = queue.shift();
      if (!item) return;

      let tcpLatency: number | 'error' = 'error';
      try {
        tcpLatency = await testCdnIpDirect(item.ip, 2500);
      } catch {
        tcpLatency = 'error';
      }

      completed += 1;
      setScanCompleted(completed);
      setScanProgress(Math.floor((completed / Math.max(sample.length + VERIFY_TOP_COUNT, 1)) * 100));
      latestResults = latestResults.map(p =>
        p.ip === item.ip ? { ...p, tcpLatency, latency: tcpLatency, verified: false } : p
      );
      if (completed % 5 === 0 || queue.length === 0) {
        setIps(latestResults);
      }

      return updateNext();
    };

    try {
      const workers = Array.from({ length: 6 }, () => updateNext());
      await Promise.all(workers);

      const candidates = [...latestResults]
        .filter(item => typeof item.tcpLatency === 'number')
        .sort((a, b) => latencyScore(a.tcpLatency) - latencyScore(b.tcpLatency))
        .slice(0, VERIFY_TOP_COUNT);

      const verifyQueue = [...candidates];
      const verifyNext = async (): Promise<void> => {
        if (abortRequestedRef.current) return;
        const candidate = verifyQueue.shift();
        if (!candidate) return;

        latestResults = latestResults.map(p => p.ip === candidate.ip ? { ...p, latency: 'testing' } : p);
        setIps(latestResults);

        const configLatency = await measureConfigDelay(
          activeConfig.rawUri,
          candidate.scanDnsIp,
          candidate.ip,
          6000,
          -1,
          true,
          [
            'https://cp.cloudflare.com/generate_204',
            'http://connectivitycheck.gstatic.com/generate_204',
          ]
        );

        completed += 1;
        setScanCompleted(completed);
        setScanProgress(Math.floor((completed / Math.max(sample.length + candidates.length, 1)) * 100));
        latestResults = latestResults.map(p => p.ip === candidate.ip ? {
          ...p,
          latency: configLatency,
          verified: typeof configLatency === 'number',
        } : p);
        if (completed % 3 === 0 || verifyQueue.length === 0) {
          setIps(latestResults);
        }

        return verifyNext();
      };

      const verifyWorkers = Array.from(
        { length: Math.min(8, candidates.length) },
        () => verifyNext()
      );
      await Promise.all(verifyWorkers);
    } finally {
      const sorted = [...latestResults].sort((a, b) => {
        if (a.verified && !b.verified) return -1;
        if (!a.verified && b.verified) return 1;
        return latencyScore(a.latency) - latencyScore(b.latency);
      });
      setIps(sorted);
      setScanProgress(abortRequestedRef.current ? scanProgress : 100);
      abortRequestedRef.current = false;
      setAbortRequested(false);
      setIsScanning(false);
      setGlobalOperation && setGlobalOperation(false);
    }
  };

  const applyCleanIp = (item: CleanIP) => {
    if (!activeConfigId) return;
    setConfigs(prev =>
      prev.map(c => (c.id === activeConfigId ? { ...c, cleanIp: item.ip } : c))
    );
    if (setActiveDns && item.scanDnsIp) {
      setActiveDns({
        ip: item.scanDnsIp,
        provider: item.scanDnsProvider || 'DNS used in scan',
        category: item.scanDnsCategory || 'custom',
      });
    }
  };

  const workingIpsCount = ips.filter(i => i.verified).length;

  return (
    <div className="flex flex-col h-full bg-zinc-950 p-4 pb-0">
      <div className="flex-none mb-6">
        <h1 className="text-xl font-bold text-zinc-100 flex items-center gap-2 mb-2">
          <Crosshair className="text-cyan-400" size={24} />
          اسکنر IP تمیز CDN
        </h1>
        <p className="text-xs text-zinc-400 leading-relaxed">
          ابتدا IPها با TCP سریع غربال می‌شوند، سپس بهترین‌ها با خود کانفیگ فعال و Clean IP جایگزین‌شده تست real delay می‌گیرند.
        </p>
      </div>

      <div className="flex-none mb-4">
        {activeConfig ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex flex-col gap-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-zinc-400">کانفیگ فعال:</span>
              <span className="text-cyan-400 font-bold max-w-[150px] truncate" dir="ltr">{activeConfig.name}</span>
            </div>
            <div className="flex justify-between items-center text-xs border-t border-zinc-800/50 pt-2 mt-1">
              <span className="text-zinc-400">IP تمیز فعلی:</span>
              <span className="text-emerald-400 font-mono">{activeConfig.cleanIp || 'تنظیم نشده'}</span>
            </div>
            <div className="flex justify-between items-center text-xs border-t border-zinc-800/50 pt-2 mt-1">
              <span className="text-zinc-400">DNS فعال:</span>
              <span className="text-emerald-400 font-mono">{activeDns?.provider || 'بدون DNS'}</span>
            </div>
          </div>
        ) : (
          <div className="bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs p-3 rounded-xl flex items-start gap-2">
            <Info size={16} className="mt-0.5 shrink-0" />
            <p>برای اسکن واقعی CDN ابتدا یک کانفیگ انتخاب کنید.</p>
          </div>
        )}
      </div>

      {ips.length > 0 && !isScanning && (bestVerifiedIp || bestTcpFallbackIp) && (
        <div className="flex-none mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-zinc-400 mb-1">
              {bestVerifiedIp ? 'بهترین IP تایید شده با کانفیگ' : 'بهترین IP TCP برای تست دستی'}
            </div>
            <div className="font-mono text-sm text-emerald-300 truncate" dir="ltr">
              {(bestVerifiedIp || bestTcpFallbackIp)!.ip}
              {' '}
              {bestVerifiedIp && typeof bestVerifiedIp.latency === 'number'
                ? `${bestVerifiedIp.latency}ms real`
                : `${bestTcpFallbackIp!.tcpLatency}ms tcp`}
            </div>
          </div>
          <button
            onClick={() => applyCleanIp((bestVerifiedIp || bestTcpFallbackIp)!)}
            className="shrink-0 px-3 py-2 rounded-lg bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold hover:bg-emerald-600/30"
          >
            اعمال
          </button>
        </div>
      )}

      <div className="flex-none mb-2 px-1 flex justify-between items-center">
        <span className="text-xs text-zinc-500 flex items-center gap-1">
          <Layers size={14} />
          استخر: <strong>{POOL_SIZE.toLocaleString('fa-IR')}</strong> IP
        </span>
        {ips.length > 0 && !isScanning && (
          <span className="text-xs font-bold text-emerald-500">{workingIpsCount} IP تایید واقعی</span>
        )}
      </div>

      <div className="flex gap-2 mb-4">
        <button
          onClick={startScan}
          disabled={isScanning || !activeConfig}
          className="flex-1 py-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-bold flex items-center justify-center gap-2"
        >
          <Play size={18} className={isScanning ? 'animate-pulse' : ''} />
          {isScanning ? `اسکن ${scanProgress}%` : 'شروع اسکن واقعی CDN'}
        </button>
        <button
          onClick={() => {
            abortRequestedRef.current = true;
            setAbortRequested(true);
          }}
          disabled={!isScanning}
          className="w-28 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white font-bold"
        >
          قطع
        </button>
      </div>
      {isScanning && scanTotal > 0 && (
        <div className="mb-4 px-1">
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-500 transition-all"
              style={{ width: `${scanProgress}%` }}
            />
          </div>
          <p className="text-[11px] text-zinc-400 mt-2">
            {scanCompleted.toLocaleString('fa-IR')} / {scanTotal.toLocaleString('fa-IR')} تست انجام شده
          </p>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {ips.length === 0 ? (
          <div className="text-center text-zinc-500 text-sm py-12">هنوز اسکن نشده است.</div>
        ) : (
          <Virtuoso
            style={{ height: '100%' }}
            data={sortedIps}
            itemContent={(_i, item) => (
              <div className="flex justify-between items-center p-3 mb-2 glass-panel rounded-xl">
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-sm text-zinc-200" dir="ltr">{item.ip}</span>
                  <span className="text-[10px] text-zinc-500">
                    {item.provider}
                    {typeof item.tcpLatency === 'number' ? ` | tcp ${item.tcpLatency}ms` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-mono ${
                    item.verified ? 'text-emerald-400' :
                    typeof item.latency === 'number' ? 'text-cyan-400' :
                    item.latency === 'testing' ? 'text-yellow-400' : 'text-rose-500'
                  }`}>
                    {item.latency === 'testing' ? '...' : item.latency === 'error' ? 'Timeout' : `${item.latency}ms ${item.verified ? 'real' : 'tcp'}`}
                  </span>
                  {(item.verified || typeof item.tcpLatency === 'number') && (
                    <button
                      onClick={() => applyCleanIp(item)}
                      disabled={!activeConfigId}
                      className="text-[10px] px-2 py-1 bg-cyan-600/20 text-cyan-400 rounded border border-cyan-500/30 disabled:opacity-40"
                    >
                      <Check size={12} className="inline" /> اعمال
                    </button>
                  )}
                </div>
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
}
