package com.mir2ray.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * System VPN service — TUN + Xray core (v2rayNG-compatible stack).
 */
public class Mir2RayVpnService extends VpnService {
    private static final String TAG = "Mir2RayVpnService";
    private static final String CHANNEL_ID = "mir2ray_vpn_channel";

    /** Must match Xray tun companion network (v2rayNG default). */
    private static final String VPN_CLIENT_IP = "172.19.0.1";
    private static final int VPN_PREFIX = 30;

    public static final String EXTRA_SHARE_URI = "shareUri";
    public static final String EXTRA_SHARE_URIS = "shareUris";
    public static final String EXTRA_DNS_IP = "dnsIp";
    public static final String EXTRA_CLEAN_IP = "cleanIp";
    public static final String EXTRA_FRAGMENT = "fragmentJson";
    public static final String EXTRA_STRICT_DNS = "strictDns";
    public static final String EXTRA_ALLOWED_APPS = "allowedApps";
    public static final String EXTRA_DISALLOWED_APPS = "disallowedApps";
    public static final String EXTRA_PAYLOAD_JSON = "payloadJson";
    public static final String EXTRA_START_ID = "startId";
    public static final String ACTION_STOP = "STOP";

    private ParcelFileDescriptor vpnInterface;
    private volatile boolean running;
    private ExecutorService vpnExecutor;
    private volatile boolean destroyed;
    private java.util.concurrent.ScheduledExecutorService monitor;
    private volatile String currentPayload = "";
    private volatile int healthFailures;
    private volatile long lastRecoveryAt;
    private volatile int selectedMtu = 1280;
    private volatile boolean conservativeMtu;
    private static volatile boolean desired;
    private static volatile String activeConfigId = "";

    public static boolean isDesired() { return desired; }
    public static String getActiveConfigId() { return activeConfigId; }

    private static volatile long activeStartId = -1L;
    private static volatile boolean starting = false;
    private static volatile String lastStartError = "";
    private static volatile long connectedAtMs = 0L;

    @Override
    public void onCreate() {
        super.onCreate();
        MainActivity.installCrashLogger(getApplicationContext());
        try {
            createNotificationChannel();
        } catch (Throwable error) {
            Log.e(TAG, "Unable to create VPN notification channel", error);
        }
        vpnExecutor = Executors.newSingleThreadExecutor(r -> {
            Thread thread = new Thread(r, "Mir2Ray-VpnLifecycle");
            thread.setUncaughtExceptionHandler((t, e) -> Log.e(TAG, "VPN lifecycle task crashed", e));
            return thread;
        });
        XrayCoreManager.bindVpnService(this);
        monitor = java.util.concurrent.Executors.newSingleThreadScheduledExecutor();
        monitor.scheduleWithFixedDelay(this::monitorConnection, 3, 7, java.util.concurrent.TimeUnit.SECONDS);
        try {
            XrayCoreManager.init(this);
        } catch (Throwable e) {
            Log.e(TAG, "Xray init failed in service", e);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            return handleStartCommand(intent, startId);
        } catch (Throwable error) {
            long token = intent != null
                    ? intent.getLongExtra(EXTRA_START_ID, activeStartId)
                    : activeStartId;
            String message = error.getMessage() != null ? error.getMessage() : error.toString();
            Log.e(TAG, "VPN service entry point failed", error);
            try {
                LogCollector.append(getApplicationContext(),
                        "VPN service entry point failed: " + error);
            } catch (Throwable ignore) {}
            markStartFailed(token, message);
            activeStartId = -1L;
            running = false;
            try { stopForeground(true); } catch (Throwable ignore) {}
            try { stopSelfResult(startId); } catch (Throwable ignore) {}
            return START_NOT_STICKY;
        }
    }

