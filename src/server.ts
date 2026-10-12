import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { PicoRuntime } from './runtime/runtime.js';
import { PicoStore } from './core/store.js';
import type { ExecutorKind, ModelSettings } from './core/types.js';
import type { PermissionPolicy } from './runtime/stages.js';

function bodyObject(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new Error('Request body must be a JSON object');
  }
  return request.body as Record<string, unknown>;
}

function requiredText(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

function notFound(response: Response, message = 'Not found'): void {
  response.status(404).json({ error: message });
}

export async function startServer(): Promise<{ close(): Promise<void>; runtime: PicoRuntime; port: number }> {
  const store = new PicoStore();
  const runtime = new PicoRuntime(store);
  await runtime.initialize();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_request, response) => response.json({ ok: true }));
  app.get('/api/info', (_request, response) => response.json({ defaultWorkspace: process.cwd(), version: '0.1.0' }));

  app.get('/api/projects', (_request, response) => response.json(runtime.listProjects()));
  app.post('/api/projects', async (request, response) => {
    const body = bodyObject(request);
    const project = await runtime.createProject(requiredText(body, 'name'), requiredText(body, 'workspacePath'));
    response.status(201).json(project);
  });
  app.get('/api/projects/:projectId/threads', (request, response) => {
    const project = runtime.listProjects().find((candidate) => candidate.id === request.params.projectId);
    if (!project) return notFound(response, 'Project not found');
    response.json(runtime.listThreads(project.id));
  });
  app.post('/api/projects/:projectId/threads', (request, response) => {
    const body = bodyObject(request);
    const kind = body.executorKind;
    if (kind !== 'container' && kind !== 'host') throw new Error('executorKind must be container or host');
    const thread = runtime.createThread(
      request.params.projectId!,
      kind as ExecutorKind,
      typeof body.title === 'string' ? body.title : 'New thread',
    );
    response.status(201).json(thread);
  });

  app.get('/api/threads', (request, response) => {
    const projectId = typeof request.query.projectId === 'string' ? request.query.projectId : undefined;
    response.json(runtime.listThreads(projectId));
  });
  app.get('/api/threads/:threadId', (request, response) => {
    const snapshot = runtime.getSnapshot(request.params.threadId!);
    if (!snapshot) return notFound(response, 'Thread not found');
    response.json(snapshot);
  });
  app.post('/api/threads/:threadId/messages', async (request, response) => {
    const body = bodyObject(request);
    const id = requiredText(body, 'id');
    const content = requiredText(body, 'content');
    response.json(await runtime.submit(request.params.threadId!, id, content));
  });
  app.post('/api/threads/:threadId/pause', (request, response) => {
    const thread = runtime.pause(request.params.threadId!);
    response.json(thread);
  });
  app.post('/api/threads/:threadId/continue', (request, response) => {
    const thread = runtime.continue(request.params.threadId!);
    response.json(thread);
  });
  app.post('/api/threads/:threadId/interrupt', async (request, response) => {
    const thread = await runtime.interrupt(request.params.threadId!);
    response.json(thread);
  });
  app.get('/api/threads/:threadId/executor', async (request, response) => {
    response.json(await runtime.executorStatus(request.params.threadId!));
  });
  app.get('/api/threads/:threadId/permissions', (request, response) => {
    response.json(runtime.toolPermissions(request.params.threadId!));
  });
  app.put('/api/threads/:threadId/permissions/:toolName', (request, response) => {
    const body = bodyObject(request);
    const policy = body.policy;
    if (policy !== 'allow' && policy !== 'deny' && policy !== 'ask')
      throw new Error('policy must be allow, ask, or deny');
    runtime.setToolPermission(request.params.threadId!, request.params.toolName!, policy as PermissionPolicy);
    response.json(runtime.toolPermissions(request.params.threadId!));
  });
  app.post('/api/approvals/:executionId', (request, response) => {
    const body = bodyObject(request);
    if (typeof body.allow !== 'boolean') throw new Error('allow must be a boolean');
    response.json(runtime.resolveApproval(request.params.executionId!, body.allow));
  });

  app.get('/api/settings/model', (_request, response) => response.json(runtime.publicModelSettings()));
  app.put('/api/settings/model', (request, response) => {
    const body = bodyObject(request);
    const update: Partial<ModelSettings> = {};
    if (typeof body.baseUrl === 'string') update.baseUrl = body.baseUrl;
    if (typeof body.model === 'string') update.model = body.model;
    if (typeof body.apiKey === 'string') update.apiKey = body.apiKey;
    if (typeof body.temperature === 'number') update.temperature = body.temperature;
    response.json(runtime.updateModelSettings(update));
  });
  app.get('/api/commands', (_request, response) => response.json(runtime.availableCommands()));
  app.get('/api/plugins', (_request, response) => response.json(runtime.pluginInfo()));

  const httpServer = createServer(app);
  const sockets = new Set<WebSocket>();
  const websocketServer = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/api/events') {
      if (production) socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) =>
      websocketServer.emit('connection', websocket, request),
    );
  });
  websocketServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.send(JSON.stringify({ type: 'connected' }));
    socket.on('close', () => sockets.delete(socket));
  });
  const unsubscribe = runtime.subscribe((event) => {
    const message = JSON.stringify(event);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  });

  let vite: import('vite').ViteDevServer | null = null;
  const production = process.env.NODE_ENV === 'production' || process.env.PICO_ENV === 'production';
  const clientBuild = resolve(process.cwd(), 'dist', 'client');
  if (production) {
    if (!existsSync(resolve(clientBuild, 'index.html')))
      throw new Error('Web build is missing. Run npm run build first.');
    app.use(express.static(clientBuild, { index: false }));
    app.use((request, response, next) => {
      if (request.path.startsWith('/api/')) return next();
      response.sendFile(resolve(clientBuild, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({
      server: { middlewareMode: true, hmr: { server: httpServer } },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }
  app.use('/api', (_request, response) => notFound(response, 'API route not found'));

  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message) ? 404 : 400;
    response.status(status).json({ error: message });
  };
  app.use(errors);

  const host = process.env.PICO_HOST ?? '127.0.0.1';
  const port = Number(process.env.PICO_PORT ?? '4173');
  await new Promise<void>((resolvePromise, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolvePromise();
    });
  });
  console.log(`Pico is ready at http://${host}:${port}`);
  if (runtime.pluginInfo().errors.length > 0) console.warn('Plugin load issues:', runtime.pluginInfo().errors);

  return {
    runtime,
    port,
    async close() {
      unsubscribe();
      for (const socket of sockets) socket.close();
      websocketServer.close();
      await new Promise<void>((resolvePromise) => httpServer.close(() => resolvePromise()));
      await vite?.close();
      runtime.store.close();
    },
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  startServer()
    .then(({ close }) => {
      const shutdown = (): void => {
        void close().finally(() => process.exit(0));
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    });
}
