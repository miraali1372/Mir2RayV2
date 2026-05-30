export const GITHUB_OWNER = 'miraali1372';
export const GITHUB_REPO = 'Mir2RayV2';

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  html_url: string;
  body?: string | null;
  assets: GitHubReleaseAsset[];
}

export interface AppVersionInfo {
  versionName: string;
  versionCode: number;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  latestReleaseUrl: string;
  releaseBody: string;
  assetName: string;
  downloadUrl: string;
}

const VERSION_PREFIX_RE = /^[^0-9]+/;

export function normalizeVersion(input: string): string {
  return (input || '')
    .trim()
    .replace(/^v/i, '')
    .replace(VERSION_PREFIX_RE, '');
}

function toParts(input: string): number[] {
  const normalized = normalizeVersion(input);
  if (!normalized) return [0];
  return normalized
    .split(/[.-]/)
    .map(part => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
}

export function compareVersions(left: string, right: string): number {
  const a = toParts(left);
  const b = toParts(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function formatVersion(input: string): string {
  const normalized = normalizeVersion(input);
  return normalized ? `v${normalized}` : 'v0.0.0';
}

export function pickApkAsset(release: GitHubRelease): GitHubReleaseAsset | null {
  const apkAssets = (release.assets || []).filter(asset => asset.name.toLowerCase().endsWith('.apk'));
  if (apkAssets.length === 0) return null;
  return (
    apkAssets.find(asset => asset.name.toLowerCase().includes('mir2rayv2')) ||
    apkAssets.find(asset => asset.name.toLowerCase().includes('release')) ||
    apkAssets[0]
  );
}

export async function fetchLatestRelease(
  owner: string = GITHUB_OWNER,
  repo: string = GITHUB_REPO,
  timeoutMs: number = 8000
): Promise<GitHubRelease> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub release fetch failed (${response.status})`);
    }
    return await response.json() as GitHubRelease;
  } finally {
    clearTimeout(timeout);
  }
}
