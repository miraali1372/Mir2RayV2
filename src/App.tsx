import React, { useState, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import Xray from './plugins/xray';
import { ViewState, V2RayConfig, DnsServer } from './types';
import { getAppValue, getJsonValue, removeAppValue, setAppValue, setJsonValue } from './utils/appStorage';
import { Navigation } from './components/Navigation';
import { Dashboard } from './views/Dashboard';
import { Profiles } from './views/Profiles';
import { DNSTester } from './views/DNSTester';
import { compareVersions, fetchLatestRelease, formatVersion, pickApkAsset } from './utils/update';

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
  const [lastVpnState, setLastVpnState] = useState<boolean | null>(null);
  const [lastVpnUpdatedAt, setLastVpnUpdatedAt] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState('1.0.0');
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateMessage, setUpdateMessage] = useState('');
  const [hasUpdate, setHasUpdate] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    (async () => {
      try {
        const [savedConfigs, savedActiveConfigId, savedActiveDns, savedView, savedLastVpnState, savedLastVpnUpdatedAt] = await Promise.all([
          getJsonValue<V2RayConfig[]>('configs', []),
          getAppValue('active_config_id'),
          getJsonValue<DnsServer | null>('active_dns', null),
          getAppValue('current_view'),
          getAppValue('vpn_last_state'),
          getAppValue('vpn_last_updated_at'),
        ]);
        if (!cancelled) {
          setConfigs(savedConfigs);
          setActiveConfigId(savedActiveConfigId);
          setActiveDns(savedActiveDns);
          if (savedLastVpnState === '1' || savedLastVpnState === '0') {
            setLastVpnState(savedLastVpnState === '1');
          }
          setLastVpnUpdatedAt(savedLastVpnUpdatedAt);
          if (savedView && ['dashboard','profiles','dns'].includes(savedView)) {
            setCurrentView(savedView as ViewState);
          }
        }
      } catch (error) {
        console.warn('Could not restore application state:', error);
      } finally {
        if (!cancelled) setIsStorageHydrated(true);
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

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return;

    const refreshStatus = async () => {
      try {
        const status = await Xray.getStatus();
        setIsConnected(status.running);
        setLastVpnState(status.running);
        setLastVpnUpdatedAt(new Date().toISOString());
        setAppValue('vpn_last_state', status.running ? '1' : '0').catch(error => {
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
    return () => {
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

      if (installedVersion === 'web' || Capacitor.getPlatform() !== 'android') {
        setLatestVersion(null);
        setHasUpdate(false);
        setUpdateMessage('به‌روزرسانی خودکار فقط برای نسخه اندروید فعال است.');
        return;
      }

      const release = await fetchLatestRelease();
      const latest = formatVersion(release.tag_name);
      setLatestVersion(latest);

      const asset = pickApkAsset(release);
      if (!asset) {
        setUpdateMessage('فایل APK در ریلیس GitHub پیدا نشد.');
        return;
      }

      if (compareVersions(release.tag_name, installedVersion) <= 0) {
        setHasUpdate(false);
        setUpdateMessage('این آخرین ورژن هست.');
        return;
      }

      setHasUpdate(true);
      const note = (release.body || '')
        .split('\n')
        .map(line => line.trim())
        .find(line => line && !line.startsWith('#')) || `نسخه جدید ${latest} آماده دانلود است.`;
      setUpdateMessage(note);

      try {
        const downloaded = await Xray.downloadAndInstallApk({
          url: asset.browser_download_url,
          fileName: asset.name,
        });
        if (!downloaded.ok) {
          throw new Error(downloaded.message || 'Could not start APK download');
        }
        setUpdateMessage(`${note} دانلود و نصب آغاز شد.`);
      } catch (installError) {
        console.warn('Native APK download failed, falling back to browser:', installError);
        const opened = await Xray.openExternalUrl({ url: asset.browser_download_url });
        if (!opened.ok) {
          throw installError;
        }
        setUpdateMessage(`${note} لینک دانلود در مرورگر باز شد.`);
      }
    } catch (error) {
      console.warn('Update check failed:', error);
      setHasUpdate(false);
      setUpdateMessage('بررسی آپدیت ناموفق بود.');
    } finally {
      setUpdateChecking(false);
    }
  };

  const activeConfig = configs.find(c => c.id === activeConfigId) || null;

  return (
    <div className="mobile-app-container font-sans" dir="rtl">
      
      {/* Dynamic View Injection */}
      <main className="flex-1 w-full relative overflow-hidden flex flex-col" style={{ paddingBottom: '112px' }}>
        <div className={currentView === 'dashboard' ? 'block h-full overflow-y-auto' : 'hidden'}>
          <Dashboard 
            activeConfig={activeConfig} 
            activeDns={activeDns}
            setConfigs={setConfigs}
            setActiveDns={setActiveDns}
            isVisible={currentView === 'dashboard'}
            globalOperation={globalOperation}
            setGlobalOperation={setGlobalOperation}
            isConnected={isConnected}
            setIsConnected={setIsConnected}
            isConnecting={isConnecting}
            setIsConnecting={setIsConnecting}
            uptime={uptime}
            setUptime={setUptime}
            lastVpnState={lastVpnState}
            lastVpnUpdatedAt={lastVpnUpdatedAt}
            currentVersion={currentVersion === 'web' ? 'web' : formatVersion(currentVersion)}
            latestVersion={latestVersion}
            updateChecking={updateChecking}
            updateMessage={updateMessage}
            hasUpdate={hasUpdate}
            onCheckUpdate={handleCheckUpdate}
          />
        </div>
        <div className={currentView === 'profiles' ? 'block h-full overflow-y-auto' : 'hidden'}>
          <Profiles 
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
