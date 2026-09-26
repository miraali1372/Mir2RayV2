import { V2RayConfig } from '../types';

/**
 * Result of parsing a URI, including any warnings or errors
 */
export interface ParseResult {
  config: Partial<V2RayConfig> | null;
  warnings: string[];
  errors: string[];
}

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

/**
 * Parse query parameters from a URI
 */
function parseQueryParams(uri: string): Map<string, string> {
  const params = new Map<string, string>();
  try {
    const url = new URL(uri);
    url.searchParams.forEach((value, key) => {
      params.set(key, value);
    });
  } catch {
    // Fallback for URIs that don't parse as standard URLs
    const queryStart = uri.indexOf('?');
    if (queryStart >= 0) {
      const queryString = uri.substring(queryStart + 1);
      const hashStart = queryString.indexOf('#');
      const cleanQuery = hashStart >= 0 ? queryString.substring(0, hashStart) : queryString;
      cleanQuery.split('&').forEach(param => {
        const [key, value] = param.split('=');
        if (key) {
          params.set(decodeURIComponent(key), decodeURIComponent(value || ''));
        }
      });
    }
  }
  return params;
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

/**
 * Parse a single V2Ray URI with detailed error reporting
 */
export function parseV2rayUri(uri: string): ParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  
  try {
    const trimmed = uri.trim();
    if (!trimmed) {
      return { config: null, warnings, errors: ['Empty URI'] };
    }
    if (!trimmed.includes('://')) {
      return { config: null, warnings, errors: ['Invalid URI format: missing protocol'] };
    }

    // VLESS
    if (trimmed.startsWith('vless://')) {
      const match = trimmed.match(/^vless:\/\/([^@]+)@([^:?#]+):(\d+)/);
      if (!match) {
        return { config: null, warnings, errors: ['Invalid VLESS URI format'] };
      }
      const name = trimmed.split('#')[1] ? safeDecode(trimmed.split('#')[1]) : 'VLESS';
      return {
        config: {
          type: 'vless',
          address: match[2],
          port: match[3],
          name,
          rawUri: trimmed,
        },
        warnings,
        errors,
      };
    }

    // VMess
    if (trimmed.startsWith('vmess://')) {
      const payload = trimmed.replace('vmess://', '');
      // Standard VMess URI format (with query params)
      if (payload.includes('?') && payload.includes('&')) {
        const m = trimmed.match(/^vmess:\/\/([^@]+)@([^:]+):(\d+)/);
        if (m) {
          return {
            config: {
              type: 'vmess',
              address: m[2],
              port: m[3],
              name: safeDecode(trimmed.split('#')[1] || 'VMess'),
              rawUri: trimmed,
            },
            warnings,
            errors,
          };
        }
      }
      // Base64 encoded VMess
      try {
        const decoded = JSON.parse(decodeBase64Vmess(payload));
        if (!decoded.add) {
          warnings.push('VMess config missing address (add)');
        }
        if (!decoded.port) {
          warnings.push('VMess config missing port');
        }
        return {
          config: {
            type: 'vmess',
            address: decoded.add || 'Unknown',
            port: String(decoded.port ?? ''),
            name: decoded.ps || 'VMess',
            rawUri: trimmed,
          },
          warnings,
          errors,
        };
      } catch (e) {
        return { config: null, warnings, errors: ['Failed to parse VMess base64 payload'] };
      }
    }

    // Trojan
    if (trimmed.startsWith('trojan://')) {
      const match = trimmed.match(/^trojan:\/\/([^@]+)@([^:?#]+):(\d+)/);
      if (!match) {
        return { config: null, warnings, errors: ['Invalid Trojan URI format'] };
      }
      return {
        config: {
          type: 'trojan',
          address: match[2],
          port: match[3],
          name: safeDecode(trimmed.split('#')[1] || 'Trojan'),
          rawUri: trimmed,
        },
        warnings,
        errors,
      };
    }

    // Shadowsocks
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
        } else {
          warnings.push('Could not extract host/port from Shadowsocks URI');
        }
      } catch (e) {
        return { config: null, warnings, errors: ['Failed to parse Shadowsocks URI'] };
      }
      return {
        config: { type: 'shadowsocks', address: host, port, name, rawUri: trimmed },
        warnings,
        errors,
      };
    }

    // Hysteria2
    if (trimmed.startsWith('hy2://') || trimmed.startsWith('hysteria2://')) {
      const match = trimmed.match(/^(?:hy2|hysteria2):\/\/([^@]+)@([^:?#]+):(\d+)/);
      if (!match) {
        return { config: null, warnings, errors: ['Invalid Hysteria2 URI format'] };
      }
      // Parse query parameters for Hysteria2
      const queryParams = parseQueryParams(trimmed);
      return {
        config: {
          type: 'hysteria2',
          address: match[2],
          port: match[3],
          name: safeDecode(trimmed.split('#')[1] || 'Hysteria2'),
          rawUri: trimmed,
          password: queryParams.get('password') || queryParams.get('auth') || '',
          sni: queryParams.get('sni') || '',
          alpn: queryParams.get('alpn') || '',
          insecure: queryParams.get('insecure') === '1' || queryParams.get('allowInsecure') === '1',
          obfs: queryParams.get('obfs') || '',
          obfsPassword: queryParams.get('obfs-password') || '',
        },
        warnings,
        errors,
      };
    }

    // TUIC
    if (trimmed.startsWith('tuic://')) {
      const match = trimmed.match(/^tuic:\/\/([^@]+)@([^:?#]+):(\d+)/);
      if (!match) {
        return { config: null, warnings, errors: ['Invalid TUIC URI format'] };
      }
      // Parse query parameters for TUIC
      const queryParams = parseQueryParams(trimmed);
      return {
        config: {
          type: 'tuic',
          address: match[2],
          port: match[3],
          name: safeDecode(trimmed.split('#')[1] || 'TUIC'),
          rawUri: trimmed,
          password: queryParams.get('password') || queryParams.get('auth') || '',
          sni: queryParams.get('sni') || '',
          alpn: queryParams.get('alpn') || '',
          insecure: queryParams.get('insecure') === '1' || queryParams.get('allowInsecure') === '1',
          congestionControl: queryParams.get('congestion_control') || 'bbr',
        },
        warnings,
        errors,
      };
    }

    // Other proxy types (socks, http)
    const proto = trimmed.split('://')[0]?.toLowerCase();
    if (['socks', 'socks5', 'http'].includes(proto)) {
      return {
        config: {
          type: 'unknown',
          address: 'Proxy',
          port: '',
          name: proto.toUpperCase(),
          rawUri: trimmed,
        },
        warnings,
        errors,
      };
    }

    return { config: null, warnings, errors: [`Unsupported protocol: ${proto}`] };
  } catch (err) {
    console.error('Failed to parse config', err);
    return { config: null, warnings, errors: [`Parse exception: ${err}`] };
  }
}

/**
 * Parse multiple URIs and return successful configs with aggregated warnings/errors
 */
export function parseMultipleUris(uris: string[]): {
  configs: Partial<V2RayConfig>[];
  allWarnings: string[];
  allErrors: string[];
} {
  const configs: Partial<V2RayConfig>[] = [];
  const allWarnings: string[] = [];
  const allErrors: string[] = [];

  for (const uri of uris) {
    const result = parseV2rayUri(uri);
    if (result.config) {
      configs.push(result.config);
    }
    allWarnings.push(...result.warnings.map(w => `${uri}: ${w}`));
    allErrors.push(...result.errors.map(e => `${uri}: ${e}`));
  }

  return { configs, allWarnings, allErrors };
}
