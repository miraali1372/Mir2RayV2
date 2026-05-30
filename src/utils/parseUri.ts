import { V2RayConfig } from '../types';

function safeDecode(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function decodeBase64Vmess(payload: string): string {
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return atob(pad);
}

/** Split subscription / paste blob into individual share links. */
export function splitConfigLines(text: string): string[] {
  const decoded = (() => {
    const t = text.trim();
    if (t.includes('://')) return t;
    try {
      const d = atob(t.replace(/-/g, '+').replace(/_/g, '/'));
      if (d.includes('://')) return d;
    } catch {
      try {
        const pad = t + '='.repeat((4 - (t.length % 4)) % 4);
        const d2 = atob(pad);
        if (d2.includes('://')) return d2;
      } catch {
        /* keep original */
      }
    }
    return t;
  })();

  return decoded
    .split(/\s+/)
    .map((l) => l.trim())
    .filter((l) => l.includes('://'));
}

export function parseV2rayUri(uri: string): Partial<V2RayConfig> | null {
  try {
    const trimmed = uri.trim();
    if (!trimmed || !trimmed.includes('://')) return null;

    if (trimmed.startsWith('vless://')) {
      const match = trimmed.match(/^vless:\/\/([^@]+)@([^:?#]+):(\d+)/);
      if (!match) return null;
      const name = trimmed.split('#')[1] ? safeDecode(trimmed.split('#')[1]) : 'VLESS';
      return {
        type: 'vless',
        address: match[2],
        port: match[3],
        name,
        rawUri: trimmed,
      };
    }

    if (trimmed.startsWith('vmess://')) {
      const payload = trimmed.replace('vmess://', '');
      if (payload.includes('?') && payload.includes('&')) {
        const m = trimmed.match(/^vmess:\/\/([^@]+)@([^:]+):(\d+)/);
        if (m) {
          return {
            type: 'vmess',
            address: m[2],
            port: m[3],
            name: safeDecode(trimmed.split('#')[1] || 'VMess'),
            rawUri: trimmed,
          };
        }
      }
      try {
        const decoded = JSON.parse(decodeBase64Vmess(payload));
        return {
          type: 'vmess',
          address: decoded.add || 'Unknown',
          port: String(decoded.port ?? ''),
          name: decoded.ps || 'VMess',
          rawUri: trimmed,
        };
      } catch {
        return null;
      }
    }

    if (trimmed.startsWith('trojan://')) {
      const match = trimmed.match(/^trojan:\/\/([^@]+)@([^:?#]+):(\d+)/);
      if (!match) return null;
      return {
        type: 'trojan',
        address: match[2],
        port: match[3],
        name: safeDecode(trimmed.split('#')[1] || 'Trojan'),
        rawUri: trimmed,
      };
    }

    if (trimmed.startsWith('ss://')) {
      const name = trimmed.includes('#') ? safeDecode(trimmed.split('#')[1]) : 'Shadowsocks';
      let host = 'Unknown';
      let port = '';
      try {
        const body = trimmed.slice(5);
        const decoded = body.includes('@') ? body : atob(body.replace(/-/g, '+').replace(/_/g, '/'));
        const normalized = decoded.includes('://') ? decoded : `ss://${decoded}`;
        const m = normalized.match(/@([^:]+):(\d+)/);
        if (m) {
          host = m[1];
          port = m[2];
        }
      } catch {
        return null;
      }
      return { type: 'shadowsocks', address: host, port, name, rawUri: trimmed };
    }

    if (trimmed.startsWith('hy2://') || trimmed.startsWith('hysteria2://')) {
      const match = trimmed.match(/^(?:hy2|hysteria2):\/\/([^@]+)@([^:?#]+):(\d+)/);
      if (!match) return null;
      return {
        type: 'hysteria2',
        address: match[2],
        port: match[3],
        name: safeDecode(trimmed.split('#')[1] || 'Hysteria2'),
        rawUri: trimmed,
      };
    }

    const proto = trimmed.split('://')[0]?.toLowerCase();
    if (['socks', 'socks5', 'http'].includes(proto)) {
      return {
        type: 'unknown',
        address: 'Proxy',
        port: '',
        name: proto.toUpperCase(),
        rawUri: trimmed,
      };
    }

    return null;
  } catch (err) {
    console.error('Failed to parse config', err);
    return null;
  }
}
