export const YOUTUBE_DELAY_TEST_URL = 'https://www.youtube.com/generate_204';
export const GOOGLE_DELAY_TEST_URL = 'https://www.google.com/generate_204';
export const INSTAGRAM_DELAY_TEST_URL = 'https://www.facebook.com/generate_204';

export const CONFIG_DELAY_TEST_URL = GOOGLE_DELAY_TEST_URL;
export const CONFIG_REAL_DELAY_TEST_URL = CONFIG_DELAY_TEST_URL;
export const META_REAL_DELAY_TEST_URL = INSTAGRAM_DELAY_TEST_URL;
export const CONFIG_REAL_DELAY_TEST_URLS = [
  'https://www.youtube.com/generate_204',  // YouTube (Google CDN)
  'https://www.google.com/generate_204',   // Google One / Drive / Search
  'https://www.facebook.com/generate_204', // Instagram & Meta network
] as const;

// Multi-stream download targets — ALL must return real body bytes (not 204).
// The native layer opens 3 parallel TCP connections to simulate Instagram/YouTube/Google One
// multi-stream media fetching and report the aggregate channel bandwidth.
//
// ⚠ Do NOT use gstatic.com/generate_204 — it returns HTTP 204 (zero body)
//   which contributes 0 bytes and makes aggregate scores wrong.
export const DOWNLOAD_TEST_URL = 'https://speed.cloudflare.com/__down?bytes=524288';
export const MULTISTREAM_DOWNLOAD_URLS = [
  'https://speed.cloudflare.com/__down?bytes=524288', // 512 KB – Cloudflare (Instagram CDN)
  'https://speed.cloudflare.com/__down?bytes=262144', // 256 KB – Cloudflare alt TCP
  'https://speed.cloudflare.com/__down?bytes=393216', // 384 KB – Cloudflare edge
] as const;
export const DNS_DOWNLOAD_TEST_URL = DOWNLOAD_TEST_URL;
// ~1.15 MB aggregate across 3 parallel streams — well past TCP slow-start on all connections
export const DOWNLOAD_TEST_BYTES = 512 * 1024;
export const UPLOAD_TEST_BYTES = 1280 * 1024; // 1.25 MB (> 1 MB)
export const UPLOAD_TEST_URL = 'https://www.gstatic.com/generate_204';
export const MIN_CONFIG_BANDWIDTH_BPS = 100_000;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 8_000;

export function getTestHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'www.gstatic.com';
  }
}
