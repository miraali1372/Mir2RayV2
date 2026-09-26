package com.mir2ray.app;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import org.json.JSONObject;
import org.json.JSONArray;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

@CapacitorPlugin(name = "Xray")
public class XrayPlugin extends Plugin {

    private static final String TAG = "XrayPlugin";

    // Use centralized timeout constants
    private static final int DELAY_TEST_THREADS = TimeoutConstants.computeDelayTestThreads();
    private static final int DELAY_TEST_QUEUE_SIZE = TimeoutConstants.DELAY_TEST_QUEUE_SIZE;
    private static final int NATIVE_DELAY_THREADS = TimeoutConstants.computeNativeDelayThreads();
    // Bandwidth tests each spin up a full Xray core. Keep this aligned with the three UI workers so
    // the queue stays fast without allowing unbounded contention.
    private static final int BANDWIDTH_THREADS = TimeoutConstants.computeBandwidthThreads();
    private static final java.util.concurrent.ExecutorService updateExecutor;
    private static final java.util.concurrent.ThreadPoolExecutor delayTestExecutor;
    private static final java.util.concurrent.ThreadPoolExecutor nativeDelayExecutor;
    private static final java.util.concurrent.ThreadPoolExecutor bandwidthExecutor;
    private static final java.util.concurrent.ScheduledExecutorService delayTimeoutScheduler;
    static {
        java.util.concurrent.atomic.AtomicInteger threadNo = new java.util.concurrent.atomic.AtomicInteger(1);
        java.util.concurrent.ThreadFactory tf = r -> {
            Thread t = new Thread(r, "Xray-DelayExecutor-" + threadNo.getAndIncrement());
            t.setUncaughtExceptionHandler((thr, ex) -> Log.e(TAG, "Uncaught in delay executor", ex));
            return t;
        };
        java.util.concurrent.atomic.AtomicInteger updateThreadNo = new java.util.concurrent.atomic.AtomicInteger(1);
        java.util.concurrent.ThreadFactory updateTf = r -> {
            Thread t = new Thread(r, "Xray-Update-" + updateThreadNo.getAndIncrement());
            t.setUncaughtExceptionHandler((thr, ex) -> Log.e(TAG, "Uncaught in update executor", ex));
            return t;
        };
        updateExecutor = java.util.concurrent.Executors.newSingleThreadExecutor(updateTf);

        delayTestExecutor = new java.util.concurrent.ThreadPoolExecutor(
                DELAY_TEST_THREADS,
                DELAY_TEST_THREADS,
                30L,
                java.util.concurrent.TimeUnit.SECONDS,
                new java.util.concurrent.LinkedBlockingQueue<Runnable>(DELAY_TEST_QUEUE_SIZE),
                tf,
                new java.util.concurrent.ThreadPoolExecutor.AbortPolicy()
        );
        delayTestExecutor.allowCoreThreadTimeOut(true);

        java.util.concurrent.atomic.AtomicInteger nativeThreadNo = new java.util.concurrent.atomic.AtomicInteger(1);
        java.util.concurrent.ThreadFactory nativeTf = r -> {
            Thread t = new Thread(r, "Xray-DelayNative-" + nativeThreadNo.getAndIncrement());
            t.setUncaughtExceptionHandler((thr, ex) -> Log.e(TAG, "Uncaught in native delay executor", ex));
            return t;
        };
        nativeDelayExecutor = new java.util.concurrent.ThreadPoolExecutor(
                NATIVE_DELAY_THREADS,
                NATIVE_DELAY_THREADS,
                30L,
                java.util.concurrent.TimeUnit.SECONDS,
                new java.util.concurrent.LinkedBlockingQueue<Runnable>(TimeoutConstants.NATIVE_DELAY_QUEUE_SIZE),
                nativeTf,
                new java.util.concurrent.ThreadPoolExecutor.AbortPolicy()
        );
        nativeDelayExecutor.allowCoreThreadTimeOut(true);

        java.util.concurrent.atomic.AtomicInteger bandwidthThreadNo = new java.util.concurrent.atomic.AtomicInteger(1);
        java.util.concurrent.ThreadFactory bandwidthTf = r -> {
            Thread t = new Thread(r, "Xray-Bandwidth-" + bandwidthThreadNo.getAndIncrement());
            t.setUncaughtExceptionHandler((thr, ex) -> Log.e(TAG, "Uncaught in bandwidth executor", ex));
            return t;
        };
        bandwidthExecutor = new java.util.concurrent.ThreadPoolExecutor(
                BANDWIDTH_THREADS,
                BANDWIDTH_THREADS,
                30L,
                java.util.concurrent.TimeUnit.SECONDS,
                new java.util.concurrent.LinkedBlockingQueue<Runnable>(DELAY_TEST_QUEUE_SIZE),
                bandwidthTf,
                new java.util.concurrent.ThreadPoolExecutor.AbortPolicy()
        );
        bandwidthExecutor.allowCoreThreadTimeOut(true);

        java.util.concurrent.atomic.AtomicInteger timeoutThreadNo = new java.util.concurrent.atomic.AtomicInteger(1);
        java.util.concurrent.ThreadFactory timeoutTf = r -> {
            Thread t = new Thread(r, "Xray-DelayTimeout-" + timeoutThreadNo.getAndIncrement());
            t.setUncaughtExceptionHandler((thr, ex) -> Log.e(TAG, "Uncaught in timeout scheduler", ex));
            return t;
        };
        delayTimeoutScheduler = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(timeoutTf);

    }

