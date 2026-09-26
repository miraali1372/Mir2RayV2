export interface FragmentSettings {
  enabled: boolean;
  packets: string;
  length: string;
  interval: string;
}

export interface V2RayConfig {
  id: string;
  name: string;
  type: 'vless' | 'vmess' | 'trojan' | 'shadowsocks' | 'hysteria2' | 'tuic' | 'unknown';
  address: string;
  port: string;
  ping?: number | 'error' | 'testing';
  tcpPing?: number | 'error' | 'testing';
  realDelay?: number | 'error' | 'testing';
  downloadBps?: number | 'error' | 'testing';
  uploadBps?: number | 'error' | 'testing';
  resolvedIp?: string;
  exitIp?: string;
  exitCountry?: string;
  qualityScore?: number;
  qualityUpdatedAt?: string;
  failStreak?: number;
  lastFailureAt?: string;
  lastSuccessAt?: string;
  latencyTestedAt?: string;
  bandwidthTestedAt?: string;
  verifiedAt?: string;
  measurementKey?: string;
  successCount?: number;
  failureCount?: number;
  retryAfter?: number;
  coldDelay?: number;
  jitter?: number;
  rawUri: string;
  isSelected?: boolean;
  fragment?: FragmentSettings;
  cleanIp?: string; // Add this override to host/address
  // Hysteria2/TUIC specific fields
  password?: string;
  sni?: string;
  alpn?: string;
  insecure?: boolean;
  obfs?: string;
  obfsPassword?: string;
  congestionControl?: string;
}

export interface DnsServer {
  ip: string;
  provider: string;
  category: 'iran' | 'global' | 'custom';
  latency?: number | 'error' | 'testing';
  configLatency?: number | 'error' | 'testing';
  downloadBps?: number | 'error' | 'testing';
  directDownloadBps?: number | 'error' | 'testing';
  configDownloadBps?: number | 'error' | 'testing';
  uploadBps?: number | 'error' | 'testing';
  directUploadBps?: number | 'error' | 'testing';
  configUploadBps?: number | 'error' | 'testing';
}

export type ViewState = 'dashboard' | 'profiles' | 'dns';
