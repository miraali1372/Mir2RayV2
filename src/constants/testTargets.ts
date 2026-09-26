export const CONFIG_DELAY_TEST_URL = 'https://cp.cloudflare.com/generate_204';
export const CONFIG_REAL_DELAY_TEST_URL = CONFIG_DELAY_TEST_URL;
export const META_REAL_DELAY_TEST_URL = 'https://www.gstatic.com/generate_204';
export const CONFIG_REAL_DELAY_TEST_URLS = [
  'https://cp.cloudflare.com/generate_204',
  'https://www.gstatic.com/generate_204',
  'https://connectivitycheck.gstatic.com/generate_204',
] as const;
export const DOWNLOAD_TEST_URL = 'https://cachefly.cachefly.net/1mb.test';
export const DNS_DOWNLOAD_TEST_URL = DOWNLOAD_TEST_URL;
export const DOWNLOAD_TEST_BYTES = 192 * 1024;
export const UPLOAD_TEST_BYTES = 32 * 1024;
export const UPLOAD_TEST_URL = 'https://www.gstatic.com/generate_204';
export const MIN_CONFIG_BANDWIDTH_BPS = 100_000;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5_000;

export function getTestHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'www.gstatic.com';
  }
}
