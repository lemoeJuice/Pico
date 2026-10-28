import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: fileURLToPath(new URL('./webui/build/', import.meta.url)),
    emptyOutDir: true,
    lib: {
      entry: resolve(process.cwd(), 'src/plugins/openai-provider/webui.tsx'),
      name: 'PicoOpenAiProviderWebUi',
      formats: ['iife'],
      fileName: () => 'webui.js',
      cssFileName: 'webui',
    },
  },
});
