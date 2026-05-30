package com.mir2ray.app;

import android.content.Context;
import android.net.VpnService;
import android.util.Log;

import go.Seq;
import libv2ray.CoreCallbackHandler;
import libv2ray.CoreController;
import libv2ray.Libv2ray;

import java.io.File;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Thread-safe wrapper around AndroidLibXrayLite (same library as v2rayNG).
 */
public final class XrayCoreManager {
    private static final String TAG = "XrayCoreManager";
    private static final AtomicBoolean initialized = new AtomicBoolean(false);

    private static CoreController coreController;
    private static volatile VpnService vpnService;

    private XrayCoreManager() {}

    public static void bindVpnService(VpnService service) {
        vpnService = service;
    }

    public static void unbindVpnService(VpnService service) {
        if (vpnService == service) {
            vpnService = null;
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
                    Log.i(TAG, "Xray core started");
                    return 0;
                }

                @Override
                public long shutdown() {
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
        } catch (Exception e) {
            initialized.set(false);
            Log.e(TAG, "Failed to initialize Xray core", e);
            throw new RuntimeException(e);
        }
    }

    public static boolean isRunning() {
        return coreController != null && coreController.getIsRunning();
    }

    public static void startLoop(String configJson, int tunFd) throws Exception {
        if (coreController == null) {
            throw new IllegalStateException("Xray core not initialized");
        }
        if (coreController.getIsRunning()) {
            coreController.stopLoop();
        }
        Log.i(TAG, "Starting Xray loop, tunFd=" + tunFd);
        coreController.startLoop(configJson, tunFd);
        if (!coreController.getIsRunning()) {
            throw new IllegalStateException("Xray core failed to start");
        }
    }

    public static void stopLoop() {
        if (coreController == null) return;
        try {
            if (coreController.getIsRunning()) {
                coreController.stopLoop();
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to stop Xray core", e);
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

    public static long queryStats(String tag, String direction) {
        if (coreController == null || !coreController.getIsRunning()) return 0;
        try {
            return coreController.queryStats(tag, direction);
        } catch (Exception e) {
            return 0;
        }
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
        VpnService svc = vpnService;
        if (svc == null) return false;
        try {
            return svc.protect(fd);
        } catch (Exception e) {
            Log.w(TAG, "protect() failed for fd " + fd, e);
            return false;
        }
    }
}
