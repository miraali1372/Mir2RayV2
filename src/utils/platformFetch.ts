import Xray from '../plugins/xray';
import { isWindowsDesktop } from './platform';

export async function fetchTextResource(
  url: string,
  options: { timeoutMs?: number; cache?: RequestCache } = {}
): Promise<{ ok: boolean; status: number; text: string; message?: string }> {
  if (isWindowsDesktop()) {
    return Xray.fetchText({ url, timeoutMs: options.timeoutMs });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await fetch(url, { cache: options.cache ?? 'no-store', signal: controller.signal });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, text: '', message: error instanceof Error ? error.message : 'Request failed' };
  } finally {
    clearTimeout(timer);
  }
}
