package com.mir2ray.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.SystemClock;
import java.net.HttpURLConnection;
import java.net.URL;

final class VpnHealth {
    private static volatile long verifiedAt;
    private static volatile long latency = -1;
    private static volatile String verifiedNetwork = "";
    private static final java.util.concurrent.atomic.AtomicLong GENERATION = new java.util.concurrent.atomic.AtomicLong();
    private static final String[] TARGETS = {
        "https://connectivitycheck.gstatic.com/generate_204",
        "https://cp.cloudflare.com/generate_204"
    };

    static String networkKey(Context context) {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return "offline";
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            if (capabilities != null && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                    && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                return network.toString() + ":" + capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                        + ":" + capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR);
            }
        }
        return "offline";
    }

    static void reset() { GENERATION.incrementAndGet(); verifiedAt = 0; latency = -1; }

    static boolean validated(Context context) {
        return XrayCoreManager.isRunning() && verifiedAt > 0
                && SystemClock.elapsedRealtime() - verifiedAt < 20_000
                && verifiedNetwork.equals(networkKey(context));
    }

    static long latency() { return latency; }

    static synchronized boolean check(Context context, int timeoutMs) {
        if (!XrayCoreManager.isRunning()) { reset(); return false; }
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return false;
        Network vpn = null;
        boolean networkValidated = false;
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            if (capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                vpn = network;
                networkValidated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                break;
            }
        }
        if (vpn == null) return false;
        long started = SystemClock.elapsedRealtime();
        String key = networkKey(context);
        long generation = GENERATION.get();
        for (String target : TARGETS) {
            int remaining = timeoutMs - (int) (SystemClock.elapsedRealtime() - started);
            if (remaining < 200) break;
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) vpn.openConnection(new URL(target));
                connection.setConnectTimeout(Math.max(100, remaining / 2));
                connection.setReadTimeout(Math.max(100, remaining / 2));
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                connection.setRequestProperty("Cache-Control", "no-store");
                if (connection.getResponseCode() == 204 && key.equals(networkKey(context)) && generation == GENERATION.get()) {
                    latency = Math.max(1, SystemClock.elapsedRealtime() - started);
                    verifiedNetwork = key;
                    verifiedAt = SystemClock.elapsedRealtime();
                    return true;
                }
            } catch (Exception ignored) {
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
        if (networkValidated && generation == GENERATION.get()) {
            for (String target : TARGETS) {
                try {
                    long measured = BandwidthTestHelper.measureLiveDelay(target, Math.max(1000, timeoutMs / 2));
                    if (generation != GENERATION.get() || !key.equals(networkKey(context))) return false;
                    latency = measured;
                    verifiedNetwork = key;
                    verifiedAt = SystemClock.elapsedRealtime();
                    return true;
                } catch (Exception ignored) { }
            }
        }
        return false;
    }
}