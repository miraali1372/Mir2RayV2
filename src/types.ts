export interface FragmentSettings {
  enabled: boolean;
  packets: string;
  length: string;
  interval: string;
}

export interface V2RayConfig {
  id: string;
  name: string;
  type: 'vless' | 'vmess' | 'trojan' | 'shadowsocks' | 'hysteria2' | 'unknown';
  address: string;
  port: string;
  ping?: number | 'error' | 'testing';
  downloadBps?: number | 'error' | 'testing';
  uploadBps?: number | 'error' | 'testing';
  rawUri: string;
  isSelected?: boolean;
  fragment?: FragmentSettings;
  cleanIp?: string; // Add this override to host/address
}

export interface DnsServer {
  ip: string;
  provider: string;
  category: 'iran' | 'global' | 'custom';
  latency?: number | 'error' | 'testing';
  downloadBps?: number | 'error' | 'testing';
  uploadBps?: number | 'error' | 'testing';
}

export type ViewState = 'dashboard' | 'profiles' | 'dns';
