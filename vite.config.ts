import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Phase B (Elah): @elah/core's exportVideo.js spawns its worker with
//   new Worker(new URL('./ExportWorker.ts', import.meta.url), ...)
// but the package actually ships ExportWorker.js (the .ts source is not
// published). Rewrite the specifier so Vite can resolve + bundle the worker.
function fixElahExportWorker(): Plugin {
  return {
    name: 'fix-elah-export-worker',
    enforce: 'pre',
    transform(code, id) {
      if (id.includes('@elah/core') && code.includes('./ExportWorker.ts')) {
        return {
          code: code.replace(/\.\/ExportWorker\.ts/g, './ExportWorker.js'),
          map: null,
        };
      }
      return null;
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [fixElahExportWorker(), react()],
  // Let Vite handle @elah/core at source level so the
  // new Worker(new URL(...)) idiom is detected and bundled correctly
  // (pre-bundling would flatten import.meta.url and break the worker URL).
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
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
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
