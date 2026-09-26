import Xray from '../plugins/xray';
import { isNativeRuntime } from './platform';

const PREFIX = 'mir2ray_';

function storageKey(key: string): string {
  return key.startsWith(PREFIX) ? key : `${PREFIX}${key}`;
}

export async function getAppValue(key: string): Promise<string | null> {
  const fullKey = storageKey(key);
  if (isNativeRuntime()) {
    const result = await Xray.getSecure({ key: fullKey });
    if (result.value !== undefined && result.value !== null) return result.value;
    if (typeof window !== 'undefined') {
      const legacyValue = window.localStorage.getItem(fullKey);
      if (legacyValue !== null) {
        try {
          await Xray.setSecure({ key: fullKey, value: legacyValue });
          window.localStorage.removeItem(fullKey);
        } catch (error) {
          console.warn('Legacy storage migration failed:', error);
        }
        return legacyValue;
      }
    }
    return null;
  }
  return typeof window !== 'undefined' ? window.localStorage.getItem(fullKey) : null;
}

export async function setAppValue(key: string, value: string): Promise<void> {
  const fullKey = storageKey(key);
  if (isNativeRuntime()) {
    try {
      await Xray.setSecure({ key: fullKey, value });
      if (typeof window !== 'undefined') window.localStorage.removeItem(fullKey);
      return;
    } catch (error) {
      console.warn('Secure storage write failed:', error);
      // VPN profiles contain credentials and must never fall back to plaintext storage.
      throw error;
    }
  }
  if (typeof window !== 'undefined') window.localStorage.setItem(fullKey, value);
}

export async function removeAppValue(key: string): Promise<void> {
  const fullKey = storageKey(key);
  if (isNativeRuntime()) {
    try {
      await Xray.removeSecure({ key: fullKey });
    } catch (error) {
      console.warn('Secure storage remove failed, mirroring to localStorage:', error);
    }
    if (typeof window !== 'undefined') window.localStorage.removeItem(fullKey);
    return;
  }
  if (typeof window !== 'undefined') window.localStorage.removeItem(fullKey);
}

export async function getJsonValue<T>(key: string, fallback: T): Promise<T> {
  const raw = await getAppValue(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn(`Could not parse stored JSON for ${key}:`, error);
    return fallback;
  }
}

export async function setJsonValue<T>(key: string, value: T): Promise<void> {
  await setAppValue(key, JSON.stringify(value));
}
