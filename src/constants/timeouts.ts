/**
 * Centralized timeout constants for the entire application.
 * This ensures consistent timeout values across TypeScript and Java code.
 * When updating timeouts, update them here and in the corresponding Java constants.
 */

// Network timeouts (in milliseconds)
export const TIMEOUTS = {
  // Connection timeouts
  CONNECT: 10_000,           // 10s - TCP connection timeout
  CONNECT_LONG: 20_000,      // 20s - For slow networks
  
  // Read/Response timeouts
  READ: 15_000,              // 15s - HTTP read timeout
  READ_LONG: 60_000,         // 60s - For large downloads
  
  // DNS resolution
  DNS_RESOLVE: 2_500,        // 2.5s - DNS resolution timeout
  
  // VPN operations
  VPN_START_WAIT: 12_000,    // 12s - Wait for VPN service to start
  VPN_START_INTERVAL: 150,   // 150ms - Polling interval for VPN start
  
  // Config testing
  CONFIG_DELAY_TEST: 3_500,  // 3.5s - Config delay test timeout
  CONFIG_DELAY_MAX: 5_000,  // 5s - Max config delay test timeout
  CONFIG_DELAY_MIN: 1_000,   // 1s - Min config delay test timeout
  
  // Bandwidth testing
  BANDWIDTH_TEST: 12_000,    // 12s - Bandwidth test timeout
  DOWNLOAD_TEST: 12_000,     // 12s - Download test timeout
  
  // Geo assets download
  GEO_DOWNLOAD_CONNECT: 20_000,  // 20s - Geo assets connect timeout
  GEO_DOWNLOAD_READ: 60_000,     // 60s - Geo assets read timeout
  
  // GitHub API
  GITHUB_API: 8_000,         // 8s - GitHub API timeout
  GITHUB_RELEASE: 15_000,    // 15s - GitHub release check timeout
  
  // Public IP check
  PUBLIC_IP: 4_000,          // 4s - Public IP check timeout
  
  // WebView/Capacitor
  WEBVIEW_LOAD: 30_000,      // 30s - WebView load timeout
} as const;

// Derived timeouts (for convenience)
export const DEFAULT_CONFIG_TEST_TIMEOUT_MS = TIMEOUTS.CONFIG_DELAY_TEST;
export const MIN_CONFIG_TEST_TIMEOUT_MS = TIMEOUTS.CONFIG_DELAY_MIN;
export const MAX_CONFIG_TEST_TIMEOUT_MS = TIMEOUTS.CONFIG_DELAY_MAX;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = TIMEOUTS.DOWNLOAD_TEST;
export const START_WAIT_TIMEOUT_MS = TIMEOUTS.VPN_START_WAIT;
export const START_WAIT_INTERVAL_MS = TIMEOUTS.VPN_START_INTERVAL;

// Test URLs
export const TEST_URLS = {
  DELAY: 'https://www.youtube.com/generate_204',
  DOWNLOAD: 'https://cachefly.cachefly.net/1mb.test',
  DNS_DOWNLOAD: 'https://cachefly.cachefly.net/1mb.test',
  DOWNLOAD_BYTES: 1_000_000,
} as const;

// Geo mirrors
export const GEO_MIRRORS = {
  GEOIP: [
    'https://cdn.jsdelivr.net/gh/chocolate4u/Iran-v2ray-rules@release/geoip.dat',
    'https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/geoip.dat',
    'https://ghproxy.net/https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/geoip.dat',
  ],
  GEOSITE: [
    'https://cdn.jsdelivr.net/gh/chocolate4u/Iran-v2ray-rules@release/geosite.dat',
    'https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/geosite.dat',
    'https://ghproxy.net/https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release/geosite.dat',
  ],
  MIN_BYTES: 100_000,
} as const;

// Thread pool sizes (based on CPU cores)
export const THREAD_POOLS = {
  DELAY_TEST_MAX: 40,
  DELAY_TEST_MIN: 3,
  NATIVE_DELAY_MAX: 40,
  NATIVE_DELAY_MIN: 2,
  BANDWIDTH_MAX: 1,
  BANDWIDTH_MIN: 1,
  UPDATE_EXECUTOR: 1,
  TIMEOUT_SCHEDULER: 1,
} as const;

// Queue sizes
export const QUEUE_SIZES = {
  DELAY_TEST: 200,
} as const;
