import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Never let an ordinary workspace build overwrite a published WebUI. */
export function webBuildOutputDirectory(root: string): string {
  const publishedMarkers = ['.pico-deploy-state.json', 'dist/client/releases', 'dist/plugin-ui'];
  return publishedMarkers.some((marker) => existsSync(join(root, marker))) ? 'dist/client-build' : 'dist/client';
}

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: webBuildOutputDirectory(process.cwd()),
    emptyOutDir: true,
  },
});
