import { Capacitor } from '@capacitor/core';
import Xray from '../plugins/xray';

const DEFAULT_DELAY_TEST_URLS = [
  'https://cp.cloudflare.com/generate_204',
  'https://www.google.com/generate_204',
  'http://connectivitycheck.gstatic.com/generate_204',
];

/**
 * Real latency test.
 * Android: TCP connect via native plugin.
 * Web: best-effort fetch timing (limited by CORS).
 */
export async function testLatencyReal(
  ipOrHost: string,
  port: string | number = 443,
  timeoutMs: number = 2000
): Promise<number | 'error'> {
  const host = (ipOrHost || '').trim();
  if (!host) return 'error';

  const portNum = typeof port === 'string' ? parseInt(port, 10) || 443 : port;

  if (Capacitor.getPlatform() === 'android') {
    try {
      const result = await Xray.pingHost({ host, port: portNum, timeout: timeoutMs });
      if (result.ok && typeof result.latency === 'number' && result.latency >= 0) {
        return result.latency;
      }
      return 'error';
    } catch {
      return 'error';
    }
  }

  const start = performance.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    await fetch(`https://${host}:${portNum}/`, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    }).catch(() => {});
    clearTimeout(timeoutId);
    const elapsed = Math.floor(performance.now() - start);
    if (elapsed < 5) return 'error';
    return elapsed >= timeoutMs ? 'error' : elapsed;
  } catch {
    return 'error';
  }
}

export async function testCdnIpDirect(
  ip: string,
  timeoutMs: number = 2500
): Promise<number | 'error'> {
  if (!ip) return 'error';
  if (Capacitor.getPlatform() !== 'android') return 'error';
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs + 1000);
  
  try {
    // Direct TCP ping to IP at port 443 or 80
    const result = await Promise.race([
      Xray.pingHost({ host: ip, port: 443, timeout: timeoutMs }),
      new Promise<any>((_, reject) => 
        setTimeout(() => reject(new Error('Ping timeout')), timeoutMs + 500)
      )
    ]);
    
    clearTimeout(timeoutId);
    if (result.ok && typeof result.latency === 'number' && result.latency >= 0) {
      return result.latency;
    }
    return 'error';
  } catch (e) {
    clearTimeout(timeoutId);
    console.warn('testCdnIpDirect error for', ip, e);
    return 'error';
  }
}

export async function measureConfigDelay(
  shareUri: string,
  dnsIp?: string,
  cleanIp?: string,
  timeoutMs: number = 2000,
  maxLatencyMs: number = -1,
  strictDns: boolean = false,
  testUrls: string[] = DEFAULT_DELAY_TEST_URLS
): Promise<number | 'error'> {
  if (Capacitor.getPlatform() !== 'android') return 'error';

  for (const testUrl of testUrls) {
    try {
      const result = await Xray.measureConfigDelay({
        shareUri,
        dnsIp,
        cleanIp,
        strictDns,
        timeoutMs,
        maxLatencyMs,
        testUrl,
      });
      if (result.ok && typeof result.latency === 'number' && result.latency >= 0) {
        return result.latency;
      }
    } catch (e) {
      console.warn('measureConfigDelay failed for testUrl:', testUrl, e);
    }
  }
  return 'error';
}
