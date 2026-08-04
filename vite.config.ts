import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Elah is vendored as TS source under src/vendor/elah (see its README) so
  // we can fix a WebKit/Tauri-specific rendering bug. Vite reads the source
  // directly — no pre-bundling needed, and the `new Worker(new URL('./ExportWorker.ts', ...))`
  // idiom in core/src/export/exportVideo.ts is detected and bundled correctly
  // since the .ts file is real project source, not an npm package.
  optimizeDeps: {
    exclude: ['@elah/core', '@elah/editor', '@elah/timeline'],
  },
  // Elah's export worker is an ES module worker; emit it as ESM in dev + build.
  worker: {
    format: 'es',
  },
  // POC (Phase B): Elah's export worker needs SharedArrayBuffer, which requires
  // cross-origin isolation. Revisit if this breaks the asset: protocol.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Allow serving the Elah worker file from node_modules in dev mode.
    fs: {
      allow: ['..'],
    },
  },
  resolve: {
    alias: [
      // Elah, vendored under src/vendor/elah (see its README) — CSS sub-paths
      // must be listed before the bare package aliases so they match first.
      {
        find: '@elah/editor/styles/tokens.css',
        replacement: path.resolve(__dirname, './src/vendor/elah/editor/src/styles/tokens.css'),
      },
      {
        find: '@elah/editor/styles.css',
        replacement: path.resolve(__dirname, './src/vendor/elah/editor/dist/styles.css'),
      },
      { find: '@elah/core', replacement: path.resolve(__dirname, './src/vendor/elah/core/src/index.ts') },
      { find: '@elah/editor', replacement: path.resolve(__dirname, './src/vendor/elah/editor/src/index.ts') },
      { find: '@elah/timeline', replacement: path.resolve(__dirname, './src/vendor/elah/timeline/src/index.ts') },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-radix': [
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-collapsible',
            '@radix-ui/react-dialog',
            '@radix-ui/react-label',
            '@radix-ui/react-popover',
            '@radix-ui/react-progress',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-select',
            '@radix-ui/react-slider',
            '@radix-ui/react-slot',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
          ],
          'vendor-tauri': [
            '@tauri-apps/api',
            '@tauri-apps/plugin-dialog',
            '@tauri-apps/plugin-fs',
            '@tauri-apps/plugin-opener',
            '@tauri-apps/plugin-process',
            '@tauri-apps/plugin-shell',
            '@tauri-apps/plugin-updater',
          ],
          'vendor-icons': ['lucide-react'],
        },
      },
    },
  },
});