    private int handleStartCommand(Intent intent, int startId) {
        if (intent != null && intent.hasExtra("recoveryToken")
            && (!desired || activeStartId != intent.getLongExtra("recoveryToken", -2))) return START_NOT_STICKY;
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            desired = false;
            VpnHealth.reset();
            persistDesired(false);
            activeStartId = -1L;
            starting = false;
            lastStartError = "";
            connectedAtMs = 0L;
            submitVpnTask(() -> stopVpnInternal(true, startId));
            return START_NOT_STICKY;
        }

        Intent effectiveIntent = intent;
        if (effectiveIntent == null) {
            // START_STICKY restarts arrive without the original Intent. Restore only a connection
            // that had been fully verified and persisted as running; never resurrect a manual stop.
            SecureStorage storage = new SecureStorage(this);
            String lastState = storage.getString("mir2ray_vpn_last_state");
            String savedPayload = storage.getString("mir2ray_last_vpn_payload");
            if (!"1".equals(lastState) || savedPayload == null || savedPayload.trim().isEmpty()) {
                stopSelfResult(startId);
                return START_NOT_STICKY;
            }
            effectiveIntent = new Intent(this, Mir2RayVpnService.class);
            effectiveIntent.putExtra(EXTRA_PAYLOAD_JSON, savedPayload);
            applyPayloadExtras(effectiveIntent, savedPayload);
        }

        if (effectiveIntent.hasExtra(EXTRA_PAYLOAD_JSON)) {
            applyPayloadExtras(effectiveIntent, effectiveIntent.getStringExtra(EXTRA_PAYLOAD_JSON));
        }

        String payloadJson = effectiveIntent.getStringExtra(EXTRA_PAYLOAD_JSON);
        currentPayload = payloadJson != null ? payloadJson : "";
        desired = true;
        VpnHealth.reset();
        healthFailures = 0;
        try { activeConfigId = new JSONObject(currentPayload).optString("configId", ""); }
        catch (Exception ignored) { activeConfigId = ""; }
        String shareUri = effectiveIntent.getStringExtra(EXTRA_SHARE_URI);
        String[] shareUris = effectiveIntent.getStringArrayExtra(EXTRA_SHARE_URIS);
        String dnsIp = effectiveIntent.getStringExtra(EXTRA_DNS_IP);
        String cleanIp = effectiveIntent.getStringExtra(EXTRA_CLEAN_IP);
        String fragmentJson = effectiveIntent.getStringExtra(EXTRA_FRAGMENT);
        boolean requestedStrictDns = effectiveIntent.getBooleanExtra(EXTRA_STRICT_DNS, false);
        if (requestedStrictDns && dnsIp != null && !dnsIp.isEmpty()) {
            Log.i(TAG, "Relaxing strict DNS for live VPN stability; selected DNS will be preferred with fallbacks");
            requestedStrictDns = false;
        }
        final boolean strictDns = requestedStrictDns;
        String[] allowedApps = effectiveIntent.getStringArrayExtra(EXTRA_ALLOWED_APPS);
        String[] disallowedApps = effectiveIntent.getStringArrayExtra(EXTRA_DISALLOWED_APPS);
        long startIdToken = effectiveIntent.getLongExtra(EXTRA_START_ID, System.nanoTime());
        activeStartId = startIdToken;
        starting = true;
        lastStartError = "";
        connectedAtMs = 0L;

        if ((shareUri == null || shareUri.isEmpty()) && (shareUris == null || shareUris.length == 0)) {
            Log.e(TAG, "Missing share URI");
            markStartFailed(startIdToken, "Missing share URI");
            stopSelfResult(startId);
            return START_NOT_STICKY;
        }
        if (shareUris == null || shareUris.length == 0) {
            shareUris = new String[] {shareUri};
        }

        FragmentOptions fragment = parseFragment(fragmentJson);
        startForeground(1, buildNotification("Connecting..."));

