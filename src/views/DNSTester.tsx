import React, { useRef, useState, useEffect } from 'react';
import { Search, Play, Activity, Globe, WifiHigh, ArrowDownWideNarrow, Check, X, Zap } from 'lucide-react';
import { DnsServer, V2RayConfig } from '../types';
import { Virtuoso } from 'react-virtuoso';
import { loadDnsCatalog } from '../utils';
import { getJsonValue, setJsonValue } from '../utils/appStorage';
import Xray from '../plugins/xray';
import { buildVpnStartPayload, serializeVpnPayload } from '../utils/vpnPayload';

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
  const [isDnsStorageHydrated, setIsDnsStorageHydrated] = useState(false);
  const abortRequestedRef = useRef(false);
  const abortSpeedRequestedRef = useRef(false);

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
      const downDiff = bandwidthScore(b.downloadBps) - bandwidthScore(a.downloadBps);
      if (downDiff !== 0) return downDiff;
    }

    return latencyScore(a.latency) - latencyScore(b.latency);
  });

  const bestDns = displayList[0];
  const bestDnsHasLatency = typeof bestDns?.latency === 'number';
  const bestDnsHasSpeed = typeof bestDns?.downloadBps === 'number';

  const runDNSTest = async () => {
    if (isTesting) return;
    if (globalOperation) { alert('یک عملیات در حال اجرا است، لطفاً صبر کنید.'); return; }
    setSortMode('latency');
    const ipsToTest = displayList.map(d => d.ip);
    if (ipsToTest.length === 0) return;

    setIsTesting(true);
    setGlobalOperation && setGlobalOperation(true);
    abortRequestedRef.current = false;
    setAbortRequested(false);
    setDnsTestTotal(ipsToTest.length);
    setDnsTestCompleted(0);

    let stateMap = new Map<string, DnsServer>(dnsList.map(d => [d.ip, d]));
    for (const ip of ipsToTest) {
      if (stateMap.has(ip)) {
        stateMap.set(ip, { ...stateMap.get(ip)!, latency: 'testing' });
      }
    }
    setDnsList(Array.from(stateMap.values()));

    let completed = 0;
    const queue = [...ipsToTest];
    const updateQueue = async (): Promise<void> => {
      if (abortRequestedRef.current) return;
      const ip = queue.shift();
      if (!ip) return;
      let latency: number | 'error' = 'error';
      try {
        const result = await Xray.testDnsResolve({
          dnsIp: ip,
          domain: 'cp.cloudflare.com',
          timeoutMs: 2500,
        });
        latency = result.ok && result.latency >= 0 ? result.latency : 'error';
      } catch (e) {
        latency = 'error';
      }

      if (stateMap.has(ip)) {
        stateMap.set(ip, { ...stateMap.get(ip)!, latency });
      }

      completed += 1;
      setDnsTestCompleted(completed);
      if (completed % 5 === 0 || queue.length === 0) {
        setDnsList(Array.from(stateMap.values()));
      }

      return updateQueue();
    };

    const CONCURRENCY = Math.min(12, ipsToTest.length);
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
    if (!activeConfig) {
      alert('برای تست ترافیک DNS، ابتدا یک کانفیگ فعال انتخاب کنید.');
      return;
    }
    if (!isConnectableProtocol(activeConfig.type)) {
      alert('برای تست ترافیک، یک کانفیگ vless / vmess / trojan / shadowsocks انتخاب کنید.');
      return;
    }

    setSortMode('bandwidth');
    const targets = displayList;
    if (targets.length === 0) return;

    setIsSpeedTesting(true);
    setGlobalOperation && setGlobalOperation(true);
    abortSpeedRequestedRef.current = false;
    setSpeedTestTotal(targets.length);
    setSpeedTestCompleted(0);

    const workerCount = Math.min(3, targets.length);
    const timeoutMs = 12_000;
    const bytes = 1_000_000;
    let stateMap = new Map<string, DnsServer>(dnsList.map(d => [d.ip, d]));
    for (const dns of targets) {
      if (stateMap.has(dns.ip)) {
        stateMap.set(dns.ip, { ...stateMap.get(dns.ip)!, downloadBps: 'testing', uploadBps: undefined });
      }
    }
    setDnsList(Array.from(stateMap.values()));

    let nextIndex = 0;
    let completed = 0;

    const worker = async () => {
      while (true) {
        if (abortSpeedRequestedRef.current) break;
        const index = nextIndex++;
        if (index >= targets.length) break;
        const dns = targets[index];
        let downloadBps: number | 'error' = 'error';

        try {
          const payload = {
            ...buildVpnStartPayload(activeConfig, dns),
            strictDns,
            bytes,
            timeoutMs,
          };
          const result = await Xray.measureConfigDownload({
            config: serializeVpnPayload(payload),
          });
          if (result.ok && result.downloadBps >= 0) {
            downloadBps = result.downloadBps;
          }
        } catch (e) {
          console.warn('Download test failed for DNS', dns.ip, e);
        }

        if (stateMap.has(dns.ip)) {
          stateMap.set(dns.ip, { ...stateMap.get(dns.ip)!, downloadBps, uploadBps: undefined });
        }

        completed += 1;
        setSpeedTestCompleted(completed);
        setDnsList(Array.from(stateMap.values()));
        if (completed % workerCount === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    };

    try {
      const workers = Array.from({ length: workerCount }, () => worker());
      await Promise.all(workers);
    } finally {
      setDnsList(Array.from(stateMap.values()));
      setIsSpeedTesting(false);
      abortSpeedRequestedRef.current = false;
      setGlobalOperation && setGlobalOperation(false);
    }
  };
  
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden pt-12 pb-24 px-6">
      
      <div className="mb-6">
        <h2 className="text-xl font-bold tracking-tight text-zinc-100 flex items-center gap-2">
          <Globe className="text-purple-400" />
          جعبه ابزار DNS
        </h2>
        <p className="text-xs text-zinc-500 mt-2 leading-relaxed">
          فهرست DNS به‌صورت گزینشی و عملیاتی تنظیم شده است (ایران + جهانی). هر تست با کانفیگ فعال روی اندروید تاخیر واقعی را اندازه‌گیری می‌کند.
        </p>
      </div>

      {activeDns && (
        <div className="mb-4 bg-purple-500/10 border border-purple-500/30 rounded-xl p-3 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-purple-500 text-white flex items-center justify-center shrink-0">
               <Check size={16} />
            </div>
            <div className="truncate">
              <p className="text-sm font-bold text-zinc-100 truncate">{activeDns.provider}</p>
              <p className="text-xs text-zinc-400 font-mono mt-0.5">{activeDns.ip}</p>
            </div>
          </div>
          <button 
            onClick={() => setActiveDns(null)}
            className="text-xs px-3 py-1.5 bg-zinc-800 text-zinc-400 rounded-lg hover:text-rose-400 transition-colors shrink-0"
          >
            لغو انتخاب
          </button>
        </div>
      )}

      {bestDns && !isTesting && !isSpeedTesting && ((sortMode === 'latency' && bestDnsHasLatency) || (sortMode === 'bandwidth' && bestDnsHasSpeed)) && (
        <div className="mb-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-3 flex justify-between items-center">
          <div className="truncate">
            <p className="text-sm font-bold text-zinc-100 truncate">{bestDns.provider}</p>
            <p className="text-xs text-emerald-400 font-mono mt-0.5" dir="ltr">
              {bestDns.ip} - {sortMode === 'bandwidth'
                ? `${formatBandwidth(bestDns.downloadBps)}`
                : `${bestDns.latency}ms`}
            </p>
          </div>
          <button
            onClick={() => setActiveDns(bestDns)}
            className="text-xs px-3 py-2 bg-emerald-600/20 text-emerald-300 rounded-lg border border-emerald-500/30 hover:bg-emerald-600/30 transition-colors shrink-0"
          >
            اعمال DNS
          </button>
        </div>
      )}

      <div className="mb-4 flex flex-col gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-3 text-zinc-500 w-4 h-4" />
          <input 
            type="text" 
            placeholder="جستجوی IP یا نام..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-10 pr-4 py-2 text-sm text-zinc-300 focus:outline-none focus:border-purple-500/50"
            dir="auto"
          />
        </div>
        <div className="flex gap-2">
          <button 
            onClick={runDNSTest}
            disabled={isTesting || isLoadingList || !!globalOperation}
            className="flex-1 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-xl px-4 py-2.5 flex items-center justify-center gap-2 transition-colors text-sm font-medium whitespace-nowrap"
          >
            {isTesting ? <Activity className="animate-spin w-4 h-4" /> : <Play className="w-4 h-4" />}
            {isTesting ? 'در حال پینگ' : 'پینگ DNS'}
          </button>
          <button 
            onClick={runTrafficTest}
            disabled={isSpeedTesting || isLoadingList || !!globalOperation}
            className="flex-1 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded-xl px-4 py-2.5 flex items-center justify-center gap-2 transition-colors text-sm font-medium whitespace-nowrap"
          >
            {isSpeedTesting ? <Activity className="animate-spin w-4 h-4" /> : <Zap className="w-4 h-4" />}
            {isSpeedTesting ? 'در حال تست دانلود' : 'تست دانلود 1MB'}
          </button>
          {(isTesting || isSpeedTesting) && (
            <button
              onClick={() => {
                abortRequestedRef.current = true;
                abortSpeedRequestedRef.current = true;
                setAbortRequested(true);
              }}
              className="bg-rose-600 hover:bg-rose-500 text-white rounded-xl px-3 flex items-center justify-center"
              title="توقف"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      {isTesting && dnsTestTotal > 0 && (
        <div className="mb-4 px-1">
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-500 transition-all"
              style={{ width: `${Math.floor((dnsTestCompleted / dnsTestTotal) * 100)}%` }}
            />
          </div>
          <p className="text-[11px] text-zinc-400 mt-2">
            {dnsTestCompleted.toLocaleString('fa-IR')} / {dnsTestTotal.toLocaleString('fa-IR')} تست انجام شده — {Math.floor((dnsTestCompleted / dnsTestTotal) * 100)}%
          </p>
        </div>
      )}

      {isSpeedTesting && speedTestTotal > 0 && (
        <div className="mb-4 px-1">
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-500 transition-all"
              style={{ width: `${Math.floor((speedTestCompleted / Math.max(speedTestTotal, 1)) * 100)}%` }}
            />
          </div>
          <p className="text-[11px] text-zinc-400 mt-2">
            {speedTestCompleted.toLocaleString('fa-IR')} / {speedTestTotal.toLocaleString('fa-IR')} تست دانلود انجام شده — {Math.floor((speedTestCompleted / Math.max(speedTestTotal, 1)) * 100)}%
          </p>
        </div>
      )}

      <div className="flex gap-2 mb-4 overflow-x-auto no-scrollbar pb-1">
        <button 
          onClick={() => setFilter('all')} 
          className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${filter === 'all' ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 text-zinc-400'}`}
        >
          همه
        </button>
        <button 
          onClick={() => setFilter('iran')} 
          className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${filter === 'iran' ? 'bg-purple-500 text-white' : 'bg-zinc-800 text-zinc-400'}`}
        >
          شکن و سرویس‌های ایران
        </button>
        <button 
          onClick={() => setFilter('global')} 
          className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${filter === 'global' ? 'bg-cyan-500 text-white' : 'bg-zinc-800 text-zinc-400'}`}
        >
          جهانی (Google, CF)
        </button>
        <div className="w-px h-6 bg-zinc-800 my-auto mx-1 shrink-0"></div>
        <button
          onClick={() => setSortMode('bandwidth')}
          className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors flex items-center gap-1 ${sortMode === 'bandwidth' ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' : 'bg-zinc-800 text-zinc-400'}`}
        >
          <ArrowDownWideNarrow size={14} />
          سرعت
        </button>
        <button
          onClick={() => setSortMode('latency')}
          className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors flex items-center gap-1 ${sortMode === 'latency' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' : 'bg-zinc-800 text-zinc-400'}`}
        >
          <Activity size={14} />
          پینگ
        </button>
        <button
          onClick={() => setStrictDns(!strictDns)}
          className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${strictDns ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-zinc-800 text-zinc-400'}`}
        >
          Strict DNS
        </button>
      </div>

      <div className="text-xs text-zinc-500 px-1 mb-2">
        {isLoadingList ? 'در حال بارگذاری...' : `${displayList.length.toLocaleString('fa-IR')} مورد`}
      </div>

      <div className="flex-1 min-h-0 -mx-2 px-2 pb-4">
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
              return (
                <div
                  onClick={() => setActiveDns(isActive ? null : dns)}
                  className={`flex justify-between items-center p-3 mb-2 rounded-xl cursor-pointer transition-all border ${
                    isActive
                      ? 'bg-purple-900/30 border-purple-500/50'
                      : 'glass-panel border-transparent hover:bg-zinc-800/40'
                  }`}
                >
                  <div className="flex items-center gap-3 truncate pr-2">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                      isActive ? 'bg-purple-500 text-white' : 'bg-zinc-800 text-zinc-400'
                    }`}>
                      {isActive ? <Check size={16} /> : <WifiHigh size={16} />}
                    </div>
                    <div className="truncate">
                      <p className="text-sm font-bold text-zinc-200 truncate">{dns.provider}</p>
                      <p className="text-xs text-zinc-500 font-mono">{dns.ip}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-right font-mono text-sm flex flex-col items-end gap-1">
                      <span>
                        {dns.latency === 'testing' ? '...' :
                         dns.latency === 'error' ? 'Timeout' :
                         dns.latency !== undefined ? `${dns.latency}ms` : '--'}
                      </span>
                      {dns.downloadBps !== undefined && (
                        <span className="text-[10px] text-zinc-400 whitespace-nowrap" dir="ltr">
                          <span className="text-emerald-400">D {formatBandwidth(dns.downloadBps)}</span>
                        </span>
                      )}
                    </div>
                    {(typeof dns.latency === 'number' || typeof dns.downloadBps === 'number') && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveDns(dns);
                        }}
                        className="text-[10px] px-2 py-1 bg-purple-600/20 text-purple-300 rounded border border-purple-500/30 hover:bg-purple-600/30 transition-colors"
                      >
                        اعمال
                      </button>
                    )}
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
