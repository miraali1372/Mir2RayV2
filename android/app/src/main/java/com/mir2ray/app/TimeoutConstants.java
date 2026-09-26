package com.mir2ray.app;

/**
 * Centralized timeout constants for the Android native layer.
 * Mirrors the TypeScript constants in src/constants/timeouts.ts
 * Keep both files in sync when updating timeouts.
 */
public final class TimeoutConstants {
    private TimeoutConstants() {}

    // Network timeouts (in milliseconds)
    public static final int CONNECT_TIMEOUT_MS = 10_000;
    public static final int CONNECT_TIMEOUT_LONG_MS = 20_000;
    public static final int READ_TIMEOUT_MS = 15_000;
    public static final int READ_TIMEOUT_LONG_MS = 60_000;
    public static final int DNS_RESOLVE_TIMEOUT_MS = 2_500;

    // VPN operations
    public static final long VPN_START_WAIT_TIMEOUT_MS = 12_000L;
    public static final long VPN_START_WAIT_INTERVAL_MS = 150L;

    // Config testing
    public static final int CONFIG_DELAY_TEST_TIMEOUT_MS = 2_500;
    public static final int CONFIG_DELAY_TEST_MAX_TIMEOUT_MS = 4_000;
    public static final int CONFIG_DELAY_TEST_MIN_TIMEOUT_MS = 800;

    // Bandwidth testing
    public static final int BANDWIDTH_TEST_TIMEOUT_MS = 6_000;
    public static final int DOWNLOAD_TEST_TIMEOUT_MS = 6_000;

    // Geo assets download
    public static final int GEO_DOWNLOAD_CONNECT_TIMEOUT_MS = 20_000;
    public static final int GEO_DOWNLOAD_READ_TIMEOUT_MS = 60_000;

    // GitHub API
    public static final int GITHUB_API_TIMEOUT_MS = 8_000;
    public static final int GITHUB_RELEASE_TIMEOUT_MS = 15_000;

    // Public IP check
    public static final int PUBLIC_IP_TIMEOUT_MS = 4_000;

    // Thread pool sizes
    public static final int DELAY_TEST_THREADS_MAX = 128;
    public static final int DELAY_TEST_THREADS_MIN = 3;
    public static final int NATIVE_DELAY_THREADS = 16;
    public static final int BANDWIDTH_THREADS_MAX = 4;
    public static final int BANDWIDTH_THREADS_MIN = 2;

    // Queue sizes
    public static final int DELAY_TEST_QUEUE_SIZE = 256;
    public static final int NATIVE_DELAY_QUEUE_SIZE = 128;

    // Test URLs
    public static final String DELAY_TEST_URL = "https://cp.cloudflare.com/generate_204";
    public static final String DOWNLOAD_TEST_URL = "https://cachefly.cachefly.net/1mb.test";
    public static final String DNS_DOWNLOAD_TEST_URL = "https://cachefly.cachefly.net/1mb.test";
    public static final String UPLOAD_TEST_URL = "https://www.gstatic.com/generate_204";
    public static final int DOWNLOAD_TEST_BYTES = 192 * 1024;
    public static final int UPLOAD_TEST_BYTES = 32 * 1024;

    // Geo mirrors
    public static final String[] GEOIP_MIRRORS = {
        "https://cdn.jsdelivr.net/gh/chocolate4u/Iran-v2ray-rules@release/geoip.dat",
        "https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/geoip.dat",
        "https://ghproxy.net/https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/geoip.dat"
    };

    public static final String[] GEOSITE_MIRRORS = {
        "https://cdn.jsdelivr.net/gh/chocolate4u/Iran-v2ray-rules@release/geosite.dat",
        "https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/geosite.dat",
        "https://ghproxy.net/https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/geosite.dat"
    };

    public static final long MIN_GEO_BYTES = 100_000;

    // Computed thread counts based on available processors
    public static int computeDelayTestThreads() {
        return DELAY_TEST_THREADS_MAX;
    }

    public static int computeNativeDelayThreads() {
        return NATIVE_DELAY_THREADS;
    }

    public static int computeBandwidthThreads() {
        return Math.max(BANDWIDTH_THREADS_MIN, Math.min(BANDWIDTH_THREADS_MAX, Runtime.getRuntime().availableProcessors()));
    }
}
