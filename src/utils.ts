import { V2RayConfig, DnsServer } from './types';

export { parseV2rayUri, splitConfigLines } from './utils/parseUri';
export { testLatencyReal, measureConfigDelay, testCdnIpDirect } from './utils/latency';
export { loadDnsCatalog } from './utils/dnsCatalog';

function safeDecode(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch (e) {
    return str;
  }
}

// Generate some sample DNS servers including Iranian anti-sanction ones
export const iranianAntiSanctionDnsServers = [
  // Global / Custom Fast
  { ip: '1.1.1.1', provider: 'Cloudflare', category: 'global' },
  { ip: '1.0.0.1', provider: 'Cloudflare', category: 'global' },
  { ip: '8.8.8.8', provider: 'Google', category: 'global' },
  { ip: '8.8.4.4', provider: 'Google', category: 'global' },
  { ip: '9.9.9.9', provider: 'Quad9', category: 'global' },
  { ip: '149.112.112.112', provider: 'Quad9', category: 'global' },
  { ip: '208.67.222.222', provider: 'OpenDNS', category: 'global' },
  { ip: '208.67.220.220', provider: 'OpenDNS', category: 'global' },
  { ip: '94.140.14.14', provider: 'AdGuard', category: 'global' },
  { ip: '94.140.15.15', provider: 'AdGuard', category: 'global' },
  { ip: '8.26.56.26', provider: 'Comodo', category: 'global' },
  { ip: '8.20.247.20', provider: 'Comodo', category: 'global' },
  { ip: '64.6.64.6', provider: 'Verisign', category: 'global' },
  { ip: '64.6.65.6', provider: 'Verisign', category: 'global' },
  { ip: '209.244.0.3', provider: 'Level3', category: 'global' },
  { ip: '209.244.0.4', provider: 'Level3', category: 'global' },
  { ip: '84.200.69.80', provider: 'DNS.WATCH', category: 'global' },
  { ip: '84.200.70.40', provider: 'DNS.WATCH', category: 'global' },
  { ip: '185.228.168.9', provider: 'CleanBrowsing', category: 'global' },
  { ip: '185.228.169.9', provider: 'CleanBrowsing', category: 'global' },
  { ip: '76.76.19.19', provider: 'Alternate DNS', category: 'global' },
  { ip: '76.223.122.150', provider: 'Alternate DNS', category: 'global' },
  { ip: '9.9.9.10', provider: 'Quad9 (No Malware)', category: 'global' },
  { ip: '1.1.1.2', provider: 'Cloudflare (Security)', category: 'global' },
  { ip: '1.1.1.3', provider: 'Cloudflare (Family)', category: 'global' },
  
  // Iran Anti-Sanction
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

/** @deprecated use loadDnsCatalog from utils/dnsCatalog */
export async function fetchPublicDns(): Promise<DnsServer[]> {
  const { loadDnsCatalog } = await import('./utils/dnsCatalog');
  return loadDnsCatalog();
}

// Generate CDN IPs from public CDN prefix ranges and larger Iranian CDN ranges
// Known and publicly available CDN edge IPs that respond to ping
const KNOWN_CDN_IPS: Array<{ prefix: string; mask: number; provider: string }> = [
  // Cloudflare - Global Edge IPs (These are real, working IPs)
  { prefix: '173.245.48.0', mask: 20, provider: 'Cloudflare' },
  { prefix: '103.21.244.0', mask: 22, provider: 'Cloudflare' },
  { prefix: '103.22.200.0', mask: 22, provider: 'Cloudflare' },
  { prefix: '103.31.4.0', mask: 22, provider: 'Cloudflare' },
  { prefix: '141.101.64.0', mask: 18, provider: 'Cloudflare' },
  { prefix: '108.162.192.0', mask: 18, provider: 'Cloudflare' },
  { prefix: '190.93.240.0', mask: 20, provider: 'Cloudflare' },
  { prefix: '188.114.96.0', mask: 20, provider: 'Cloudflare' },
  { prefix: '197.234.240.0', mask: 22, provider: 'Cloudflare' },
  { prefix: '198.41.128.0', mask: 17, provider: 'Cloudflare' },
  { prefix: '162.158.0.0', mask: 15, provider: 'Cloudflare' },
  { prefix: '104.16.0.0', mask: 13, provider: 'Cloudflare' },
  { prefix: '104.24.0.0', mask: 14, provider: 'Cloudflare' },
  { prefix: '172.64.0.0', mask: 13, provider: 'Cloudflare' },
  { prefix: '131.0.72.0', mask: 22, provider: 'Cloudflare' },
  // Fastly
  { prefix: '151.101.0.0', mask: 16, provider: 'Fastly' },
  { prefix: '104.156.80.0', mask: 20, provider: 'Fastly' },
  // Akamai
  { prefix: '23.235.32.0', mask: 20, provider: 'Akamai' },
  { prefix: '96.17.0.0', mask: 16, provider: 'Akamai' },
  // Amazon CloudFront
  { prefix: '13.32.0.0', mask: 15, provider: 'Amazon CloudFront' },
  { prefix: '52.46.0.0', mask: 18, provider: 'Amazon CloudFront' },
  { prefix: '54.182.0.0', mask: 16, provider: 'Amazon CloudFront' },
  // Iran Local CDNs
  { prefix: '5.35.240.0', mask: 21, provider: 'Iran CDN - Afranet' },
  { prefix: '5.47.72.0', mask: 21, provider: 'Iran CDN - TPI' },
  { prefix: '5.62.192.0', mask: 18, provider: 'Iran CDN - ParsOnline' },
  { prefix: '31.24.112.0', mask: 21, provider: 'Iran CDN - Shatel' },
  { prefix: '46.174.0.0', mask: 16, provider: 'Iran CDN - Afranet' },
  { prefix: '77.104.0.0', mask: 13, provider: 'Iran CDN - Asiatech' },
  { prefix: '78.107.0.0', mask: 16, provider: 'Iran CDN - Asiatech' },
];

function ip2long(ip: string) {
  return ip.split('.').reduce((a, b) => (a << 8) + parseInt(b, 10), 0) >>> 0;
}

function long2ip(long: number) {
  return [(long >>> 24) & 255, (long >>> 16) & 255, (long >>> 8) & 255, long & 255].join('.');
}

// Generate a reasonable default number of CDN IP candidates to test.
// Instead of generating random IPs, we use known working IP ranges and pick edge IPs strategically.
export function generateCdnIps(totalCount: number = 300): Array<{ ip: string; provider: string }> {
  const ips: Array<{ ip: string; provider: string }> = [];
  const seen = new Set<string>();

  const ranges = KNOWN_CDN_IPS.map(cidr => {
    const start = ip2long(cidr.prefix);
    const end = start + Math.pow(2, 32 - cidr.mask) - 1;
    return { ...cidr, start, end };
  });

  // Generate IPs by selecting strategic edge points from each range
  for (let i = 0; i < totalCount; i++) {
    const range = ranges[Math.floor(Math.random() * ranges.length)];
    
    // Generate IPs more strategically - pick from first octets and strategic points
    let ipLong: number;
    const strategy = Math.random();
    
    if (strategy < 0.5) {
      // 50% chance: pick from start of range (actual edge servers)
      ipLong = range.start + Math.floor(Math.random() * Math.min(256, range.end - range.start + 1));
    } else {
      // 50% chance: pick from throughout range
      ipLong = range.start + Math.floor(Math.random() * (range.end - range.start + 1));
    }
    
    const ip = long2ip(ipLong);
    if (seen.has(ip)) continue;
    seen.add(ip);
    ips.push({ ip, provider: range.provider });
  }

  return ips;
}

export function generateExportUri(config: V2RayConfig, dns?: DnsServer | null): string {
  let uri = config.rawUri;
  
  if (config.type === 'vless' || config.type === 'trojan') {
    const match = uri.match(/^([a-z]+:\/\/)([^@]+)@([^:]+):(\d+)(.*)$/);
    if (!match) return uri;
    
    const [, protocol, id, address, port, rest] = match;
    let newAddress = config.cleanIp || address;
    
    let hashIndex = rest.indexOf('#');
    let queryParamsStr = hashIndex !== -1 ? rest.substring(0, hashIndex) : rest;
    let hashStr = hashIndex !== -1 ? rest.substring(hashIndex + 1) : '';
    
    let searchParams = new URLSearchParams(queryParamsStr.replace(/^\?/, ''));
    
    if (config.cleanIp) {
      if (!searchParams.has('sni') && address && !address.match(/^\d+\.\d+\.\d+\.\d+$/)) {
        searchParams.set('sni', address);
      }
      if (!searchParams.has('host') && address && !address.match(/^\d+\.\d+\.\d+\.\d+$/)) {
        searchParams.set('host', address);
      }
    }
    
    let newName = safeDecode(hashStr) || config.name || 'Config';
    if (config.cleanIp && !newName.includes('[CDN]')) newName += ` [CDN]`;
    if (dns && !newName.includes('[DNS]')) newName += ` [DNS:${dns.provider.split(' ')[0]}]`;
    
    const qs = searchParams.toString();
    const finalQs = qs ? `?${qs}` : '';
    const finalHash = newName ? `#${encodeURIComponent(newName)}` : '';
    
    return `${protocol}${id}@${newAddress}:${port}${finalQs}${finalHash}`;
  } else if (config.type === 'vmess') {
    const b64 = uri.replace('vmess://', '');
    try {
      const decoded = JSON.parse(atob(b64));
      if (config.cleanIp) {
        if (!decoded.sni) decoded.sni = decoded.add;
        if (!decoded.host) decoded.host = decoded.add;
        decoded.add = config.cleanIp;
      }
      if (config.cleanIp && !decoded.ps?.includes('[CDN]')) decoded.ps = (decoded.ps || '') + ` [CDN]`;
      if (dns && !decoded.ps?.includes('[DNS]')) decoded.ps = (decoded.ps || '') + ` [DNS:${dns.provider.split(' ')[0]}]`;
      
      return 'vmess://' + btoa(JSON.stringify(decoded));
    } catch (e) {
      return uri;
    }
  }
  
  return uri;
}
