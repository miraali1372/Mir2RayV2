import React, { useState, useEffect, useRef } from 'react';
import Xray from './plugins/xray';
import { ViewState, V2RayConfig, DnsServer } from './types';
import { getAppValue, getJsonValue, removeAppValue, setAppValue, setJsonValue } from './utils/appStorage';
import { Navigation } from './components/Navigation';
import { Dashboard } from './views/Dashboard';
import { Profiles } from './views/Profiles';
import { DNSTester } from './views/DNSTester';
import { compareVersions, fetchLatestRelease, formatVersion, GITHUB_OWNER, GITHUB_REPO, pickApkAsset, pickWindowsAsset } from './utils/update';
import { startVpn } from './utils/vpnControl';
import { isNativeRuntime, runtimePlatform } from './utils/platform';
import { Capacitor } from '@capacitor/core';

export default function App() {
  const [currentView, setCurrentView] = useState<ViewState>('dashboard');
  
  // App-level state for configs
  const [configs, setConfigs] = useState<V2RayConfig[]>([]);
  const [activeConfigId, setActiveConfigId] = useState<string | null>(null);
  const [activeDns, setActiveDns] = useState<DnsServer | null>(null);
  const [isStorageHydrated, setIsStorageHydrated] = useState(false);

  // App-level VPN state to keep it alive across unmounts
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [uptime, setUptime] = useState(0);
  const [globalOperation, setGlobalOperation] = useState(false);
  const [currentVersion, setCurrentVersion] = useState('1.0.1');
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateMessage, setUpdateMessage] = useState('');
  const [hasUpdate, setHasUpdate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [geoUpdating, setGeoUpdating] = useState(false);
  const [geoMessage, setGeoMessage] = useState('');
  const [fakeDnsEnabled, setFakeDnsEnabled] = useState(false);
  const [dohEnabled, setDohEnabled] = useState(false);
  const [networkKey, setNetworkKey] = useState('unknown');
  const mobile = Capacitor.getPlatform() === 'android';
  const measurementContext = JSON.stringify([networkKey, activeDns?.ip ?? '', fakeDnsEnabled, dohEnabled]);

  useEffect(() => {
    if (!mobile) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const context = await Xray.getNetworkContext();
        if (!cancelled) setNetworkKey(context.key);
      } catch { }
    };
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [mobile]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    (async () => {
      let restored = false;
      try {
        const [savedConfigs, savedActiveConfigId, savedActiveDns, savedView, savedFakeDns, savedDoh] = await Promise.all([
          getJsonValue<V2RayConfig[]>('configs', []),
          getAppValue('active_config_id'),
          getJsonValue<DnsServer | null>('active_dns', null),
          getAppValue('current_view'),
          getAppValue('fakedns_enabled'),
          getAppValue('doh_enabled'),
        ]);
        if (!cancelled) {
          setConfigs(savedConfigs);
          setActiveConfigId(savedActiveConfigId);
          setActiveDns(savedActiveDns);
          setFakeDnsEnabled(savedFakeDns === '1');
          setDohEnabled(savedDoh === '1');
          if (savedView && ['dashboard','profiles','dns'].includes(savedView)) {
            setCurrentView(savedView as ViewState);
          }
          restored = true;
        }
      } catch (error) {
        console.warn('Could not restore application state:', error);
      } finally {
        if (!cancelled && restored) setIsStorageHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isStorageHydrated) return;
    setJsonValue('configs', configs).catch(error => {
      console.warn('Could not persist configs:', error);
    });
  }, [configs, isStorageHydrated]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isStorageHydrated) return;
    if (activeConfigId) {
      setAppValue('active_config_id', activeConfigId).catch(error => {
        console.warn('Could not persist active config:', error);
      });
    } else {
      removeAppValue('active_config_id').catch(error => {
        console.warn('Could not remove active config:', error);
      });
    }
  }, [activeConfigId, isStorageHydrated]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isStorageHydrated) return;
    if (activeDns) {
      setJsonValue('active_dns', activeDns).catch(error => {
        console.warn('Could not persist active DNS:', error);
      });
    } else {
      removeAppValue('active_dns').catch(error => {
        console.warn('Could not remove active DNS:', error);
      });
    }
  }, [activeDns, isStorageHydrated]);

  const initialStatusSyncedRef = useRef(false);

  useEffect(() => {
    if (!isNativeRuntime()) return;

    const refreshStatus = async () => {
      try {
        const status = await Xray.getStatus();
        setIsConnected(status.running);
        if (!initialStatusSyncedRef.current) {
          initialStatusSyncedRef.current = true;
          if (status.running && status.activeConfigId) {
            setActiveConfigId(status.activeConfigId);
          }
        }
        setAppValue('vpn_last_state', (status.desired ?? status.running) ? '1' : '0').catch(error => {
          console.warn('Could not persist VPN state:', error);
        });
        setAppValue('vpn_last_updated_at', new Date().toISOString()).catch(error => {
          console.warn('Could not persist VPN status timestamp:', error);
        });
        if (!status.running) setIsConnecting(false);
      } catch {
        // ignore
      }
    };

    refreshStatus();

    const onWindowFocus = async () => {
      await refreshStatus();
    };

    window.addEventListener('focus', onWindowFocus);
    const statusTimer = setInterval(refreshStatus, 3000);
    return () => {
      clearInterval(statusTimer);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await Xray.getAppVersionInfo();
        if (!cancelled && info.versionName) {
          setCurrentVersion(info.versionName);
        }
      } catch (error) {
        console.warn('Could not read app version:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isStorageHydrated) return;
    setAppValue('current_view', currentView).catch(error => {
      console.warn('Could not persist current view:', error);
    });
  }, [currentView, isStorageHydrated]);

  const handleCheckUpdate = async () => {
    if (updateChecking) return;

    setUpdateChecking(true);
    setUpdateMessage('در حال بررسی آخرین نسخه...');
    setHasUpdate(false);

    try {
      const info = await Xray.getAppVersionInfo();
      const installedVersion = info.versionName || currentVersion;
      setCurrentVersion(installedVersion);

      const platform = info.platform || runtimePlatform();
      if (installedVersion === 'web' || platform === 'web') {
        setLatestVersion(null);
        setHasUpdate(false);
        setUpdateMessage('به‌روزرسانی خودکار در نسخه وب فعال نیست.');
        return;
      }

      let updateTarget: {
        tagName: string;
        latest: string;
        assetName: string;
        downloadUrl: string;
        note: string;
      };

      try {
        const release = await fetchLatestRelease();
        const asset = platform === 'windows' ? pickWindowsAsset(release) : pickApkAsset(release);
        if (!asset) {
          throw new Error(platform === 'windows' ? 'Windows portable asset was not found in the GitHub release' : 'APK asset was not found in the GitHub release');
        }
        const latest = formatVersion(release.tag_name);
        const note = (release.body || '')
          .split('\n')
          .map(line => line.trim())
          .find(line => line && !line.startsWith('#')) || `نسخه جدید ${latest} آماده دانلود است.`;
        updateTarget = {
          tagName: release.tag_name,
          latest,
          assetName: asset.name,
          downloadUrl: asset.browser_download_url,
          note,
        };
      } catch (releaseError) {
        console.warn('GitHub API update path failed, trying latest release redirect:', releaseError);
        const fallback = await Xray.resolveLatestRelease({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          installedVersion,
        });
        if (!fallback.ok || !fallback.tagName || !fallback.downloadUrl) {
          throw new Error(fallback.message || 'Could not resolve latest GitHub APK');
        }
        const latest = formatVersion(fallback.tagName);
        updateTarget = {
          tagName: fallback.tagName,
          latest,
          assetName: fallback.assetName || (platform === 'windows' ? `Mir2rayV2-${latest}-Portable.exe` : `Mir2rayV2-${latest}.apk`),
          downloadUrl: fallback.downloadUrl,
          note: `نسخه جدید ${latest} آماده دانلود است.`,
        };
      }

      setLatestVersion(updateTarget.latest);

      if (compareVersions(updateTarget.tagName, installedVersion) <= 0) {
        setHasUpdate(false);
        setUpdateMessage('این آخرین ورژن هست.');
        return;
      }

      setHasUpdate(true);
      setUpdateMessage(updateTarget.note);

      try {
        const downloaded = await Xray.downloadAndInstallApk({
          url: updateTarget.downloadUrl,
          fileName: updateTarget.assetName,
        });
        if (!downloaded.ok) {
          throw new Error(downloaded.message || 'Could not start APK download');
        }
        setUpdateMessage(`${updateTarget.note} دانلود و نصب آغاز شد.`);
      } catch (installError) {
        console.warn('Native APK download failed, falling back to browser:', installError);
        const opened = await Xray.openExternalUrl({ url: updateTarget.downloadUrl });
        if (!opened.ok) {
          throw installError;
        }
        setUpdateMessage(`${updateTarget.note} لینک دانلود در مرورگر باز شد.`);
      }
    } catch (error) {
      console.warn('Update check failed:', error);
      setHasUpdate(false);
      const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
      setUpdateMessage(`بررسی یا دانلود آپدیت ناموفق بود${detail}`);
    } finally {
      setUpdateChecking(false);
    }
  };

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const persistAppVpnState = async (running: boolean) => {
    const stamp = new Date().toISOString();
    setIsConnected(running);
    try {
      const writes: Array<Promise<unknown>> = [
        setAppValue('vpn_last_state', running ? '1' : '0'),
        setAppValue('vpn_last_updated_at', stamp),
      ];
      if (!running) {
        writes.push(removeAppValue('vpn_session_key'));
      }
      await Promise.all(writes);
    } catch (error) {
      console.warn('Could not persist VPN state:', error);
    }
  };

  const waitForVpnStopped = async (timeoutMs = 12000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const status = await Xray.getStatus();
        if (!status.running && !status.starting) return true;
      } catch {
        return true;
      }
      await sleep(300);
    }
    return false;
  };

  const waitForVpnRunning = async (timeoutMs = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const status = await Xray.getStatus();
        if (status.running) return true;
      } catch {
        // ignore transient status failures while the service is coming up
      }
      await sleep(300);
    }
    return false;
  };

  const readReconnectOptions = async () => {
    await Promise.all([
      setAppValue('routing_mode', 'global'),
      setAppValue('top5_enabled', '0'),
      setAppValue('auto_switch_enabled', '0'),
    ]).catch(error => {
      console.warn('Could not keep hidden reconnect switches off:', error);
    });

    return {
      topFiveEnabled: false,
      routingMode: 'global' as const,
      allowedApps: [],
      disallowedApps: [],
    };
  };

  const reconnectAfterGeoUpdate = async () => {
    if (!activeConfig) {
      return { success: false, error: 'کانفیگ فعالی برای اتصال مجدد انتخاب نشده است.' };
    }

    const reconnectOptions = await readReconnectOptions();
    const primaryConfig = activeConfig;
    const result = await startVpn(primaryConfig, activeDns, {
      fakeDns: fakeDnsEnabled,
      doh: dohEnabled,
      topFiveEnabled: reconnectOptions.topFiveEnabled,
      balancedConfigs: [primaryConfig],
      routingMode: reconnectOptions.routingMode,
      allowedApps: reconnectOptions.allowedApps,
      disallowedApps: reconnectOptions.disallowedApps,
    });

    if (!result.success) {
      await persistAppVpnState(false);
      return result;
    }

    const running = await waitForVpnRunning();
    if (!running) {
      await persistAppVpnState(false);
      return { success: false, error: 'سرویس VPN بعد از اتصال مجدد روشن نشد.' };
    }

    if (primaryConfig.id !== activeConfig.id) {
      setActiveConfigId(primaryConfig.id);
    }
    await persistAppVpnState(true);
    return { success: true, fallbackToSingle: result.fallbackToSingle };
  };

  const handleUpdateGeo = async () => {
    if (geoUpdating) return;
    if (!isNativeRuntime()) {
      setGeoMessage('به‌روزرسانی دیتابیس روتینگ فقط در نسخه نصب‌شده فعال است.');
      return;
    }
    
    const wasConnected = isConnected;
    setGlobalOperation(true);
    setGeoUpdating(true);
    if (wasConnected) {
      setGeoMessage('در حال قطع اتصال برای به‌روزرسانی دیتابیس‌ها...');
      try {
        await Xray.stopVpn();
        const stopped = await waitForVpnStopped();
        await persistAppVpnState(false);
        if (!stopped) {
          setGeoMessage('VPN کامل متوقف نشد؛ چند ثانیه دیگر دوباره امتحان کنید.');
          setGeoUpdating(false);
          setGlobalOperation(false);
          return;
        }
      } catch (e) {
        console.warn('Failed to stop VPN before geo update:', e);
        await persistAppVpnState(false);
        setGeoMessage('قطع اتصال قبل از آپدیت دیتابیس ناموفق بود؛ دوباره امتحان کنید.');
        setGeoUpdating(false);
        setGlobalOperation(false);
        return;
      }
    }
    
    setGeoMessage('در حال دانلود آخرین دیتابیس‌های روتینگ (geoip/geosite)...');
    try {
      const res = await Xray.updateGeoAssets();
      if (res.ok) {
        const mb = (n: number) => (n / 1_000_000).toFixed(1);
        setGeoMessage(`به‌روز شد ✅ (geoip ${mb(res.geoipBytes)}MB، geosite ${mb(res.geositeBytes)}MB).`);
        
        // If VPN was connected, automatically restart it with new geo databases
        if (wasConnected && activeConfig) {
          setGeoMessage('در حال راه‌اندازی مجدد اتصال با دیتابیس‌های جدید...');
          try {
            const result = await reconnectAfterGeoUpdate();
            
            if (result.success) {
              setGeoMessage('به‌روز شد ✅ و اتصال مجدداً برقرار شد.');
            } else {
              setGeoMessage(`به‌روز شد ✅ اما اتصال مجدد ناموفق بود: ${result.error}`);
            }
          } catch (reconnectError) {
            console.warn('Reconnect after geo update failed:', reconnectError);
            setGeoMessage(`به‌روز شد ✅ اما اتصال مجدد ناموفق بود. لطفاً دستی وصل کنید. (${reconnectError instanceof Error ? reconnectError.message : 'خطا'})`);
          }
        }
      } else {
        setGeoMessage(res.message || 'به‌روزرسانی ناموفق بود؛ اتصال اینترنت یا فیلترشکن را بررسی کنید.');
        // If we stopped VPN but update failed, try to reconnect
        if (wasConnected && activeConfig) {
          try {
            await reconnectAfterGeoUpdate();
          } catch (e) {
            console.warn('Failed to restore connection after failed geo update:', e);
          }
        }
      }
    } catch (error) {
      console.warn('Geo update failed:', error);
      const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
      setGeoMessage(`خطا در به‌روزرسانی دیتابیس‌ها${detail}`);
      // Try to restore connection if it was active
      if (wasConnected && activeConfig) {
        try {
          await reconnectAfterGeoUpdate();
        } catch (e) {
          console.warn('Failed to restore connection after geo update error:', e);
        }
      }
    } finally {
      setGeoUpdating(false);
      setGlobalOperation(false);
    }
  };

  const toggleFakeDns = () => {
    const next = !fakeDnsEnabled;
    setFakeDnsEnabled(next);
    setAppValue('fakedns_enabled', next ? '1' : '0').catch(() => {});
  };

  const toggleDoh = () => {
    const next = !dohEnabled;
    setDohEnabled(next);
    setAppValue('doh_enabled', next ? '1' : '0').catch(() => {});
  };

  // Load the installed app version once so the settings panel shows it.
  useEffect(() => {
    if (!isNativeRuntime()) return;
    let cancelled = false;
    Xray.getAppVersionInfo()
      .then(info => { if (!cancelled && info.versionName) setCurrentVersion(info.versionName); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const activeConfig = configs.find(c => c.id === activeConfigId) || null;

  return (
    <div className="mobile-app-container font-sans" dir="rtl">

      {/* Settings / update button */}
      <button
        onClick={() => setShowSettings(true)}
        aria-label="تنظیمات و به‌روزرسانی"
        className="fixed top-3 left-3 z-40 w-9 h-9 rounded-full bg-zinc-800/70 border border-zinc-700/60 flex items-center justify-center text-zinc-300 hover:text-cyan-400 hover:border-cyan-500/50 backdrop-blur transition-colors"
      >
        <span className="text-lg leading-none">⚙</span>
      </button>

      {showSettings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setShowSettings(false)}
        >
          <div
            className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-3xl p-5 max-h-[85vh] overflow-y-auto overscroll-contain shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-zinc-100">تنظیمات و به‌روزرسانی</h3>
              <button onClick={() => setShowSettings(false)} className="text-zinc-400 hover:text-zinc-200 text-xl leading-none">✕</button>
            </div>

            <div className="text-xs text-zinc-500 mb-4">نسخه نصب‌شده: <span className="text-zinc-300">{currentVersion}</span>{latestVersion ? <span className="text-zinc-500"> · آخرین: {latestVersion}</span> : null}</div>

            {/* App update */}
            <button
              onClick={handleCheckUpdate}
              disabled={updateChecking}
              className={`w-full mb-2 py-3 rounded-xl font-medium text-sm transition-colors ${updateChecking ? 'bg-zinc-800 text-zinc-500' : hasUpdate ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-zinc-950' : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'}`}
            >
              {updateChecking ? 'در حال بررسی...' : 'بررسی و نصب آخرین نسخه برنامه'}
            </button>
            {updateMessage ? <p className="text-xs text-zinc-400 mb-4 px-1">{updateMessage}</p> : <div className="mb-4" />}

            {/* Routing database (package) update */}
            <button
              onClick={handleUpdateGeo}
              disabled={geoUpdating}
              className={`w-full py-3 rounded-xl font-medium text-sm transition-colors ${geoUpdating ? 'bg-zinc-800 text-zinc-500' : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'}`}
            >
              {geoUpdating ? 'در حال به‌روزرسانی...' : 'به‌روزرسانی دیتابیس‌های روتینگ (geoip/geosite)'}
            </button>
            <p className="text-[11px] text-zinc-500 mt-2 px-1 leading-relaxed">
              دیتابیس‌های مسیریابی ایران را به آخرین نسخه‌ی معتبر (Chocolate4U، به‌روزرسانی روزانه) می‌رساند تا سایت‌های داخلی و CDNها دقیق‌تر مستقیم شوند.
            </p>
            {geoMessage ? <p className="text-xs text-zinc-400 mt-2 px-1">{geoMessage}</p> : null}

            {/* Advanced DNS (opt-in, apply on reconnect) */}
            <div className="mt-4 pt-4 border-t border-zinc-700/50 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <div className="text-sm text-zinc-200">FakeDNS</div>
                  <div className="text-[11px] text-zinc-500 leading-relaxed">باز شدن سریع‌تر سایت‌ها (تصمیم روتینگ بدون انتظار DNS). آزمایشی — بعد از فعال‌سازی یک‌بار قطع/وصل کنید و اگر مشکلی بود خاموشش کنید.</div>
                </div>
                <button
                  onClick={toggleFakeDns}
                  className={`shrink-0 w-12 h-7 rounded-full transition-colors relative ${fakeDnsEnabled ? 'bg-cyan-500' : 'bg-zinc-700'}`}
                  aria-pressed={fakeDnsEnabled}
                >
                  <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${fakeDnsEnabled ? 'left-1' : 'right-1'}`} />
                </button>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <div className="text-sm text-zinc-200">DNS رمزنگاری‌شده (DoH)</div>
                  <div className="text-[11px] text-zinc-500 leading-relaxed">پرس‌وجوی DNS از طریق HTTPS تا دستکاری نشود. آزمایشی — اگر سرورتان با دامنه است و اتصال برقرار نشد، خاموش کنید.</div>
                </div>
                <button
                  onClick={toggleDoh}
                  className={`shrink-0 w-12 h-7 rounded-full transition-colors relative ${dohEnabled ? 'bg-cyan-500' : 'bg-zinc-700'}`}
                  aria-pressed={dohEnabled}
                >
                  <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${dohEnabled ? 'left-1' : 'right-1'}`} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Dynamic View Injection */}
      <main
        className="flex-1 min-h-0 w-full relative overflow-hidden flex flex-col"
        style={{ paddingBottom: currentView === 'dashboard' ? '0px' : '112px' }}
      >
        <div className={currentView === 'dashboard' ? 'block h-full overflow-hidden' : 'hidden'}>
          <Dashboard 
            configs={configs}
            measurementContext={measurementContext}
            activeConfig={activeConfig} 
            activeDns={activeDns}
            setConfigs={setConfigs}
            setActiveConfigId={setActiveConfigId}
            isVisible={currentView === 'dashboard'}
            globalOperation={globalOperation}
            setGlobalOperation={setGlobalOperation}
            isConnected={isConnected}
            setIsConnected={setIsConnected}
            isConnecting={isConnecting}
            setIsConnecting={setIsConnecting}
            uptime={uptime}
            setUptime={setUptime}
            fakeDnsEnabled={fakeDnsEnabled}
            dohEnabled={dohEnabled}
          />
        </div>
        <div className={currentView === 'profiles' ? 'block h-full overflow-y-auto' : 'hidden'}>
          <Profiles 
            measurementContext={measurementContext}
            fakeDnsEnabled={fakeDnsEnabled}
            dohEnabled={dohEnabled}
            configs={configs} 
            setConfigs={setConfigs} 
            activeConfigId={activeConfigId} 
            setActiveConfigId={setActiveConfigId}
            activeDns={activeDns}
            globalOperation={globalOperation}
            setGlobalOperation={setGlobalOperation}
          />
        </div>
        <div className={currentView === 'dns' ? 'block h-full overflow-y-auto' : 'hidden'}>
          <DNSTester 
            activeDns={activeDns}
            setActiveDns={setActiveDns}
            activeConfig={activeConfig}
            globalOperation={globalOperation}
            setGlobalOperation={setGlobalOperation}
          />
        </div>
      </main>

      <Navigation
        currentView={currentView}
        setView={setCurrentView}
      />
      
    </div>
  );
}
