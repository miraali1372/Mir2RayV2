import { Capacitor } from '@capacitor/core';

export function isWindowsDesktop(): boolean {
  return typeof window !== 'undefined' && Boolean(window.mir2rayDesktop);
}

export function isNativeRuntime(): boolean {
  return Capacitor.getPlatform() === 'android' || isWindowsDesktop();
}

export function runtimePlatform(): 'android' | 'windows' | 'web' {
  if (Capacitor.getPlatform() === 'android') return 'android';
  return isWindowsDesktop() ? 'windows' : 'web';
}
