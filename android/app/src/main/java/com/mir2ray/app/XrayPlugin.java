package com.mir2ray.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
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
    private static final int DELAY_TEST_THREADS = Math.max(8, Math.min(24, Runtime.getRuntime().availableProcessors() * 2));
    private static final int DELAY_TEST_QUEUE_SIZE = 600;
    private static final int NATIVE_DELAY_THREADS = Math.max(4, Math.min(12, Runtime.getRuntime().availableProcessors()));
    private static final java.util.concurrent.ExecutorService updateExecutor;
    private static final java.util.concurrent.ThreadPoolExecutor delayTestExecutor;
    private static final java.util.concurrent.ThreadPoolExecutor nativeDelayExecutor;
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
                new java.util.concurrent.LinkedBlockingQueue<Runnable>(DELAY_TEST_QUEUE_SIZE),
                nativeTf,
                new java.util.concurrent.ThreadPoolExecutor.CallerRunsPolicy()
        );
        nativeDelayExecutor.allowCoreThreadTimeOut(true);

        java.util.concurrent.atomic.AtomicInteger timeoutThreadNo = new java.util.concurrent.atomic.AtomicInteger(1);
        java.util.concurrent.ThreadFactory timeoutTf = r -> {
            Thread t = new Thread(r, "Xray-DelayTimeout-" + timeoutThreadNo.getAndIncrement());
            t.setUncaughtExceptionHandler((thr, ex) -> Log.e(TAG, "Uncaught in timeout scheduler", ex));
            return t;
        };
        delayTimeoutScheduler = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(timeoutTf);
    }
    private String pendingShareUri;
    private String pendingDnsIp;
    private String pendingCleanIp;
    private String pendingFragmentJson;
    private boolean pendingStrictDns;

    @PluginMethod
    public void startVpn(PluginCall call) {
        try {
            JSONObject payload = parsePayload(call.getString("config"));
            pendingShareUri = payload.optString("shareUri", payload.optString("shareLink", ""));
            if (pendingShareUri.isEmpty()) {
                pendingShareUri = call.getString("config", "");
            }
            pendingDnsIp = payload.optString("dnsIp", null);
            pendingCleanIp = payload.optString("cleanIp", null);
            pendingStrictDns = payload.optBoolean(
                    "strictDns",
                    pendingDnsIp != null && !pendingDnsIp.isEmpty()
            );
            pendingFragmentJson = payload.has("fragment")
                    ? payload.getJSONObject("fragment").toString()
                    : null;

            if (pendingShareUri.isEmpty()) {
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

            Intent serviceIntent = new Intent(getContext(), Mir2RayVpnService.class);
            serviceIntent.putExtra(Mir2RayVpnService.EXTRA_SHARE_URI, pendingShareUri);
            serviceIntent.putExtra(Mir2RayVpnService.EXTRA_DNS_IP, pendingDnsIp);
            serviceIntent.putExtra(Mir2RayVpnService.EXTRA_CLEAN_IP, pendingCleanIp);
            serviceIntent.putExtra(Mir2RayVpnService.EXTRA_FRAGMENT, pendingFragmentJson);
            serviceIntent.putExtra(Mir2RayVpnService.EXTRA_STRICT_DNS, pendingStrictDns);

            // Optional split-tunnel lists
            try {
                if (pendingShareUri != null) {
                    // parse allowed/disallowed apps from payload if present
                    JSONObject raw = parsePayload(call.getString("config"));
                    if (raw.has("allowedApps")) {
                        JSONArray arr = raw.getJSONArray("allowedApps");
                        String[] allowed = new String[arr.length()];
                        for (int i = 0; i < arr.length(); i++) allowed[i] = arr.getString(i);
                        serviceIntent.putExtra(Mir2RayVpnService.EXTRA_ALLOWED_APPS, allowed);
                    }
                    if (raw.has("disallowedApps")) {
                        JSONArray arr2 = raw.getJSONArray("disallowedApps");
                        String[] disallowed = new String[arr2.length()];
                        for (int i = 0; i < arr2.length(); i++) disallowed[i] = arr2.getString(i);
                        serviceIntent.putExtra(Mir2RayVpnService.EXTRA_DISALLOWED_APPS, disallowed);
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed to parse allowed/disallowed apps", e);
            }

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                getContext().startForegroundService(serviceIntent);
            } else {
                getContext().startService(serviceIntent);
            }

            JSObject ret = new JSObject();
            ret.put("status", "connected");
            ret.put("version", XrayCoreManager.getVersion());
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "Failed to start VPN service", e);
            call.reject("Failed to start VPN: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopVpn(PluginCall call) {
        Intent serviceIntent = new Intent(getContext(), Mir2RayVpnService.class);
        serviceIntent.setAction("STOP");
        getContext().startService(serviceIntent);

        JSObject ret = new JSObject();
        ret.put("status", "disconnected");
        call.resolve(ret);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", XrayCoreManager.isRunning());
        ret.put("version", XrayCoreManager.getVersion());
        call.resolve(ret);
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
            androidx.work.PeriodicWorkRequest req = new androidx.work.PeriodicWorkRequest.Builder(
                    VpnMonitorWorker.class, java.time.Duration.ofMinutes(15))
                    .build();
            androidx.work.WorkManager.getInstance(getContext()).enqueueUniquePeriodicWork(
                    "mir2ray_vpn_monitor", androidx.work.ExistingPeriodicWorkPolicy.REPLACE, req);
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
            android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(android.net.Uri.parse("package:" + ctx.getPackageName()));
            intent.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("requestIgnoreBatteryOptimizations failed: " + e.getMessage());
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
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url));
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
        if (fileName == null || fileName.trim().isEmpty()) {
            fileName = "Mir2rayV2.apk";
        }
        if (!fileName.toLowerCase(java.util.Locale.US).endsWith(".apk")) {
            fileName = fileName + ".apk";
        }

        final String downloadUrl = url;
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

                try (InputStream in = connection.getInputStream();
                     OutputStream out = new FileOutputStream(outFile, false)) {
                    byte[] buffer = new byte[16 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                    }
                    out.flush();
                }

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
        String host = call.getString("host", "");
        int port = call.getInt("port", 443);
        int timeout = call.getInt("timeout", 2000);

        new Thread(() -> {
            long ms = TcpPingHelper.ping(host, port, timeout);
            JSObject ret = new JSObject();
            ret.put("latency", ms);
            ret.put("ok", ms >= 0);
            try {
                final JSObject fres = ret;
                android.app.Activity act = getActivity();
                if (act != null) {
                    act.runOnUiThread(() -> call.resolve(fres));
                } else {
                    call.resolve(fres);
                }
            } catch (Exception e) {
                Log.w(TAG, "pingHost resolve failed", e);
                try { call.resolve(ret); } catch (Exception ignore) {}
            }
        }, "PingHost").start();
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

    /** Current public IP as seen directly or through the active VPN tunnel. */
    @PluginMethod
    public void getCurrentPublicIp(PluginCall call) {
        int timeoutMs = call.getInt("timeoutMs", 4000);
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
        String testUrl = call.getString("testUrl", "https://www.google.com/generate_204");
        int timeoutMs = call.getInt("timeoutMs", 5000);
        int maxLatencyMs = call.getInt("maxLatencyMs", -1);

        final PluginCall pcall = call;

        try {
            delayTestExecutor.execute(() -> {
                try {
                    XrayCoreManager.init(getContext());
                    FragmentOptions fragment = new FragmentOptions();
                    String config = V2rayConfigBuilder.build(getContext(), shareUri, dnsIp, cleanIp, fragment, strictDns);
                    java.util.concurrent.CompletableFuture<Long> future = java.util.concurrent.CompletableFuture.supplyAsync(
                            () -> XrayCoreManager.measureDelay(config, testUrl),
                            nativeDelayExecutor
                    );
                    java.util.concurrent.ScheduledFuture<?> timeoutHandle = delayTimeoutScheduler.schedule(
                            () -> future.cancel(true),
                            timeoutMs,
                            java.util.concurrent.TimeUnit.MILLISECONDS
                    );

                    future.whenComplete((latencyValue, throwable) -> {
                        timeoutHandle.cancel(false);
                        long latency = -1;
                        boolean ok = false;
                        if (throwable == null && latencyValue != null) {
                            latency = latencyValue;
                            if (maxLatencyMs > 0 && latency > maxLatencyMs) {
                                ok = false;
                            } else {
                                ok = latency >= 0;
                            }
                        } else if (throwable != null
                                && !(throwable instanceof java.util.concurrent.CancellationException)) {
                            Log.e(TAG, "measureConfigDelay failed", throwable);
                        }

                        JSObject ret = new JSObject();
                        ret.put("latency", latency);
                        ret.put("ok", ok);
                        android.app.Activity act = getActivity();
                        if (act != null) {
                            act.runOnUiThread(() -> pcall.resolve(ret));
                        } else {
                            pcall.resolve(ret);
                        }
                    });
                } catch (Exception e) {
                    Log.e(TAG, "measureConfigDelay failed", e);
                    JSObject ret = new JSObject();
                    ret.put("latency", -1);
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
            ret.put("ok", false);
            pcall.reject("Too many pending tests in queue, please wait and try again");
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("latency", -1);
            ret.put("ok", false);
            pcall.reject("Failed to queue measure test: " + e.getMessage());
        }
    }

    @PluginMethod
    public void measureConfigBandwidth(PluginCall call) {
        final PluginCall pcall = call;
        try {
            JSONObject payload = parsePayload(call.getString("config"));
            delayTestExecutor.execute(() -> {
                try {
                    BandwidthTestHelper.BandwidthResult result = BandwidthTestHelper.measure(getContext(), payload);
                    JSObject ret = new JSObject();
                    ret.put("downloadBps", result.downloadBps);
                    ret.put("uploadBps", result.uploadBps);
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
                } catch (Exception e) {
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
    public void getTrafficStats(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("up", XrayCoreManager.queryStats("proxy", "uplink"));
        ret.put("down", XrayCoreManager.queryStats("proxy", "downlink"));
        call.resolve(ret);
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
}
