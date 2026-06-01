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

import org.json.JSONObject;

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
    public static final String EXTRA_DNS_IP = "dnsIp";
    public static final String EXTRA_CLEAN_IP = "cleanIp";
    public static final String EXTRA_FRAGMENT = "fragmentJson";
    public static final String EXTRA_STRICT_DNS = "strictDns";
    public static final String EXTRA_ALLOWED_APPS = "allowedApps";
    public static final String EXTRA_DISALLOWED_APPS = "disallowedApps";
    public static final String ACTION_STOP = "STOP";

    private ParcelFileDescriptor vpnInterface;
    private volatile boolean running;
    private String[] allowedApps = null;
    private String[] disallowedApps = null;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        XrayCoreManager.bindVpnService(this);
        try {
            XrayCoreManager.init(this);
        } catch (Exception e) {
            Log.e(TAG, "Xray init failed in service", e);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if ("STOP".equals(action)) {
            stopVpn();
            return START_NOT_STICKY;
        }

        String shareUri = intent != null ? intent.getStringExtra(EXTRA_SHARE_URI) : null;
        String dnsIp = intent != null ? intent.getStringExtra(EXTRA_DNS_IP) : null;
        String cleanIp = intent != null ? intent.getStringExtra(EXTRA_CLEAN_IP) : null;
        String fragmentJson = intent != null ? intent.getStringExtra(EXTRA_FRAGMENT) : null;
        boolean strictDns = intent != null && intent.getBooleanExtra(
                EXTRA_STRICT_DNS,
                dnsIp != null && !dnsIp.isEmpty()
        );
        allowedApps = intent != null ? intent.getStringArrayExtra(EXTRA_ALLOWED_APPS) : null;
        disallowedApps = intent != null ? intent.getStringArrayExtra(EXTRA_DISALLOWED_APPS) : null;

        if (shareUri == null || shareUri.isEmpty()) {
            Log.e(TAG, "Missing share URI");
            stopSelf();
            return START_NOT_STICKY;
        }

        FragmentOptions fragment = parseFragment(fragmentJson);
        startForeground(1, buildNotification("در حال اتصال..."));

            new Thread(() -> startVpn(shareUri, dnsIp, cleanIp, fragment, strictDns), "Mir2RayVpnThread").start();
        return START_STICKY;
    }

    private synchronized void startVpn(String shareUri, String dnsIp, String cleanIp, FragmentOptions fragment, boolean strictDns) {
        try {
            if (running || XrayCoreManager.isRunning() || vpnInterface != null) {
                Log.i(TAG, "Restarting VPN with a new config");
                stopVpn(false);
                try {
                    Thread.sleep(250);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }

            String configJson = V2rayConfigBuilder.build(this, shareUri, dnsIp, cleanIp, fragment, strictDns);
            Log.d(TAG, "Xray config length: " + configJson.length());

            ParcelFileDescriptor tun = establishVpnInterface(dnsIp, strictDns);
            if (tun == null) {
                throw new IllegalStateException("Failed to establish VPN interface");
            }

            vpnInterface = tun;
            running = true;
            XrayCoreManager.startLoop(configJson, tun.getFd());

            if (!XrayCoreManager.isRunning()) {
                throw new IllegalStateException("Xray core is not running after start");
            }

            updateNotification("متصل — Mir2rayV2");
            Log.i(TAG, "VPN + Xray core running (tun fd=" + tun.getFd() + ")");
        } catch (Exception e) {
            Log.e(TAG, "Error starting VPN", e);
            LogCollector.append(getApplicationContext(), "Error starting VPN: " + e.toString());
            stopVpn();
        }
    }

    private ParcelFileDescriptor establishVpnInterface(String dnsIp, boolean strictDns) {
        try {
            // Try adaptive MTU values: prefer 1500, fallback to lower MTUs for mobile networks
            int[] mtuCandidates = new int[] {1500, 1420, 1360};
            for (int mtu : mtuCandidates) {
                try {
                    Builder b = new Builder();
                    b.setSession("Mir2rayV2");
                    b.setMtu(mtu);
                    b.addAddress(VPN_CLIENT_IP, VPN_PREFIX);
                    b.addRoute("0.0.0.0", 0);
                    b.addRoute("::", 0);

                    boolean hasSelectedDns = dnsIp != null && !dnsIp.isEmpty();
                    if (hasSelectedDns) {
                        b.addDnsServer(dnsIp);
                    }
                    if (!strictDns || !hasSelectedDns) {
                        b.addDnsServer("8.8.8.8");
                        b.addDnsServer("1.1.1.1");
                    }

                    // Apply split-tunnel package lists if provided (from stored intent extras)
                    try {
                        if (allowedApps != null) {
                            for (String pkg : allowedApps) {
                                try { b.addAllowedApplication(pkg); } catch (Exception ex) { Log.w(TAG, "Failed to addAllowedApplication: " + pkg, ex); }
                            }
                        }
                        if (disallowedApps != null) {
                            for (String pkg : disallowedApps) {
                                try { b.addDisallowedApplication(pkg); } catch (Exception ex) { Log.w(TAG, "Failed to addDisallowedApplication: " + pkg, ex); }
                            }
                        }
                    } catch (Exception e) {
                        Log.w(TAG, "Error applying split-tunnel lists", e);
                    }

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        b.setMetered(false);
                    }

                    // Xray runs in this process — keep outbound sockets off the VPN tunnel (anti-loop).
                    try { b.addDisallowedApplication(getPackageName()); } catch (Exception e) { Log.w(TAG, "Could not disallow own app from VPN", e); }

                    ParcelFileDescriptor pd = b.establish();
                    if (pd != null) {
                        Log.i(TAG, "Established VPN with MTU=" + mtu + ", dns=" + (hasSelectedDns ? dnsIp : "fallback") + ", strictDns=" + strictDns);
                        return pd;
                    }
                } catch (Exception e) {
                    Log.w(TAG, "MTU " + mtu + " failed, trying next", e);
                }
            }

            // If none succeeded return null
            return null;
        } catch (Exception e) {
            Log.e(TAG, "VPN establish failed", e);
            return null;
        }
    }

    private synchronized void stopVpn() {
        stopVpn(true);
    }

    private synchronized void stopVpn(boolean stopService) {
        running = false;
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
            stopSelf();
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
        Intent stopIntent = new Intent(this, Mir2RayVpnService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPendingIntent = PendingIntent.getService(
                this,
                0,
                stopIntent,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                        : PendingIntent.FLAG_UPDATE_CURRENT
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Mir2rayV2 VPN")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_secure)
                .setOngoing(true)
                .addAction(new NotificationCompat.Action(
                        android.R.drawable.ic_menu_close_clear_cancel,
                        "قطع VPN",
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
        XrayCoreManager.unbindVpnService(this);
        super.onDestroy();
        stopVpn();
    }
}
