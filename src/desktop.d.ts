export {};

declare global {
  interface Window {
    mir2rayDesktop?: {
      platform: 'windows';
      invoke<T = unknown>(method: string, options?: unknown): Promise<T>;
    };
  }
}
