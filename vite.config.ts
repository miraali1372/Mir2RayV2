import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    base: './',
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: false,
        includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
        manifest: {
          name: 'Mir2rayV2',
          short_name: 'Mir2rayV2',
          description: 'A powerful V2Ray/Xray client for web and Android',
          theme_color: '#09090b',
          background_color: '#09090b',
          display: 'standalone',
          orientation: 'portrait',
          icons: [
            {
              src: 'pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png'
            }
          ]
        }
      })
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // Code splitting configuration to reduce chunk sizes
      rollupOptions: {
        output: {
          manualChunks: {
            // Vendor chunks
            'vendor-ui': ['lucide-react', 'motion', 'qrcode.react'],
            'vendor-virtuoso': ['react-virtuoso'],
            // Capacitor (only core for web, android is native only)
            'vendor-capacitor': ['@capacitor/core'],
            // Separate large utils
            'utils-dns': ['./src/utils/dnsCatalog.ts'],
            'utils-profile': ['./src/utils/profileQuality.ts', './src/utils/parseUri.ts'],
            'utils-vpn': ['./src/utils/vpnPayload.ts', './src/utils/appStorage.ts'],
          },
          // Optimize chunk file names
          chunkFileNames: 'assets/js/[name]-[hash].js',
          entryFileNames: 'assets/js/[name]-[hash].js',
          assetFileNames: (assetInfo) => {
            const name = assetInfo.name ?? '';
            const info = name.split('.');
            const ext = info[info.length - 1];
            if (/\.(png|jpe?g|gif|svg|webp|ico)$/.test(name)) {
              return `assets/images/[name]-[hash].${ext}`;
            }
            if (/\.(css)$/.test(name)) {
              return `assets/css/[name]-[hash].${ext}`;
            }
            return `assets/[ext]/[name]-[hash].${ext}`;
          },
        },
      },
      // Chunk size warning limit (in KB)
      chunkSizeWarningLimit: 500,
      // Minification options
      minify: 'esbuild',
      esbuild: {
        drop: ['console', 'debugger'],
        pure: ['console.log', 'console.debug'],
      },
      // CSS code splitting
      cssCodeSplit: true,
      // Generate sourcemaps for debugging (disable in production if needed)
      sourcemap: false,
      // Module preload polyfill
      modulePreload: {
        polyfill: true,
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env['DISABLE_HMR'] !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env['DISABLE_HMR'] === 'true' ? null : {
        ignored: [
          '**/android/.gradle/**',
          '**/android/build/**',
          '**/android/app/build/**',
          '**/dist/**',
          '**/release-output/**',
          '**/tmp/**',
          '**/tmp_libv2ray/**',
        ],
      },
    },
  };
});
