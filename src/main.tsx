import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Capacitor} from '@capacitor/core';
import App from './App.tsx';
import './index.css';
import { isNativeRuntime } from './utils/platform';

async function configureServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  if (!isNativeRuntime() && !Capacitor.isNativePlatform()) {
    await navigator.serviceWorker.register('/sw.js');
    return;
  }

  // Capacitor bundles immutable web assets inside the APK. A PWA service worker in the native
  // WebView can serve stale files after an app update and has no offline benefit here.
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map(registration => registration.unregister()));
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map(key => caches.delete(key)));
  }
}

void configureServiceWorker().catch(() => {
  // App startup must not depend on optional cache cleanup.
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
