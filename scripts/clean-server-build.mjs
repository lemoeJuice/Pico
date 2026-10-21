import { rm } from 'node:fs/promises';

// TypeScript does not remove stale outputs from modules no longer reachable by the server entrypoint.
await rm('dist/server', { recursive: true, force: true });
