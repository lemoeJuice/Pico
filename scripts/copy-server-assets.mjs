import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist/server/executor', { recursive: true });
await copyFile('src/executor/container-supervisor.mjs', 'dist/server/executor/container-supervisor.mjs');
