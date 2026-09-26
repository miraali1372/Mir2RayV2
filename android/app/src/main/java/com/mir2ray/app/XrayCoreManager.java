package com.mir2ray.app;

import android.content.Context;
import android.net.VpnService;
import android.util.Log;

import go.Seq;
import libv2ray.CoreCallbackHandler;
import libv2ray.CoreController;
import libv2ray.Libv2ray;

import java.io.File;
import java.lang.ref.WeakReference;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Thread-safe wrapper around AndroidLibXrayLite (same library as v2rayNG).
 */
public final class XrayCoreManager {
    private static final String TAG = "XrayCoreManager";
    private static final AtomicBoolean initialized = new AtomicBoolean(false);
    private static final AtomicBoolean running = new AtomicBoolean(false);

    private static CoreController coreController;
    private static volatile WeakReference<VpnService> vpnServiceRef = new WeakReference<>(null);

    private XrayCoreManager() {}

    public static void bindVpnService(VpnService service) {
        vpnServiceRef = new WeakReference<>(service);
    }

    public static void unbindVpnService(VpnService service) {
        VpnService current = vpnServiceRef.get();
        if (current == service) {
            vpnServiceRef = new WeakReference<>(null);
        }
    }

    public static synchronized void init(Context context) {
        if (!initialized.compareAndSet(false, true)) return;
        try {
            Context app = context.getApplicationContext();
            Seq.setContext(app);
            File assetDir = XrayAssetHelper.prepareEnvDir(app);
            Libv2ray.initCoreEnv(assetDir.getAbsolutePath(), "");
            CoreCallbackHandler callbackHandler = new CoreCallbackHandler() {
                @Override
                public long startup() {
                    running.set(true);
                    Log.i(TAG, "Xray core started");
                    return 0;
                }

                @Override
                public long shutdown() {
                    running.set(false);
                    Log.i(TAG, "Xray core shutdown");
                    return 0;
                }

                @Override
                public long onEmitStatus(long code, String message) {
                    Log.d(TAG, "Xray status " + code + ": " + message);
                    return 0;
                }
            };
            coreController = Libv2ray.newCoreController(callbackHandler);
            // Register a ProcessFinder so native core can query connection ownership if needed.
            try {
                coreController.registerProcessFinder(new libv2ray.ProcessFinder() {
                    @Override
                    public long findProcessByConnection(String network, String srcIP, long srcPort, String destIP, long destPort) {
                        // Best-effort: not implemented — return -1 to indicate unknown.
                        // Advanced: could inspect /proc/* entries to map inode -> pid -> uid, but this
                        // requires additional permissions and is platform-dependent.
                        return -1;
                    }
                });
            } catch (Exception e) {
                Log.w(TAG, "Failed to register ProcessFinder", e);
            }
            Log.i(TAG, "Xray core initialized: " + Libv2ray.checkVersionX());
        } catch (Exception | LinkageError e) {
            initialized.set(false);
            running.set(false);
            coreController = null;
            Log.e(TAG, "Failed to initialize Xray core", e);
            throw new RuntimeException(e);
        }
    }

    public static boolean isRunning() {
        // Do not contend with the native startLoop handshake. The callback and
        // lifecycle methods keep this state current without blocking callers.
        return running.get();
    }

    public static synchronized void startLoop(String configJson, int tunFd) throws Exception {
        if (coreController == null) {
            throw new IllegalStateException("Xray core not initialized");
        }
        if (coreController.getIsRunning()) {
            running.set(false);
            coreController.stopLoop();
        }
        Log.i(TAG, "Starting Xray loop, tunFd=" + tunFd);
        coreController.startLoop(configJson, tunFd);
        if (!coreController.getIsRunning()) {
            running.set(false);
            throw new IllegalStateException("Xray core failed to start");
        }
        running.set(true);
    }

    public static synchronized void stopLoop() {
        if (coreController == null) return;
        try {
            if (coreController.getIsRunning()) {
                coreController.stopLoop();
            }
        } catch (Exception | LinkageError e) {
            Log.e(TAG, "Failed to stop Xray core", e);
        } finally {
            running.set(false);
        }
    }

    public static long measureDelay(String configJson, String testUrl) {
        try {
            return Libv2ray.measureOutboundDelay(configJson, testUrl);
        } catch (Exception e) {
            Log.e(TAG, "Delay test failed", e);
            return -1;
        }
    }

    public static synchronized String queryAllOutboundTrafficStats() {
        if (coreController == null || !coreController.getIsRunning()) return "";
        try {
            return coreController.queryAllOutboundTrafficStats();
        } catch (Exception | LinkageError e) {
            return "";
        }
    }

    public static synchronized long queryStats(String tag, String direction) {
        if (coreController == null || !coreController.getIsRunning()) return 0;
        try {
            String allStats = coreController.queryAllOutboundTrafficStats();
            if (allStats == null || allStats.trim().isEmpty()) return 0;
            allStats = allStats.trim();
            if (allStats.startsWith("{")) {
                try {
                    org.json.JSONObject obj = new org.json.JSONObject(allStats);
                    if (obj.has(tag)) {
                        org.json.JSONObject tagObj = obj.optJSONObject(tag);
                        if (tagObj != null && tagObj.has(direction)) {
                            return tagObj.optLong(direction, 0);
                        }
                    }
                    java.util.Iterator<String> keys = obj.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        if (k.contains(tag) && k.contains(direction)) {
                            return obj.optLong(k, 0);
                        }
                    }
                } catch (Exception ignored) {}
            }
            for (String line : allStats.split("[\\r\\n]+")) {
                if (line.contains(tag) && line.contains(direction)) {
                    String[] parts = line.split("[:=]");
                    if (parts.length > 1) {
                        try {
                            return Long.parseLong(parts[parts.length - 1].trim());
                        } catch (NumberFormatException ignored) {}
                    }
                }
            }
        } catch (Exception | LinkageError e) {
            return 0;
        }
        return 0;
    }

    public static String getVersion() {
        try {
            return Libv2ray.checkVersionX();
        } catch (Exception e) {
            return "unknown";
        }
    }

    /** Prevent proxy outbound from looping through the VPN interface. */
    public static boolean protectSocket(int fd) {
        VpnService svc = vpnServiceRef.get();
        if (svc == null) return false;
        try {
            return svc.protect(fd);
        } catch (Exception e) {
            Log.w(TAG, "protect() failed for fd " + fd, e);
            return false;
        }
    }
}