    /**
     * Gracefully shuts down all executor services to prevent memory leaks.
     * Should be called when the plugin is no longer needed (e.g., app termination).
     */
    public static void shutdownExecutors() {
        Log.i(TAG, "Shutting down XrayPlugin executors...");

        // Shutdown update executor
        if (updateExecutor != null && !updateExecutor.isShutdown()) {
            updateExecutor.shutdown();
            try {
                if (!updateExecutor.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS)) {
                    updateExecutor.shutdownNow();
                }
            } catch (InterruptedException e) {
                updateExecutor.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }

        // Shutdown delay test executor
        if (delayTestExecutor != null && !delayTestExecutor.isShutdown()) {
            delayTestExecutor.shutdown();
            try {
                if (!delayTestExecutor.awaitTermination(10, java.util.concurrent.TimeUnit.SECONDS)) {
                    delayTestExecutor.shutdownNow();
                }
            } catch (InterruptedException e) {
                delayTestExecutor.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }

        // Shutdown native delay executor
        if (nativeDelayExecutor != null && !nativeDelayExecutor.isShutdown()) {
            nativeDelayExecutor.shutdown();
            try {
                if (!nativeDelayExecutor.awaitTermination(10, java.util.concurrent.TimeUnit.SECONDS)) {
                    nativeDelayExecutor.shutdownNow();
                }
            } catch (InterruptedException e) {
                nativeDelayExecutor.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }

        // Shutdown bandwidth executor
        if (bandwidthExecutor != null && !bandwidthExecutor.isShutdown()) {
            bandwidthExecutor.shutdown();
            try {
                if (!bandwidthExecutor.awaitTermination(10, java.util.concurrent.TimeUnit.SECONDS)) {
                    bandwidthExecutor.shutdownNow();
                }
            } catch (InterruptedException e) {
                bandwidthExecutor.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }

        // Shutdown delay timeout scheduler
        if (delayTimeoutScheduler != null && !delayTimeoutScheduler.isShutdown()) {
            delayTimeoutScheduler.shutdown();
            try {
                if (!delayTimeoutScheduler.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS)) {
                    delayTimeoutScheduler.shutdownNow();
                }
            } catch (InterruptedException e) {
                delayTimeoutScheduler.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }

        Log.i(TAG, "XrayPlugin executors shut down complete");
    }

    // Routing-database mirrors (Chocolate4U/Iran-v2ray-rules). jsDelivr first since
    // raw.githubusercontent.com is usually blocked inside Iran.
    private static final String[] GEOIP_MIRRORS = {
            "https://cdn.jsdelivr.net/gh/chocolate4u/Iran-v2ray-rules@release/geoip.dat",
            "https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/geoip.dat",
            "https://ghproxy.net/https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/geoip.dat"
    };
    private static final String[] GEOSITE_MIRRORS = {
            "https://cdn.jsdelivr.net/gh/chocolate4u/Iran-v2ray-rules@release/geosite.dat",
            "https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/geosite.dat",
            "https://ghproxy.net/https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/geosite.dat"
    };
    private static final long MIN_GEO_BYTES = 100_000;
    private static final long MAX_APK_BYTES = 250L * 1024L * 1024L;
    private static final long START_WAIT_TIMEOUT_MS = TimeoutConstants.VPN_START_WAIT_TIMEOUT_MS;
    private static final long START_WAIT_INTERVAL_MS = TimeoutConstants.VPN_START_WAIT_INTERVAL_MS;

    @PluginMethod
    public void startVpn(PluginCall call) {
        try {
            JSONObject payload = parsePayload(call.getString("config"));
            String shareUri = firstShareUri(payload, call.getString("config", ""));

            if (shareUri.isEmpty()) {
                call.reject("Share link is required");
                return;
            }

            Intent prepareIntent = android.net.VpnService.prepare(getContext());
            if (prepareIntent != null) {
                startActivityForResult(call, prepareIntent, "vpnPermissionResult");
            } else {
                startVpnService(call);
            }
        } catch (Exception e) {
            Log.e(TAG, "startVpn failed", e);
            call.reject("Failed to start VPN: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void vpnPermissionResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (result.getResultCode() == Activity.RESULT_OK) {
            startVpnService(call);
        } else {
            JSObject ret = new JSObject();
            ret.put("status", "error");
            ret.put("message", "VPN permission denied by user");
            call.resolve(ret);
        }
    }

    private void startVpnService(PluginCall call) {
        try {
            XrayCoreManager.init(getContext());

            String rawPayload = call.getString("config", "");
            JSONObject payload = parsePayload(rawPayload);
            String shareUri = firstShareUri(payload, rawPayload);
            if (shareUri.isEmpty()) {
                call.reject("Share link is required");
                return;
            }
            long startId = System.nanoTime();
            Intent serviceIntent = new Intent(getContext(), Mir2RayVpnService.class);
            serviceIntent.putExtra(Mir2RayVpnService.EXTRA_PAYLOAD_JSON, rawPayload);
            Mir2RayVpnService.applyPayloadExtras(serviceIntent, rawPayload);
            serviceIntent.putExtra(Mir2RayVpnService.EXTRA_SHARE_URI, shareUri);
            serviceIntent.putExtra(Mir2RayVpnService.EXTRA_START_ID, startId);

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                getContext().startForegroundService(serviceIntent);
            } else {
                getContext().startService(serviceIntent);
            }

            try {
                SecureStorage ss = new SecureStorage(getContext());
                if (rawPayload != null && !rawPayload.isEmpty()) {
                    ss.putString("mir2ray_last_vpn_payload", rawPayload);
                }
                if (!shareUri.isEmpty()) {
                    ss.putString("mir2ray_last_share_uri", shareUri);
                }
            } catch (Exception e) {
                Log.w(TAG, "Could not persist last VPN payload", e);
            }

            waitForServiceStart(call, startId);
        } catch (Exception e) {
            Log.e(TAG, "Failed to start VPN service", e);
            call.reject("Failed to start VPN: " + e.getMessage());
        }
    }

    private void waitForServiceStart(PluginCall call, long startId) {
        new Thread(() -> {
            long deadline = System.currentTimeMillis() + START_WAIT_TIMEOUT_MS;
            Mir2RayVpnService.StartState state = null;
            while (System.currentTimeMillis() < deadline) {
                state = Mir2RayVpnService.getStartState(startId);
                if (state.matches && state.running && !state.starting) {
                    JSObject ret = new JSObject();
                    ret.put("status", "connected");
                    ret.put("version", XrayCoreManager.getVersion());
                    ret.put("confirmed", true);
                    ret.put("connectedAtMs", state.connectedAtMs);
                    call.resolve(ret);
                    return;
                }
                if (state.matches && state.error != null && !state.error.isEmpty()) {
                    JSObject ret = new JSObject();
                    ret.put("status", "error");
                    ret.put("version", XrayCoreManager.getVersion());
                    ret.put("confirmed", false);
                    ret.put("message", state.error);
                    call.resolve(ret);
                    return;
                }
                try {
                    Thread.sleep(START_WAIT_INTERVAL_MS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }

            JSObject ret = new JSObject();
            ret.put("status", "error");
            ret.put("version", XrayCoreManager.getVersion());
            ret.put("confirmed", false);
            String error = state != null ? state.error : null;
            ret.put("message", error != null && !error.isEmpty()
                    ? error
                    : (state != null && !state.matches
                        ? "VPN start was superseded by another request"
                        : "Timed out waiting for VPN core to start"));
            call.resolve(ret);
        }, "Xray-StartWait").start();
    }

    @PluginMethod
    public void stopVpn(PluginCall call) {
        try {
            Intent serviceIntent = new Intent(getContext(), Mir2RayVpnService.class);
            serviceIntent.setAction(Mir2RayVpnService.ACTION_STOP);
            getContext().startService(serviceIntent);
        } catch (Exception e) {
            call.reject("Failed to request VPN stop: " + e.getMessage());
            return;
        }

        new Thread(() -> {
            long deadline = System.currentTimeMillis() + 8_000L;
            while (System.currentTimeMillis() < deadline) {
                if (!XrayCoreManager.isRunning() && !Mir2RayVpnService.isStarting()) {
                    JSObject ret = new JSObject();
                    ret.put("status", "disconnected");
                    call.resolve(ret);
                    return;
                }
                try {
                    Thread.sleep(100L);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            call.reject("Timed out waiting for VPN to stop");
        }, "Xray-StopWait").start();
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        // Keep Connect non-blocking. On Android 13+ the VPN foreground service can run even if
        // notification permission is denied; waiting on the notification dialog here can leave
        // some OEM/release builds stuck in "connecting". The UI can still read the grant state.
        resolveNotificationPermission(call);
    }

    private void resolveNotificationPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU
                || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED);
        call.resolve(ret);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = new JSObject();
        boolean running = XrayCoreManager.isRunning();
        ret.put("running", running);
        ret.put("validated", running);
        ret.put("starting", Mir2RayVpnService.isStarting());
        ret.put("desired", Mir2RayVpnService.isDesired());
        ret.put("activeConfigId", Mir2RayVpnService.getActiveConfigId());
        ret.put("lastError", Mir2RayVpnService.getLastStartError());
        ret.put("version", XrayCoreManager.getVersion());
        call.resolve(ret);
    }

    @PluginMethod
    public void getNetworkContext(PluginCall call) {
        JSObject ret = new JSObject();
        String key = VpnHealth.networkKey(getContext());
        ret.put("key", key);
        ret.put("connected", !"offline".equals(key));
        call.resolve(ret);
    }

    @PluginMethod
    public void checkVpnHealth(PluginCall call) {
        new Thread(() -> {
            boolean ok = VpnHealth.check(getContext(), Math.max(1000, Math.min(6000, call.getInt("timeoutMs", 4000))));
            JSObject ret = new JSObject();
            ret.put("ok", ok);
            ret.put("latency", VpnHealth.latency());
            ret.put("checkedAt", System.currentTimeMillis());
            call.resolve(ret);
        }, "Mir2Ray-HealthCheck").start();
    }

    private boolean isVpnNetworkValidated() {
        android.net.ConnectivityManager manager = (android.net.ConnectivityManager)
                getContext().getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
        if (manager == null) return false;
        try {
            for (android.net.Network network : manager.getAllNetworks()) {
                android.net.NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
                if (capabilities != null
                        && capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)
                        && capabilities.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        && capabilities.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                    return true;
                }
            }
        } catch (SecurityException e) {
            Log.w(TAG, "Unable to inspect VPN network validation", e);
        }
        return false;
    }

    @PluginMethod
    public void getAppVersionInfo(PluginCall call) {
        try {
            android.content.pm.PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject ret = new JSObject();
            ret.put("versionName", info.versionName != null ? info.versionName : "");
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                ret.put("versionCode", (int) info.getLongVersionCode());
            } else {
                ret.put("versionCode", info.versionCode);
            }
            call.resolve(ret);
        } catch (android.content.pm.PackageManager.NameNotFoundException e) {
            call.reject("Unable to read app version: " + e.getMessage());
        }
    }

    @PluginMethod
    public void resolveLatestRelease(PluginCall call) {
        String owner = call.getString("owner", "miraali1372");
        String repo = call.getString("repo", "Mir2RayV2");
        String installedVersion = call.getString("installedVersion", "");
        if (!isSafeGitHubSegment(owner) || !isSafeGitHubSegment(repo)) {
            call.reject("Invalid GitHub owner or repository name");
            return;
        }

        final PluginCall pcall = call;
        final String releaseOwner = owner.trim();
        final String releaseRepo = repo.trim();
        final String currentVersion = installedVersion == null ? "" : installedVersion.trim();

        updateExecutor.execute(() -> {
            try {
                String tagName = resolveLatestReleaseTag(releaseOwner, releaseRepo);
                java.util.List<String> assetCandidates = buildReleaseAssetCandidates(tagName, currentVersion);
                String assetName = null;
                String downloadUrl = null;
                for (String candidate : assetCandidates) {
                    String candidateUrl = buildReleaseDownloadUrl(releaseOwner, releaseRepo, tagName, candidate);
                    if (releaseAssetExists(candidateUrl)) {
                        assetName = candidate;
                        downloadUrl = candidateUrl;
                        break;
                    }
                }

                if (assetName == null || downloadUrl == null) {
                    JSObject ret = new JSObject();
                    ret.put("ok", false);
                    ret.put("tagName", tagName);
                    ret.put("htmlUrl", "https://github.com/" + releaseOwner + "/" + releaseRepo + "/releases/tag/" + tagName);
                    ret.put("assetName", "");
                    ret.put("downloadUrl", "");
                    ret.put("message", "No APK asset matched the latest release");
                    pcall.resolve(ret);
                    return;
                }

                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("tagName", tagName);
                ret.put("htmlUrl", "https://github.com/" + releaseOwner + "/" + releaseRepo + "/releases/tag/" + tagName);
                ret.put("assetName", assetName);
                ret.put("downloadUrl", downloadUrl);
                pcall.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "resolveLatestRelease failed", e);
                JSObject ret = new JSObject();
                ret.put("ok", false);
                ret.put("tagName", "");
                ret.put("htmlUrl", "");
                ret.put("assetName", "");
                ret.put("downloadUrl", "");
                ret.put("message", e.getMessage());
                pcall.resolve(ret);
            }
        });
    }

    @PluginMethod
    public void setSecure(PluginCall call) {
        String key = call.getString("key", "");
        String value = call.getString("value", "");
        try {
            SecureStorage ss = new SecureStorage(getContext());
            ss.putString(key, value);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("setSecure failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getSecure(PluginCall call) {
        String key = call.getString("key", "");
        try {
            SecureStorage ss = new SecureStorage(getContext());
            String val = ss.getString(key);
            JSObject ret = new JSObject();
            ret.put("value", val);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("getSecure failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void removeSecure(PluginCall call) {
        String key = call.getString("key", "");
        try {
            SecureStorage ss = new SecureStorage(getContext());
            ss.remove(key);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("removeSecure failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void appendLog(PluginCall call) {
        String line = call.getString("line", "");
        try {
            LogCollector.append(getContext(), line);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("appendLog failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void readLogs(PluginCall call) {
        try {
            String data = LogCollector.readAll(getContext());
            JSObject ret = new JSObject();
            ret.put("logs", data);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("readLogs failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void clearLogs(PluginCall call) {
        try {
            LogCollector.clear(getContext());
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("clearLogs failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void setAutoStart(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        try {
            SecureStorage ss = new SecureStorage(getContext());
            ss.putString("mir2ray_auto_start", enabled ? "1" : "0");
            // persist last shareUri if provided
            String last = call.getString("lastShareUri", null);
            if (last != null) ss.putString("mir2ray_last_share_uri", last);
            String lastPayload = call.getString("lastPayload", null);
            if (lastPayload != null) ss.putString("mir2ray_last_vpn_payload", lastPayload);
            if (enabled) scheduleVpnMonitor(); else cancelVpnMonitor();
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("setAutoStart failed: " + e.getMessage());
        }
    }

    private void scheduleVpnMonitor() {
        try {
            androidx.work.Constraints constraints = new androidx.work.Constraints.Builder()
                    .setRequiredNetworkType(androidx.work.NetworkType.CONNECTED)
                    .setRequiresBatteryNotLow(true)
                    .build();

            androidx.work.PeriodicWorkRequest req = new androidx.work.PeriodicWorkRequest.Builder(
                    VpnMonitorWorker.class, 15, java.util.concurrent.TimeUnit.MINUTES)
                    .setConstraints(constraints)
                    .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL, 5, java.util.concurrent.TimeUnit.MINUTES)
                    .build();
            androidx.work.WorkManager.getInstance(getContext()).enqueueUniquePeriodicWork(
                    "mir2ray_vpn_monitor", androidx.work.ExistingPeriodicWorkPolicy.REPLACE, req);
            Log.i(TAG, "VPN monitor scheduled with network and battery constraints");
        } catch (Exception e) {
            Log.w(TAG, "scheduleVpnMonitor failed", e);
        }
    }

    private void cancelVpnMonitor() {
        try {
            androidx.work.WorkManager.getInstance(getContext()).cancelUniqueWork("mir2ray_vpn_monitor");
        } catch (Exception e) {
            Log.w(TAG, "cancelVpnMonitor failed", e);
        }
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        try {
            android.content.Context ctx = getContext();
            android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            intent.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("requestIgnoreBatteryOptimizations failed: " + e.getMessage());
        }
    }

    /** Open the system VPN settings so the user can enable Always-on VPN + "Block connections
     *  without VPN" (the only real kill-switch / leak protection available to a 3rd-party VPN). */
    @PluginMethod
    public void openVpnSettings(PluginCall call) {
        try {
            Intent intent = new Intent("android.settings.VPN_SETTINGS");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(android.provider.Settings.ACTION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception ex) {
                call.reject("openVpnSettings failed: " + ex.getMessage());
            }
        }
    }

    @PluginMethod
    public void readClipboardText(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            CharSequence text = "";
            if (clipboard != null && clipboard.hasPrimaryClip()) {
                ClipData clip = clipboard.getPrimaryClip();
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence coerced = clip.getItemAt(0).coerceToText(getContext());
                    if (coerced != null) {
                        text = coerced;
                    }
                }
            }
            ret.put("text", text.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not read clipboard", e);
        }
    }

    @PluginMethod
    public void openExternalUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || url.isEmpty()) {
            call.reject("URL is required");
            return;
        }

        try {
            android.net.Uri parsed = android.net.Uri.parse(url);
            String scheme = parsed.getScheme();
            if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)) {
                call.reject("Only HTTP(S) URLs can be opened");
                return;
            }
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW, parsed);
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);

            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (android.content.ActivityNotFoundException e) {
            call.reject("No app available to open URL");
        } catch (Exception e) {
            call.reject("openExternalUrl failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void downloadAndInstallApk(PluginCall call) {
        String url = call.getString("url", "");
        String fileName = call.getString("fileName", "Mir2rayV2.apk");
        if (url == null || url.isEmpty()) {
            call.reject("URL is required");
            return;
        }
        fileName = sanitizeApkFileName(fileName);

        final String downloadUrl = url.trim();
        final String safeFileName = fileName;
        final PluginCall pcall = call;

        updateExecutor.execute(() -> {
            File outDir = new File(getContext().getCacheDir(), "updates");
            if (!outDir.exists() && !outDir.mkdirs() && !outDir.exists()) {
                pcall.reject("Unable to prepare download directory");
                return;
            }

            File outFile = new File(outDir, safeFileName);
            HttpURLConnection connection = null;
            try {
                URL requestUrl = new URL(downloadUrl);
                if (!isTrustedUpdateUrl(requestUrl)) {
                    throw new SecurityException("APK updates must use a trusted GitHub HTTPS URL");
                }
                connection = (HttpURLConnection) requestUrl.openConnection();
                connection.setInstanceFollowRedirects(true);
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(45000);
                connection.setRequestProperty("User-Agent", "Mir2rayV2-Updater");
                connection.setRequestProperty("Accept", "*/*");
                connection.connect();

                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    throw new java.io.IOException("Download failed with HTTP " + status);
                }
                if (!isTrustedUpdateUrl(connection.getURL())) {
                    throw new SecurityException("APK download redirected to an untrusted host");
                }
                long declaredLength = connection.getContentLengthLong();
                if (declaredLength > MAX_APK_BYTES) {
                    throw new java.io.IOException("APK is larger than the allowed download limit");
                }

                try (InputStream in = connection.getInputStream();
                     OutputStream out = new FileOutputStream(outFile, false)) {
                    byte[] buffer = new byte[16 * 1024];
                    int read;
                    long written = 0L;
                    while ((read = in.read(buffer)) != -1) {
                        written += read;
                        if (written > MAX_APK_BYTES) {
                            throw new java.io.IOException("APK exceeded the allowed download limit");
                        }
                        out.write(buffer, 0, read);
                    }
                    out.flush();
                }
                verifyDownloadedApk(outFile);

                Uri apkUri = FileProvider.getUriForFile(
                        getContext(),
                        getContext().getPackageName() + ".fileprovider",
                        outFile
                );
                Intent installIntent = new Intent(Intent.ACTION_VIEW);
                installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                installIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);

                android.app.Activity act = getActivity();
                if (act != null) {
                    act.runOnUiThread(() -> {
                        try {
                            getContext().startActivity(installIntent);
                            JSObject ret = new JSObject();
                            ret.put("ok", true);
                            ret.put("path", outFile.getAbsolutePath());
                            pcall.resolve(ret);
                        } catch (Exception e) {
                            pcall.reject("Failed to start installer: " + e.getMessage());
                        }
                    });
                } else {
                    getContext().startActivity(installIntent);
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("path", outFile.getAbsolutePath());
                    pcall.resolve(ret);
                }
            } catch (Exception e) {
                if (outFile.exists() && !outFile.delete()) {
                    Log.w(TAG, "Could not delete rejected APK: " + outFile.getName());
                }
                Log.e(TAG, "downloadAndInstallApk failed", e);
                pcall.reject("Failed to download APK: " + e.getMessage());
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        });
    }

    /** Real TCP connect latency to host:port (for DNS / CDN / server list). */
    @PluginMethod
    public void pingHost(PluginCall call) {
        final String host = call.getString("host", "");
        final int port = call.getInt("port", 443);
        final int timeout = Math.max(500, Math.min(call.getInt("timeout", 2000), 10_000));
        final PluginCall pcall = call;
        final java.util.concurrent.atomic.AtomicBoolean resolved = new java.util.concurrent.atomic.AtomicBoolean(false);

        final java.util.concurrent.ScheduledFuture<?> timeoutHandle = delayTimeoutScheduler.schedule(
                () -> resolvePingHost(pcall, -1, null, resolved),
                timeout + 500L,
                java.util.concurrent.TimeUnit.MILLISECONDS
        );

        try {
            delayTestExecutor.execute(() -> {
                long ms = -1;
                String ip = null;
                try {
                    TcpPingHelper.Result res = TcpPingHelper.ping(host, port, timeout);
                    ms = res.latency;
                    ip = res.ip;
                } catch (Throwable e) {
                    Log.d(TAG, "pingHost failed", e);
                } finally {
                    timeoutHandle.cancel(false);
                    resolvePingHost(pcall, ms, ip, resolved);
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            timeoutHandle.cancel(false);
            resolvePingHost(pcall, -1, null, resolved);
        } catch (Throwable e) {
            timeoutHandle.cancel(false);
            Log.w(TAG, "pingHost queue failed", e);
            resolvePingHost(pcall, -1, null, resolved);
        }
    }

    private void resolvePingHost(PluginCall call, long ms, String ip, java.util.concurrent.atomic.AtomicBoolean resolved) {
        if (!resolved.compareAndSet(false, true)) return;

        JSObject ret = new JSObject();
        ret.put("latency", ms);
        ret.put("ok", ms >= 0);
        if (ip != null && !ip.isEmpty()) {
            ret.put("ip", ip);
        }

        Runnable complete = () -> {
            try {
                call.resolve(ret);
            } catch (Exception e) {
                Log.w(TAG, "pingHost resolve failed", e);
            }
        };

        android.app.Activity act = getActivity();
        if (act != null) {
            act.runOnUiThread(complete);
        } else {
            complete.run();
        }
    }

    /** Direct UDP DNS resolve test against a selected DNS server; does not require a V2Ray config. */
    @PluginMethod
    public void testDnsResolve(PluginCall call) {
        String dnsIp = call.getString("dnsIp", "");
        String domain = call.getString("domain", "cp.cloudflare.com");
        int timeoutMs = call.getInt("timeoutMs", 2500);
        final PluginCall pcall = call;

        try {
            delayTestExecutor.execute(() -> {
                DnsResolveTestHelper.Result result = DnsResolveTestHelper.test(dnsIp, domain, timeoutMs);
                JSObject ret = new JSObject();
                ret.put("latency", result.latency);
                ret.put("ok", result.ok);
                if (result.message != null) {
                    ret.put("message", result.message);
                }

                android.app.Activity act = getActivity();
                if (act != null) {
                    act.runOnUiThread(() -> pcall.resolve(ret));
                } else {
                    pcall.resolve(ret);
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            pcall.reject("Too many pending DNS tests in queue, please wait and try again");
        } catch (Exception e) {
            pcall.reject("Failed to queue DNS test: " + e.getMessage());
        }
    }

    /** Download a fixed test file after resolving the host through the selected DNS server. */
    @PluginMethod
    public void measureDnsDownload(PluginCall call) {
        String dnsIp = call.getString("dnsIp", "");
        String url = call.getString("url", TimeoutConstants.DNS_DOWNLOAD_TEST_URL);
        int timeoutMs = call.getInt("timeoutMs", TimeoutConstants.DOWNLOAD_TEST_TIMEOUT_MS);
        int maxBytes = call.getInt("maxBytes", TimeoutConstants.DOWNLOAD_TEST_BYTES);
        final PluginCall pcall = call;

        try {
            delayTestExecutor.execute(() -> {
                DnsDownloadTestHelper.Result result = DnsDownloadTestHelper.measure(dnsIp, url, timeoutMs, maxBytes);
                JSObject ret = new JSObject();
                ret.put("downloadBps", result.downloadBps);
                ret.put("downloadMs", result.downloadMs);
                ret.put("resolveMs", result.resolveMs);
                ret.put("resolvedIp", result.resolvedIp);
                ret.put("ok", result.ok);
                if (result.message != null) {
                    ret.put("message", result.message);
                }

                android.app.Activity act = getActivity();
                if (act != null) {
                    act.runOnUiThread(() -> pcall.resolve(ret));
                } else {
                    pcall.resolve(ret);
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            pcall.reject("Too many pending DNS download tests in queue, please wait and try again");
        } catch (Exception e) {
            pcall.reject("Failed to queue DNS download test: " + e.getMessage());
        }
    }

    /** Measure download and upload after resolving both targets through the selected DNS server. */
    @PluginMethod
    public void measureDnsBandwidth(PluginCall call) {
        String dnsIp = call.getString("dnsIp", "");
        String downloadUrl = call.getString("downloadUrl", TimeoutConstants.DNS_DOWNLOAD_TEST_URL);
        String uploadUrl = call.getString("uploadUrl", TimeoutConstants.UPLOAD_TEST_URL);
        int timeoutMs = call.getInt("timeoutMs", TimeoutConstants.DOWNLOAD_TEST_TIMEOUT_MS);
        int legacyBytes = call.getInt("bytes", -1);
        int downloadBytes = call.getInt(
                "downloadBytes",
                legacyBytes > 0 ? legacyBytes : TimeoutConstants.DOWNLOAD_TEST_BYTES
        );
        int uploadBytes = call.getInt(
                "uploadBytes",
                legacyBytes > 0 ? legacyBytes : TimeoutConstants.UPLOAD_TEST_BYTES
        );
        final PluginCall pcall = call;

        try {
            delayTestExecutor.execute(() -> {
                DnsDownloadTestHelper.BandwidthResult result = DnsDownloadTestHelper.measureBandwidth(
                        dnsIp,
                        downloadUrl,
                        uploadUrl,
                        timeoutMs,
                        downloadBytes,
                        uploadBytes
                );
                JSObject ret = new JSObject();
                ret.put("downloadBps", result.downloadBps);
                ret.put("uploadBps", result.uploadBps);
                ret.put("downloadMs", result.downloadMs);
                ret.put("uploadMs", result.uploadMs);
                ret.put("resolveMs", result.resolveMs);
                ret.put("resolvedIp", result.resolvedIp);
                ret.put("ok", result.ok);
                if (result.message != null) {
                    ret.put("message", result.message);
                }

                android.app.Activity act = getActivity();
                if (act != null) {
                    act.runOnUiThread(() -> pcall.resolve(ret));
                } else {
                    pcall.resolve(ret);
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            pcall.reject("Too many pending DNS bandwidth tests in queue, please wait and try again");
        } catch (Exception e) {
            pcall.reject("Failed to queue DNS bandwidth test: " + e.getMessage());
        }
    }

    /** Current public IP as seen directly or through the active VPN tunnel. */
    @PluginMethod
    public void getCurrentPublicIp(PluginCall call) {
        int timeoutMs = call.getInt("timeoutMs", 7000);
        final PluginCall pcall = call;

        try {
            delayTestExecutor.execute(() -> {
                PublicIpHelper.Result result = PublicIpHelper.fetch(getContext(), timeoutMs);
                JSObject ret = new JSObject();
                ret.put("ip", result.ip);
                ret.put("ok", result.ok);
                ret.put("source", result.source);
                if (result.message != null) {
                    ret.put("message", result.message);
                }

                android.app.Activity act = getActivity();
                if (act != null) {
                    act.runOnUiThread(() -> pcall.resolve(ret));
                } else {
                    pcall.resolve(ret);
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            pcall.reject("Too many pending IP checks in queue, please wait and try again");
        } catch (Exception e) {
            pcall.reject("Failed to queue public IP check: " + e.getMessage());
        }
    }

    /** Real Xray outbound delay for a share link (same method as v2rayNG speed test). */
    @PluginMethod
    public void measureConfigDelay(PluginCall call) {
        String shareUri = call.getString("shareUri", "");
        String dnsIp = call.getString("dnsIp", null);
        String cleanIp = call.getString("cleanIp", null);
        boolean strictDns = call.getBoolean("strictDns", false);
        String testUrl = call.getString("testUrl", TimeoutConstants.DELAY_TEST_URL);
        String preferredTestUrl = call.getString("preferredTestUrl", "");
        JSArray testUrls = call.getArray("testUrls");
        int timeoutMs = Math.max(
                TimeoutConstants.CONFIG_DELAY_TEST_MIN_TIMEOUT_MS,
                Math.min(
                        call.getInt("timeoutMs", TimeoutConstants.CONFIG_DELAY_TEST_TIMEOUT_MS),
                        30_000
                )
        );
        int maxLatencyMs = call.getInt("maxLatencyMs", -1);

        final PluginCall pcall = call;

        try {
            delayTestExecutor.execute(() -> {
                try {
                    JSONObject payload = new JSONObject();
                    payload.put("shareUri", shareUri);
                    if (dnsIp != null && !dnsIp.trim().isEmpty()) payload.put("dnsIp", dnsIp);
                    if (cleanIp != null && !cleanIp.trim().isEmpty()) payload.put("cleanIp", cleanIp);
                    payload.put("strictDns", strictDns);
                    JSObject fragment = call.getObject("fragment");
                    if (fragment != null) payload.put("fragment", fragment);
                    payload.put("fakeDns", call.getBoolean("fakeDns", false));
                    payload.put("doh", call.getBoolean("doh", false));
                    payload.put("delayOnly", true);
                    payload.put("downloadUrl", testUrl);
                    if (testUrls != null && testUrls.length() > 0) {
                        payload.put("delayUrls", testUrls);
                    }
                    if (preferredTestUrl != null && !preferredTestUrl.trim().isEmpty()) {
                        payload.put("preferredDelayUrl", preferredTestUrl.trim());
                    }
                    payload.put("timeoutMs", timeoutMs);

                    java.util.concurrent.CompletableFuture<BandwidthTestHelper.BandwidthResult> future =
                            java.util.concurrent.CompletableFuture.supplyAsync(
                            () -> {
                                try {
                                    return BandwidthTestHelper.measure(getContext(), payload);
                                } catch (Throwable e) {
                                    Log.d(TAG, "Real-delay sample failed", e);
                                    return null;
                                }
                            },
                            nativeDelayExecutor
                    );
                    java.util.concurrent.ScheduledFuture<?> timeoutHandle = delayTimeoutScheduler.schedule(
                            () -> future.cancel(true),
                            timeoutMs + 1_500L,
                            java.util.concurrent.TimeUnit.MILLISECONDS
                    );

                    future.whenComplete((result, throwable) -> {
                        timeoutHandle.cancel(false);
                        long latency = -1;
                        long worstLatency = -1;
                        boolean ok = false;
                        if (throwable == null && result != null) {
                            latency = result.downloadMs;
                            worstLatency = result.worstDelayMs;
                            ok = result.ok
                                    && latency >= 0
                                    && worstLatency >= 0
                                    && (maxLatencyMs <= 0 || worstLatency <= maxLatencyMs);
                        } else if (throwable != null
                                && !(throwable instanceof java.util.concurrent.CancellationException)) {
                            Log.e(TAG, "measureConfigDelay failed", throwable);
                        }

                        JSObject ret = new JSObject();
                        ret.put("latency", latency);
                        ret.put("worstLatency", worstLatency);
                        ret.put("coldLatency", result != null ? result.coldDelayMs : -1);
                        ret.put("jitter", result != null ? result.jitterMs : -1);
                        ret.put("ok", ok);
                        if (result != null && result.exitIp != null && !result.exitIp.isEmpty()) {
                            ret.put("exitIp", result.exitIp);
                        }
                        if (result != null && result.exitCountry != null && !result.exitCountry.isEmpty()) {
                            ret.put("exitCountry", result.exitCountry);
                        }
                        android.app.Activity act = getActivity();
                        if (act != null) {
                            act.runOnUiThread(() -> pcall.resolve(ret));
                        } else {
                            pcall.resolve(ret);
                        }
                    });
                } catch (Throwable e) {
                    Log.e(TAG, "measureConfigDelay failed", e);
                    JSObject ret = new JSObject();
                    ret.put("latency", -1);
                    ret.put("worstLatency", -1);
                    ret.put("ok", false);
                    android.app.Activity act = getActivity();
                    if (act != null) {
                        act.runOnUiThread(() -> pcall.resolve(ret));
                    } else {
                        pcall.resolve(ret);
                    }
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            JSObject ret = new JSObject();
            ret.put("latency", -1);
            ret.put("worstLatency", -1);
            ret.put("ok", false);
            pcall.reject("Too many pending tests in queue, please wait and try again");
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("latency", -1);
            ret.put("worstLatency", -1);
            ret.put("ok", false);
            pcall.reject("Failed to queue measure test: " + e.getMessage());
        }
    }

    @PluginMethod
    public void measureConfigBandwidth(PluginCall call) {
        final PluginCall pcall = call;
        try {
            JSONObject payload = parsePayload(call.getString("config"));
            bandwidthExecutor.execute(() -> {
                try {
                    BandwidthTestHelper.BandwidthResult result = BandwidthTestHelper.measure(getContext(), payload);
                    JSObject ret = new JSObject();
                    ret.put("downloadBps", result.downloadBps);
                    ret.put("uploadBps", result.uploadBps);
                    ret.put("downloadBytes", result.downloadBytes);
                    ret.put("downloadMs", result.downloadMs);
                    ret.put("uploadMs", result.uploadMs);
                    ret.put("ok", result.ok);
                    if (result.message != null) {
                        ret.put("message", result.message);
                    }
                    android.app.Activity act = getActivity();
                    if (act != null) {
                        act.runOnUiThread(() -> pcall.resolve(ret));
                    } else {
                        pcall.resolve(ret);
                    }
                } catch (Throwable e) {
                    Log.e(TAG, "measureConfigBandwidth failed", e);
                    pcall.reject("Failed to measure bandwidth: " + e.getMessage());
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            pcall.reject("Too many pending tests in queue, please wait and try again");
        } catch (Exception e) {
            pcall.reject("Failed to queue bandwidth test: " + e.getMessage());
        }
    }

    @PluginMethod
    public void cancelConfigTests(PluginCall call) {
        BandwidthTestHelper.cancelAll();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void measureConfigDownload(PluginCall call) {
        final PluginCall pcall = call;
        try {
            JSONObject payload = parsePayload(call.getString("config"));
            bandwidthExecutor.execute(() -> {
                try {
                    BandwidthTestHelper.BandwidthResult result = BandwidthTestHelper.measure(getContext(), payload, true);
                    JSObject ret = new JSObject();
                    ret.put("downloadBps", result.downloadBps);
                    ret.put("downloadBytes", result.downloadBytes);
                    ret.put("downloadMs", result.downloadMs);
                    ret.put("ok", result.ok);
                    if (result.message != null) {
                        ret.put("message", result.message);
                    }
                    android.app.Activity act = getActivity();
                    if (act != null) {
                        act.runOnUiThread(() -> pcall.resolve(ret));
                    } else {
                        pcall.resolve(ret);
                    }
                } catch (Throwable e) {
                    Log.e(TAG, "measureConfigDownload failed", e);
                    pcall.reject("Failed to measure download: " + e.getMessage());
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            pcall.reject("Too many pending tests in queue, please wait and try again");
        } catch (Exception e) {
            pcall.reject("Failed to queue download test: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getTrafficStats(PluginCall call) {
        JSObject ret = new JSObject();
        long up = 0;
        long down = 0;
        for (String tag : new String[] {"proxy", "proxy-2", "proxy-3", "proxy-4", "proxy-5"}) {
            up += XrayCoreManager.queryStats(tag, "uplink");
            down += XrayCoreManager.queryStats(tag, "downlink");
        }
        try {
            int uid = getContext().getApplicationInfo().uid;
            long uidUp = android.net.TrafficStats.getUidTxBytes(uid);
            long uidDown = android.net.TrafficStats.getUidRxBytes(uid);
            if (uidUp != android.net.TrafficStats.UNSUPPORTED && uidUp > up) {
                up = uidUp;
            }
            if (uidDown != android.net.TrafficStats.UNSUPPORTED && uidDown > down) {
                down = uidDown;
            }
        } catch (Throwable e) {
            Log.d(TAG, "UID traffic stats unavailable", e);
        }
        ret.put("up", up);
        ret.put("down", down);
        call.resolve(ret);
    }

    /** Download the latest routing databases (geoip.dat + geosite.dat) into the Xray asset dir. */
    @PluginMethod
    public void updateGeoAssets(PluginCall call) {
        final PluginCall pcall = call;
        updateExecutor.execute(() -> {
            try {
                File dir = XrayAssetHelper.prepareEnvDir(getContext());
                long geoip = downloadGeoFile(dir, "geoip.dat", GEOIP_MIRRORS);
                long geosite = downloadGeoFile(dir, "geosite.dat", GEOSITE_MIRRORS);
                boolean ok = geoip >= MIN_GEO_BYTES && geosite >= MIN_GEO_BYTES;
                JSObject ret = new JSObject();
                ret.put("ok", ok);
                ret.put("geoipBytes", geoip);
                ret.put("geositeBytes", geosite);
                if (!ok) {
                    ret.put("message", "Could not download routing databases from any mirror");
                }
                pcall.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "updateGeoAssets failed", e);
                pcall.reject("Failed to update routing databases: " + e.getMessage());
            }
        });
    }

    private long downloadGeoFile(File dir, String name, String[] mirrors) {
        File tmp = new File(dir, name + ".tmp");
        for (String url : mirrors) {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setInstanceFollowRedirects(true);
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(60000);
                connection.setRequestProperty("User-Agent", "Mir2rayV2-Updater");
                connection.setRequestProperty("Accept", "application/octet-stream,*/*");
                connection.connect();

                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    Log.w(TAG, "Geo mirror HTTP " + status + ": " + url);
                    continue;
                }

                long written = 0;
                try (InputStream in = connection.getInputStream();
                     OutputStream out = new FileOutputStream(tmp, false)) {
                    byte[] buffer = new byte[16 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                        written += read;
                    }
                    out.flush();
                }

                if (written < MIN_GEO_BYTES) {
                    Log.w(TAG, "Geo file too small (" + written + " bytes) from " + url);
                    continue;
                }

                // Swap in atomically, keeping a backup until the rename succeeds.
                File dest = new File(dir, name);
                File bak = new File(dir, name + ".bak");
                if (dest.exists()) {
                    dest.renameTo(bak);
                }
                if (tmp.renameTo(dest)) {
                    if (bak.exists()) bak.delete();
                    Log.i(TAG, "Updated " + name + " (" + written + " bytes) from " + url);
                    return written;
                }
                // rename failed: restore the previous file
                if (bak.exists()) bak.renameTo(dest);
            } catch (Exception e) {
                Log.w(TAG, "Geo download failed from " + url, e);
            } finally {
                if (connection != null) connection.disconnect();
                if (tmp.exists()) tmp.delete();
            }
        }
        return -1;
    }

    private String resolveLatestReleaseTag(String owner, String repo) throws Exception {
        HttpURLConnection connection = null;
        try {
            URL url = new URL("https://github.com/" + owner + "/" + repo + "/releases/latest");
            connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(15000);
            connection.setRequestProperty("User-Agent", "Mir2rayV2-Updater");
            connection.setRequestProperty("Accept", "text/html,*/*");
            connection.connect();

            int status = connection.getResponseCode();
            String location = connection.getHeaderField("Location");
            if (status >= 300 && status < 400 && location != null && !location.trim().isEmpty()) {
                String tag = extractReleaseTag(location);
                if (!tag.isEmpty()) return tag;
            }

            String finalUrl = connection.getURL() != null ? connection.getURL().toString() : "";
            String tag = extractReleaseTag(finalUrl);
            if (!tag.isEmpty()) return tag;

            throw new java.io.IOException("Could not resolve latest release tag (HTTP " + status + ")");
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private String extractReleaseTag(String url) {
        if (url == null) return "";
        String marker = "/releases/tag/";
        int index = url.indexOf(marker);
        if (index < 0) return "";
        String tag = url.substring(index + marker.length());
        int queryIndex = tag.indexOf('?');
        if (queryIndex >= 0) tag = tag.substring(0, queryIndex);
        int hashIndex = tag.indexOf('#');
        if (hashIndex >= 0) tag = tag.substring(0, hashIndex);
        return Uri.decode(tag.trim());
    }

    private java.util.List<String> buildReleaseAssetCandidates(String tagName, String installedVersion) {
        java.util.LinkedHashSet<String> names = new java.util.LinkedHashSet<>();
        String tag = tagName == null ? "" : tagName.trim();
        String normalizedTag = tag.replaceFirst("^[vV]", "");
        if (!tag.isEmpty()) {
            names.add("Mir2rayV2-" + tag + ".apk");
        }
        if (!normalizedTag.isEmpty()) {
            names.add("Mir2rayV2-v" + normalizedTag + ".apk");
        }
        String normalizedInstalled = installedVersion == null ? "" : installedVersion.trim().replaceFirst("^[vV]", "");
        if (!normalizedInstalled.isEmpty()) {
            names.add("Mir2rayV2-v" + normalizedInstalled + ".apk");
        }
        names.add("Mir2rayV2.apk");
        names.add("app-release.apk");
        return new java.util.ArrayList<>(names);
    }

    private String buildReleaseDownloadUrl(String owner, String repo, String tagName, String assetName) {
        return "https://github.com/"
                + owner + "/" + repo
                + "/releases/download/"
                + Uri.encode(tagName)
                + "/"
                + Uri.encode(assetName);
    }

    private boolean releaseAssetExists(String url) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("HEAD");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(15000);
            connection.setRequestProperty("User-Agent", "Mir2rayV2-Updater");
            connection.setRequestProperty("Accept", "application/vnd.android.package-archive,*/*");
            int status = connection.getResponseCode();
            return status >= 200 && status < 400;
        } catch (Exception e) {
            Log.w(TAG, "Release asset probe failed: " + url, e);
            return false;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private JSONObject parsePayload(String raw) throws Exception {
        if (raw == null || raw.isEmpty()) {
            return new JSONObject();
        }
        String trimmed = raw.trim();
        if (trimmed.startsWith("{")) {
            return new JSONObject(trimmed);
        }
        if (trimmed.contains("://")) {
            return new JSONObject().put("shareUri", trimmed);
        }
        return new JSONObject().put("shareUri", trimmed);
    }

    private static boolean isSafeGitHubSegment(String value) {
        return value != null && value.trim().matches("[A-Za-z0-9_.-]{1,100}");
    }

    private static String sanitizeApkFileName(String value) {
        String name = value == null ? "" : value.trim();
        name = name.replaceAll("[^A-Za-z0-9._-]", "_");
        if (name.isEmpty()) name = "Mir2rayV2.apk";
        if (name.length() > 100) name = name.substring(name.length() - 100);
        if (!name.toLowerCase(java.util.Locale.US).endsWith(".apk")) name += ".apk";
        return name;
    }

    private static boolean isTrustedUpdateUrl(URL url) {
        if (url == null || !"https".equalsIgnoreCase(url.getProtocol())) return false;
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase(java.util.Locale.US);
        return "github.com".equals(host)
                || host.endsWith(".github.com")
                || "githubusercontent.com".equals(host)
                || host.endsWith(".githubusercontent.com");
    }

    private void verifyDownloadedApk(File apk) throws Exception {
        android.content.pm.PackageManager pm = getContext().getPackageManager();
        int flags = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P
                ? android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES
                : android.content.pm.PackageManager.GET_SIGNATURES;
        android.content.pm.PackageInfo archive = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        android.content.pm.PackageInfo installed = pm.getPackageInfo(getContext().getPackageName(), flags);
        if (archive == null || archive.packageName == null) {
            throw new SecurityException("Downloaded file is not a readable APK");
        }
        if (!getContext().getPackageName().equals(archive.packageName)) {
            throw new SecurityException("Downloaded APK package name does not match this app");
        }
        if (!signaturesMatch(installed, archive)) {
            throw new SecurityException("Downloaded APK signing certificate does not match this app");
        }
    }

    @SuppressWarnings("deprecation")
    private static boolean signaturesMatch(
            android.content.pm.PackageInfo installed,
            android.content.pm.PackageInfo archive
    ) {
        android.content.pm.Signature[] installedSignatures;
        android.content.pm.Signature[] archiveSignatures;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            installedSignatures = installed.signingInfo != null
                    ? installed.signingInfo.getSigningCertificateHistory()
                    : null;
            archiveSignatures = archive.signingInfo != null
                    ? archive.signingInfo.getApkContentsSigners()
                    : null;
        } else {
            installedSignatures = installed.signatures;
            archiveSignatures = archive.signatures;
        }
        if (installedSignatures == null || archiveSignatures == null
                || installedSignatures.length == 0 || archiveSignatures.length == 0) {
            return false;
        }
        for (android.content.pm.Signature current : installedSignatures) {
            for (android.content.pm.Signature candidate : archiveSignatures) {
                if (current.equals(candidate)) return true;
            }
        }
        return false;
    }

    private String firstShareUri(JSONObject payload, String rawFallback) {
        String shareUri = payload.optString("shareUri", payload.optString("shareLink", "")).trim();
        if (!shareUri.isEmpty()) return shareUri;

        JSONArray shareUris = payload.optJSONArray("shareUris");
        if (shareUris != null && shareUris.length() > 0) {
            shareUri = shareUris.optString(0, "").trim();
            if (!shareUri.isEmpty()) return shareUri;
        }

        JSONArray balancedProfiles = payload.optJSONArray("balancedProfiles");
        if (balancedProfiles != null && balancedProfiles.length() > 0) {
            JSONObject first = balancedProfiles.optJSONObject(0);
            if (first != null) {
                shareUri = first.optString("shareUri", "").trim();
                if (!shareUri.isEmpty()) return shareUri;
            }
        }
        String fallback = rawFallback == null ? "" : rawFallback.trim();
        return fallback.contains("://") ? fallback : "";
    }
}
