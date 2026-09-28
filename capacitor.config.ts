import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mir2ray.app',
  appName: 'Mir2rayV2',
  webDir: 'dist',
  // Capacitor's debug bridge logs complete plugin payloads, including VPN share credentials.
  loggingBehavior: 'none'
};

export default config;
