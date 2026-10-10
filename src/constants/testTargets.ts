import { DestinationPolicy } from '../types';

export const YOUTUBE_DELAY_TEST_URL = 'https:\x2f\x2fwww.youtube.com/generate_204';
export const GOOGLE_DELAY_TEST_URL = 'https:\x2f\x2fwww.google.com/generate_204';
export const INSTAGRAM_DELAY_TEST_URL = 'https:\x2f\x2fwww.facebook.com/generate_204';
export const AI_STUDIO_DELAY_TEST_URL = 'https:\x2f\x2fgenerativelanguage.googleapis.com/v1beta/models';
export const AI_STUDIO_TEST_URL = AI_STUDIO_DELAY_TEST_URL;

export const CONFIG_DELAY_TEST_URL = GOOGLE_DELAY_TEST_URL;
export const CONFIG_REAL_DELAY_TEST_URL = CONFIG_DELAY_TEST_URL;
export const META_REAL_DELAY_TEST_URL = INSTAGRAM_DELAY_TEST_URL;
export const CONFIG_REAL_DELAY_TEST_URLS = [
  'https:\x2f\x2fwww.youtube.com/generate_204',  /* YouTube (Google CDN) */
  'https:\x2f\x2fwww.google.com/generate_204',   /* Google One / Drive / Search */
  'https:\x2f\x2fwww.facebook.com/generate_204', /* Instagram & Meta network */
] as const;

// Destination target keys
export const TARGET_KEY_GOOGLE = 'google';
export const TARGET_KEY_YOUTUBE = 'youtube';
export const TARGET_KEY_META = 'meta';
export const TARGET_KEY_INSTAGRAM = 'instagram';
export const TARGET_KEY_AI_STUDIO = 'aiStudio';
export const TARGET_KEY_DOWNLOAD = 'download';
export const TARGET_KEY_CLOUDFLARE = 'cloudflare';

export const TARGET_KEYS = {
  GOOGLE: TARGET_KEY_GOOGLE,
  YOUTUBE: TARGET_KEY_YOUTUBE,
  META: TARGET_KEY_META,
  INSTAGRAM: TARGET_KEY_INSTAGRAM,
  AI_STUDIO: TARGET_KEY_AI_STUDIO,
  DOWNLOAD: TARGET_KEY_DOWNLOAD,
  CLOUDFLARE: TARGET_KEY_CLOUDFLARE,
} as const;

export type TargetKey = typeof TARGET_KEYS[keyof typeof TARGET_KEYS];

export const TARGET_URLS_BY_KEY: Record<string, string> = {
  google: GOOGLE_DELAY_TEST_URL,
  youtube: YOUTUBE_DELAY_TEST_URL,
  meta: META_REAL_DELAY_TEST_URL,
  instagram: INSTAGRAM_DELAY_TEST_URL,
  aiStudio: AI_STUDIO_DELAY_TEST_URL,
  download: 'https:\x2f\x2fspeed.cloudflare.com/__down?bytes=524288',
  cloudflare: 'https:\x2f\x2fspeed.cloudflare.com/__down?bytes=524288',
};

export const VERIFICATION_TIERS = {
  L4_TCP: 'l4_tcp',
  L7_HTTP: 'l7_http',
  L7_PAYLOAD: 'l7_payload',
  BASIC: 'basic',
  STANDARD: 'standard',
  STRICT: 'strict',
  FULL: 'full',
} as const;

// Required policy presets
export const REQUIRED_POLICY_DEFAULT: DestinationPolicy = {
  requiredDestinations: [TARGET_KEY_GOOGLE],
  minPassingDestinations: 1,
  requiredTier: 'l7_http',
  maxLatencyMs: 3500,
  failClosedCountry: true,
  requireAll: true,
};

export const REQUIRED_POLICY_INSTAGRAM: DestinationPolicy = {
  requiredDestinations: [TARGET_KEY_META],
  minPassingDestinations: 1,
  requiredTier: 'l7_http',
  maxLatencyMs: 3500,
  failClosedCountry: true,
  requireAll: true,
};

export const REQUIRED_POLICY_STREAMING: DestinationPolicy = {
  requiredDestinations: [TARGET_KEY_YOUTUBE, TARGET_KEY_DOWNLOAD],
  minPassingDestinations: 2,
  requiredTier: 'l7_payload',
  maxLatencyMs: 3000,
  minBytes: 256 * 1024,
  failClosedCountry: true,
  requireAll: true,
};

export const REQUIRED_POLICY_STRICT: DestinationPolicy = {
  requiredDestinations: [TARGET_KEY_GOOGLE, TARGET_KEY_META, TARGET_KEY_DOWNLOAD],
  minPassingDestinations: 3,
  requiredTier: 'l7_payload',
  maxLatencyMs: 2500,
  minBytes: 256 * 1024,
  failClosedCountry: true,
  requireAll: true,
};

// Multi-stream download targets — ALL must return real body bytes (not 204).
// The native layer opens 3 parallel TCP connections to simulate Instagram/YouTube/Google One
// multi-stream media fetching and report the aggregate channel bandwidth.
//
// ⚠ Do NOT use gstatic.com/generate_204 — it returns HTTP 204 (zero body)
//   which contributes 0 bytes and makes aggregate scores wrong.
export const DOWNLOAD_TEST_URL = 'https:\x2f\x2fspeed.cloudflare.com/__down?bytes=524288';
export const MULTISTREAM_DOWNLOAD_URLS = [
  'https:\x2f\x2fspeed.cloudflare.com/__down?bytes=524288', /* 512 KB – Cloudflare (Instagram CDN) */
  'https:\x2f\x2fspeed.cloudflare.com/__down?bytes=262144', /* 256 KB – Cloudflare alt TCP */
  'https:\x2f\x2fspeed.cloudflare.com/__down?bytes=393216', /* 384 KB – Cloudflare edge */
] as const;
export const DNS_DOWNLOAD_TEST_URL = DOWNLOAD_TEST_URL;
// ~1.15 MB aggregate across 3 parallel streams — well past TCP slow-start on all connections
export const DOWNLOAD_TEST_BYTES = 512 * 1024;
export const UPLOAD_TEST_BYTES = 1280 * 1024; // 1.25 MB (> 1 MB)
export const UPLOAD_TEST_URL = 'https:\x2f\x2fwww.gstatic.com/generate_204';
export const MIN_CONFIG_BANDWIDTH_BPS = 100_000;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 8_000;

export function getTestHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'www.gstatic.com';
  }
}

export function getTargetKeyForUrl(url: string): TargetKey | string {
  const host = getTestHost(url).toLowerCase();
  if (host.includes('youtube')) return TARGET_KEY_YOUTUBE;
  if (host.includes('facebook') || host.includes('instagram')) return TARGET_KEY_META;
  if (host.includes('google') || host.includes('gstatic')) return TARGET_KEY_GOOGLE;
  if (host.includes('cloudflare')) return TARGET_KEY_DOWNLOAD;
  return host;
}