        String finalPayloadJson = payloadJson;
        String[] finalShareUris = shareUris;
        try {
            submitVpnTask(() -> startVpn(
                    startId,
                    startIdToken,
                    finalPayloadJson,
                    finalShareUris,
                    dnsIp,
                    cleanIp,
                    fragment,
                    strictDns,
                    allowedApps,
                    disallowedApps
            ));
        } catch (RejectedExecutionException e) {
            markStartFailed(startIdToken, "VPN service is shutting down");
            stopForeground(true);
            stopSelfResult(startId);
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    private void submitVpnTask(Runnable task) {
        ExecutorService executor = vpnExecutor;
        if (destroyed || executor == null || executor.isShutdown()) {
            throw new RejectedExecutionException("VPN lifecycle executor is unavailable");
        }
        executor.execute(task);
    }

    public static void applyPayloadExtras(Intent serviceIntent, String payloadJson) {
        if (serviceIntent == null || payloadJson == null || payloadJson.trim().isEmpty()) return;
        String payload = payloadJson.trim();
        try {
            JSONObject obj = new JSONObject(payload);
            String shareUri = obj.optString("shareUri", obj.optString("shareLink", ""));
            if (!shareUri.isEmpty()) serviceIntent.putExtra(EXTRA_SHARE_URI, shareUri);
            JSONArray shareUris = obj.optJSONArray("shareUris");
            JSONArray balancedProfiles = obj.optJSONArray("balancedProfiles");
            if (shareUris != null) {
                putStringArrayExtra(serviceIntent, EXTRA_SHARE_URIS, shareUris);
            } else if (balancedProfiles != null) {
                putProfileShareUrisExtra(serviceIntent, balancedProfiles);
            }

            String dnsIp = obj.optString("dnsIp", "");
            if (!dnsIp.isEmpty()) serviceIntent.putExtra(EXTRA_DNS_IP, dnsIp);

            String cleanIp = obj.optString("cleanIp", "");
            if (!cleanIp.isEmpty()) serviceIntent.putExtra(EXTRA_CLEAN_IP, cleanIp);

            if (obj.has("fragment") && !obj.isNull("fragment")) {
                Object fragment = obj.get("fragment");
                serviceIntent.putExtra(EXTRA_FRAGMENT, fragment instanceof JSONObject ? fragment.toString() : String.valueOf(fragment));
            }

            serviceIntent.putExtra(EXTRA_STRICT_DNS, obj.optBoolean("strictDns", false));
            putStringArrayExtra(serviceIntent, EXTRA_ALLOWED_APPS, obj.optJSONArray("allowedApps"));
            putStringArrayExtra(serviceIntent, EXTRA_DISALLOWED_APPS, obj.optJSONArray("disallowedApps"));
        } catch (Exception e) {
            if (payload.contains("://")) {
                serviceIntent.putExtra(EXTRA_SHARE_URI, payload);
            }
        }
    }

    private static void putStringArrayExtra(Intent intent, String key, JSONArray array) {
        if (array == null) return;
        String[] values = new String[array.length()];
        for (int i = 0; i < array.length(); i++) {
            values[i] = array.optString(i, "");
        }
        intent.putExtra(key, values);
    }

    private static void putProfileShareUrisExtra(Intent intent, JSONArray profiles) {
        if (profiles == null) return;
        String[] values = new String[profiles.length()];
        for (int i = 0; i < profiles.length(); i++) {
            JSONObject profile = profiles.optJSONObject(i);
            values[i] = profile != null ? profile.optString("shareUri", "") : "";
        }
        intent.putExtra(EXTRA_SHARE_URIS, values);
    }

    private void startVpn(
            int serviceStartId,
            long startIdToken,
            String payloadJson,
            String[] shareUris,
            String dnsIp,
            String cleanIp,
            FragmentOptions fragment,
            boolean strictDns,
            String[] allowedApps,
            String[] disallowedApps
    ) {
        ParcelFileDescriptor newTun = null;
        try {
            if (activeStartId != startIdToken) return;

            // Build and establish the replacement TUN before stopping the active core. Android
            // switches directly to the new interface, so reconnects briefly block instead of
            // leaking traffic outside the VPN.
            String configJson = V2rayConfigBuilder.build(this, payloadJson, shareUris, dnsIp, cleanIp, fragment, strictDns);
            Log.d(TAG, "Xray config length: " + configJson.length());

            newTun = establishVpnInterface(dnsIp, strictDns, allowedApps, disallowedApps);
            if (newTun == null) {
                throw new IllegalStateException("Failed to establish VPN interface");
            }
            if (activeStartId != startIdToken) {
                closeQuietly(newTun);
                return;
            }

            ParcelFileDescriptor oldTun = vpnInterface;
            XrayCoreManager.stopLoop();
            XrayCoreManager.startLoop(configJson, newTun.getFd());

            if (!XrayCoreManager.isRunning()) {
                throw new IllegalStateException("Xray core is not running after start");
            }
            if (activeStartId != startIdToken) {
                XrayCoreManager.stopLoop();
                closeQuietly(newTun);
                return;
            }

            vpnInterface = newTun;
            newTun = null;
            running = true;
            closeQuietly(oldTun);

            markStartSucceeded(startIdToken);
            updateNotification("Verifying connection - Mir2rayV2");
            Log.i(TAG, "VPN + Xray core running (tun fd=" + vpnInterface.getFd() + ")");
        } catch (Throwable e) {
            // Throwable (not just Exception) so an OutOfMemoryError or UnsatisfiedLinkError on a weak
            // or mis-packaged device aborts the connection cleanly instead of closing the whole app.
            Log.e(TAG, "Error starting VPN", e);
            try {
                LogCollector.append(getApplicationContext(), "Error starting VPN: " + e.toString());
            } catch (Throwable ignore) {}
            closeQuietly(newTun);
            if (activeStartId == startIdToken) {
                markStartFailed(startIdToken, e.getMessage() != null ? e.getMessage() : e.toString());
                stopVpnInternal(true, serviceStartId);
            }
        }
    }

    public static StartState getStartState(long startIdToken) {
        return new StartState(
                activeStartId == startIdToken,
                XrayCoreManager.isRunning(),
                starting,
                lastStartError,
                connectedAtMs
        );
    }

    public static String getLastStartError() {
        return lastStartError;
    }

    public static boolean isStarting() {
        return starting;
    }

    private static void markStartSucceeded(long startIdToken) {
        if (activeStartId == startIdToken) {
            starting = false;
            lastStartError = "";
            connectedAtMs = System.currentTimeMillis();
        }
    }

    private static void markStartFailed(long startIdToken, String message) {
        if (activeStartId == startIdToken || activeStartId < 0) {
            starting = false;
            lastStartError = message != null && !message.isEmpty() ? message : "VPN start failed";
            connectedAtMs = 0L;
        }
    }

    private static final String PREF_WORKING_MTU = "mir2ray_working_mtu";

    private void persistDesired(boolean value) {
        try { new SecureStorage(this).putString("mir2ray_vpn_last_state", value ? "1" : "0"); }
        catch (Exception error) { Log.w(TAG, "Could not persist connection intent", error); }
    }

    private void monitorConnection() {
        if (destroyed || !desired || starting || "offline".equals(VpnHealth.networkKey(this))) return;
        long token = activeStartId;
        try {
            if (VpnHealth.check(this, 4500)) {
                if (!desired || token != activeStartId) return;
                healthFailures = 0;
                writeCachedMtu(selectedMtu);
                persistDesired(true);
                updateNotification("Connected - Mir2rayV2");
                return;
            }
            if (!desired || token != activeStartId || ++healthFailures < 2) return;
            if (android.os.SystemClock.elapsedRealtime() - lastRecoveryAt < 20_000) return;
            lastRecoveryAt = android.os.SystemClock.elapsedRealtime();
            JSONObject payload = new JSONObject(currentPayload);
            JSONArray backups = payload.optJSONArray("recoveryProfiles");
            if (!payload.optBoolean("autoRecover", false)) return;
            if (!conservativeMtu && selectedMtu > 1280) {
                conservativeMtu = true;
            } else if (backups != null && backups.length() > 0) {
                int current = -1;
                for (int index = 0; index < backups.length(); index++) {
                    if (backups.getJSONObject(index).optString("shareUri").equals(payload.optString("shareUri"))) current = index;
                }
                JSONObject backup = backups.getJSONObject((current + 1) % backups.length());
                payload.put("shareUri", backup.getString("shareUri"));
                payload.put("configId", backup.optString("configId", ""));
                payload.remove("cleanIp");
                payload.remove("fragment");
                if (backup.has("cleanIp")) payload.put("cleanIp", backup.get("cleanIp"));
                if (backup.has("fragment")) payload.put("fragment", backup.get("fragment"));
            }
            if (!desired || token != activeStartId) return;
            updateNotification("Recovering connection - Mir2rayV2");
            Intent retry = new Intent(this, Mir2RayVpnService.class);
            retry.putExtra(EXTRA_PAYLOAD_JSON, payload.toString());
            retry.putExtra("recoveryToken", token);
            startService(retry);
        } catch (Exception error) {
            Log.w(TAG, "Connection health check failed", error);
        }
    }

    private int readCachedMtu() {
        try {
            int value = getSharedPreferences("mir2ray_runtime", MODE_PRIVATE).getInt(PREF_WORKING_MTU + VpnHealth.networkKey(this), -1);
            if (value > 0) return value;
        } catch (Exception e) {
            Log.w(TAG, "readCachedMtu failed", e);
        }
        return -1;
    }

    private void writeCachedMtu(int mtu) {
        try {
            getSharedPreferences("mir2ray_runtime", MODE_PRIVATE).edit().putInt(PREF_WORKING_MTU + VpnHealth.networkKey(this), mtu).apply();
        } catch (Exception e) {
            Log.w(TAG, "writeCachedMtu failed", e);
        }
    }

    private ParcelFileDescriptor establishVpnInterface(
            String dnsIp,
            boolean strictDns,
            String[] allowedApps,
            String[] disallowedApps
    ) {
        try {
            // Try adaptive MTU values: prefer the last MTU that worked on this device (cached),
            // then 1500, with fallbacks to lower MTUs for mobile networks.
            int[] mtuCandidates = conservativeMtu ? new int[] {1280} : orderMtuCandidates(readCachedMtu(), new int[] {1420, 1280});

            for (int mtu : mtuCandidates) {
                try {
                    Builder b = new Builder();
                    b.setSession("Mir2rayV2");
                    b.setMtu(mtu);
                    b.addAddress(VPN_CLIENT_IP, VPN_PREFIX);
                    b.addRoute("0.0.0.0", 0);
                    try {
                        b.addAddress("fdfe:dcba:9876::1", 126);
                        b.addRoute("::", 0);
                    } catch (Exception e) {
                        Log.w(TAG, "IPv6 route could not be applied on this device", e);
                    }

                    boolean hasSelectedDns = dnsIp != null && !dnsIp.isEmpty() && isIpAddress(dnsIp);
                    addStableDnsServers(b, dnsIp, hasSelectedDns);

                    // Apply split-tunnel package lists if provided (from stored intent extras)
                    try {
                        if (allowedApps != null) {
                            for (String pkg : allowedApps) {
                                try { b.addAllowedApplication(pkg); } catch (Exception ex) { Log.w(TAG, "Failed to addAllowedApplication: " + pkg, ex); }
                            }
                        }
                        IranBypassRules.applyPackageBypass(this, b, allowedApps, disallowedApps);
                    } catch (Exception e) {
                        Log.w(TAG, "Error applying split-tunnel lists", e);
                    }

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        b.setMetered(false);
                    }

                    ParcelFileDescriptor pd = b.establish();
                    if (pd != null) {
                        Log.i(TAG, "Established VPN with MTU=" + mtu
                                + ", dns=" + (hasSelectedDns ? dnsIp + "+fallback" : "fallback")
                                + ", strictDns=" + strictDns);
                        selectedMtu = mtu;
                        return pd;
                    }
                } catch (Exception e) {
                    Log.w(TAG, "MTU " + mtu + " failed, trying next", e);
                }
            }

            // If none succeeded, try one final time WITHOUT specifying MTU
            // Let the system choose the optimal MTU (helps on some devices/carriers)
            Log.w(TAG, "All MTU candidates failed, trying system-default MTU as last resort");
            try {
                Builder b = new Builder();
                b.setSession("Mir2rayV2");
                // No setMtu() - let system decide
                b.addAddress(VPN_CLIENT_IP, VPN_PREFIX);
                b.addRoute("0.0.0.0", 0);
                try {
                    b.addAddress("fdfe:dcba:9876::1", 126);
                    b.addRoute("::", 0);
                } catch (Exception e) {
                    Log.w(TAG, "IPv6 route could not be applied on this device", e);
                }

                boolean hasSelectedDns = dnsIp != null && !dnsIp.isEmpty() && isIpAddress(dnsIp);
                addStableDnsServers(b, dnsIp, hasSelectedDns);

                // Apply split-tunnel package lists if provided
                try {
                    if (allowedApps != null) {
                        for (String pkg : allowedApps) {
                            try { b.addAllowedApplication(pkg); } catch (Exception ex) { Log.w(TAG, "Failed to addAllowedApplication: " + pkg, ex); }
                        }
                    }
                    IranBypassRules.applyPackageBypass(this, b, allowedApps, disallowedApps);
                } catch (Exception e) {
                    Log.w(TAG, "Error applying split-tunnel lists", e);
                }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    b.setMetered(false);
                }

                ParcelFileDescriptor pd = b.establish();
                if (pd != null) {
                    Log.i(TAG, "Established VPN with system-default MTU (fallback succeeded)");
                    return pd;
                }
            } catch (Exception e) {
                Log.e(TAG, "System-default MTU fallback also failed", e);
            }

            // If none succeeded return null
            return null;
        } catch (Exception e) {
            Log.e(TAG, "VPN establish failed", e);
            return null;
        }
    }

    /** Put the cached working MTU first (deduped) so reconnects skip the trial-and-error loop. */
    private static int[] orderMtuCandidates(int cachedMtu, int[] base) {
        if (cachedMtu <= 0) return base;
        int[] ordered = new int[base.length + 1];
        ordered[0] = cachedMtu;
        int idx = 1;
        for (int mtu : base) {
            if (mtu != cachedMtu) ordered[idx++] = mtu;
        }
        if (idx == ordered.length) return ordered;
        int[] trimmed = new int[idx];
        System.arraycopy(ordered, 0, trimmed, 0, idx);
        return trimmed;
    }

    private static boolean isIpAddress(String value) {
        if (value == null || value.trim().isEmpty()) return false;
        String v = value.trim();
        try {
            java.net.InetAddress parsed = java.net.InetAddress.getByName(v);
            return v.equals(parsed.getHostAddress()) || v.contains(":");
        } catch (Exception e) {
            return false;
        }
    }

    private static void addStableDnsServers(Builder b, String dnsIp, boolean hasSelectedDns) {
        java.util.ArrayList<String> servers = new java.util.ArrayList<>();
        if (hasSelectedDns) {
            addDnsIfMissing(servers, dnsIp.trim());
        } else if (dnsIp != null && !dnsIp.isEmpty()) {
            Log.w(TAG, "Ignoring invalid DNS server IP: " + dnsIp);
        }

        // Keep two known-stable fallbacks in the Android TUN resolver. A user-selected
        // DNS remains first, but a slow/blocked DNS server no longer makes every app feel
        // like the VPN is flapping.
        addDnsIfMissing(servers, "1.1.1.1");
        addDnsIfMissing(servers, "8.8.8.8");

        for (String server : servers) {
            b.addDnsServer(server);
        }
    }

    private static void addDnsIfMissing(java.util.ArrayList<String> servers, String value) {
        for (String server : servers) {
            if (server.equals(value)) return;
        }
        servers.add(value);
    }

    private void stopVpnInternal(boolean stopService, int serviceStartId) {
        running = false;
        starting = false;
        connectedAtMs = 0L;
        XrayCoreManager.stopLoop();

        if (vpnInterface != null) {
            try {
                vpnInterface.close();
            } catch (Exception e) {
                Log.e(TAG, "Error closing VPN interface", e);
            }
            vpnInterface = null;
        }

        if (stopService) {
            stopForeground(true);
            if (serviceStartId > 0) {
                stopSelfResult(serviceStartId);
            } else {
                stopSelf();
            }
        }
    }

    private static void closeQuietly(ParcelFileDescriptor descriptor) {
        if (descriptor == null) return;
        try {
            descriptor.close();
        } catch (Exception e) {
            Log.w(TAG, "Error closing VPN interface", e);
        }
    }

    public static final class StartState {
        public final boolean matches;
        public final boolean running;
        public final boolean starting;
        public final String error;
        public final long connectedAtMs;

        StartState(boolean matches, boolean running, boolean starting, String error, long connectedAtMs) {
            this.matches = matches;
            this.running = running;
            this.starting = starting;
            this.error = error;
            this.connectedAtMs = connectedAtMs;
        }
    }

    private FragmentOptions parseFragment(String json) {
        FragmentOptions options = new FragmentOptions();
        if (json == null || json.isEmpty()) return options;
        try {
            JSONObject obj = new JSONObject(json);
            options.enabled = obj.optBoolean("enabled", false);
            options.packets = obj.optString("packets", options.packets);
            options.length = obj.optString("length", options.length);
            options.interval = obj.optString("interval", options.interval);
        } catch (Exception e) {
            Log.w(TAG, "Invalid fragment JSON", e);
        }
        return options;
    }

    private Notification buildNotification(String text) {
        Intent contentIntent = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentPendingIntent = PendingIntent.getActivity(
                this,
                1,
                contentIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        Intent stopIntent = new Intent(this, Mir2RayVpnService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPendingIntent = PendingIntent.getService(
                this,
                0,
                stopIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Mir2rayV2 VPN")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_secure)
                .setContentIntent(contentPendingIntent)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .addAction(new NotificationCompat.Action(
                        android.R.drawable.ic_menu_close_clear_cancel,
                        "Stop VPN",
                        stopPendingIntent
                ))
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(1, buildNotification(text));
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Mir2rayV2 VPN",
                    NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    @Override
    public void onDestroy() {
        destroyed = true;
        desired = false;
        VpnHealth.reset();
        if (monitor != null) monitor.shutdownNow();
        activeStartId = -1L;
        starting = false;
        ExecutorService executor = vpnExecutor;
        if (executor != null && !executor.isShutdown()) {
            executor.execute(() -> {
                stopVpnInternal(false, -1);
                XrayCoreManager.unbindVpnService(this);
            });
            executor.shutdown();
        } else {
            stopVpnInternal(false, -1);
            XrayCoreManager.unbindVpnService(this);
        }
        super.onDestroy();
    }

    @Override
    public void onRevoke() {
        Log.i(TAG, "VPN permission revoked by the system/user");
        desired = false;
        persistDesired(false);
        VpnHealth.reset();
        activeStartId = -1L;
        starting = false;
        connectedAtMs = 0L;
        try {
            submitVpnTask(() -> stopVpnInternal(true, -1));
        } catch (RejectedExecutionException e) {
            stopVpnInternal(true, -1);
        }
        super.onRevoke();
    }
}
