import { DnsServer } from '../types';

const IRAN_DNS: DnsServer[] = [
  { ip: '10.202.10.202', provider: 'Radar.game', category: 'iran' },
  { ip: '10.202.10.102', provider: 'Radar.game Alt', category: 'iran' },
  { ip: '178.22.122.100', provider: 'Shecan', category: 'iran' },
  { ip: '185.51.200.2', provider: 'Shecan Alt', category: 'iran' },
  { ip: '78.157.42.100', provider: 'Electro', category: 'iran' },
  { ip: '78.157.42.101', provider: 'Electro Alt', category: 'iran' },
  { ip: '10.200.10.200', provider: 'Vanu', category: 'iran' },
  { ip: '185.55.226.26', provider: 'Begzar', category: 'iran' },
  { ip: '185.55.225.25', provider: 'Begzar Alt', category: 'iran' },
];

const CACHE_KEY = 'mir2ray_dns_catalog_v4';
// Keep a compact, practical DNS catalog — curated public resolvers + Iranian helpers
const TARGET_SIZE = 60;

/** Known public resolver IPs (real DNS servers). */
const GLOBAL_DNS_SEEDS: Array<{ ip: string; provider: string }> = [
  { ip: '1.1.1.1', provider: 'Cloudflare' },
  { ip: '1.0.0.1', provider: 'Cloudflare' },
  { ip: '8.8.8.8', provider: 'Google' },
  { ip: '8.8.4.4', provider: 'Google' },
  { ip: '9.9.9.9', provider: 'Quad9' },
  { ip: '149.112.112.112', provider: 'Quad9' },
  { ip: '208.67.222.222', provider: 'OpenDNS' },
  { ip: '208.67.220.220', provider: 'OpenDNS' },
  { ip: '94.140.14.14', provider: 'AdGuard' },
  { ip: '94.140.15.15', provider: 'AdGuard' },
  { ip: '76.76.19.19', provider: 'Alternate DNS' },
  { ip: '76.223.122.150', provider: 'Alternate DNS' },
  { ip: '185.228.168.9', provider: 'CleanBrowsing' },
  { ip: '185.228.169.9', provider: 'CleanBrowsing' },
  { ip: '64.6.64.6', provider: 'Verisign' },
  { ip: '64.6.65.6', provider: 'Verisign' },
  { ip: '84.200.69.80', provider: 'DNS.WATCH' },
  { ip: '84.200.70.40', provider: 'DNS.WATCH' },
  { ip: '77.88.8.8', provider: 'Yandex' },
  { ip: '77.88.8.1', provider: 'Yandex' },
  { ip: '156.154.70.1', provider: 'Neustar' },
  { ip: '156.154.71.1', provider: 'Neustar' },
  { ip: '45.90.28.28', provider: 'NextDNS' },
  { ip: '45.90.30.30', provider: 'NextDNS' },
  { ip: '194.242.2.2', provider: 'Mullvad' },
  { ip: '194.242.2.3', provider: 'Mullvad' },
  { ip: '193.110.50.1', provider: 'Swiss Privacy' },
  { ip: '193.110.50.2', provider: 'Swiss Privacy' },
  { ip: '91.239.100.100', provider: 'UncensoredDNS' },
  { ip: '89.233.43.71', provider: 'DNS.WATCH' },
  { ip: '216.146.35.35', provider: 'Dyn' },
  { ip: '216.146.36.36', provider: 'Dyn' },
  { ip: '109.69.8.51', provider: 'OpenNIC' },
  { ip: '84.200.70.40', provider: 'DNS.WATCH' },
  { ip: '80.80.80.80', provider: 'Freenom' },
  { ip: '80.80.81.81', provider: 'Freenom' },
];

const REMOTE_DNS_LISTS = [
  'https://raw.githubusercontent.com/seedonn/Seedonn-Public-DNS/master/list/dns_list.txt',
  'https://raw.githubusercontent.com/opendns/public-dns-lists/master/opendns-public-dns-ipv4.txt',
];

function isIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

function parseIpLines(text: string): string[] {
  const ips: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
    if (match && isIpv4(match[1])) ips.push(match[1]);
  }
  return ips;
}

async function fetchRemoteDnsIps(): Promise<string[]> {
  const collected: string[] = [];
  for (const url of REMOTE_DNS_LISTS) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const text = await res.text();
      collected.push(...parseIpLines(text));
    } catch {
      /* network blocked — use seeds only */
    }
  }
  return collected;
}

function expandToTarget(ips: string[]): DnsServer[] {
  const seen = new Set<string>();
  const list: DnsServer[] = [];

  const push = (ip: string, provider: string, category: 'iran' | 'global') => {
    if (!isIpv4(ip) || seen.has(ip)) return;
    if (ip.startsWith('0.') || ip.startsWith('127.') || ip.startsWith('255.')) return;
    seen.add(ip);
    list.push({ ip, provider, category });
  };

  for (const d of IRAN_DNS) {
    push(d.ip, d.provider, 'iran');
  }
  for (const d of GLOBAL_DNS_SEEDS) {
    push(d.ip, d.provider, 'global');
  }
  for (const ip of ips) {
    push(ip, 'Public DNS', 'global');
    if (list.length >= TARGET_SIZE) break;
  }

  // If remote lists failed or are short, add a small curated set of widely-known resolvers
  const curated: Array<{ ip: string; provider: string }> = [
    { ip: '1.1.1.1', provider: 'Cloudflare' },
    { ip: '8.8.8.8', provider: 'Google' },
    { ip: '9.9.9.9', provider: 'Quad9' },
    { ip: '94.140.14.14', provider: 'AdGuard' },
    { ip: '185.228.168.9', provider: 'CleanBrowsing' },
    { ip: '208.67.222.222', provider: 'OpenDNS' },
    { ip: '45.90.28.28', provider: 'NextDNS' },
    { ip: '77.88.8.8', provider: 'Yandex' },
  ];

  for (const c of curated) {
    push(c.ip, c.provider, 'global');
    if (list.length >= TARGET_SIZE) break;
  }

  return list.slice(0, TARGET_SIZE);
}

export async function loadDnsCatalog(): Promise<DnsServer[]> {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as DnsServer[];
      if (parsed.length >= 1000) return parsed;
    }
  } catch {
    /* ignore */
  }

  const remote = await fetchRemoteDnsIps();
  const catalog = expandToTarget(remote);

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(catalog));
  } catch {
    /* quota */
  }

  return catalog;
}
