import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isLoopbackHost,
  AccessSessions,
  clearedSessionCookie,
  readSessionCookie,
  sameOrigin,
  sessionCookie,
} from './server-auth.js';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { attachModelDraftResume } from './server/model-draft-resume.js';
import { serveWorkspaceFile } from './server/workspace-file.js';
import { PicoRuntime } from './runtime/runtime.js';
import { ServiceError } from './contracts/service-error.js';
import { errorResponse, parserError } from './server-errors.js';
import type { McpServerInput } from './contracts/mcp.js';
import { currentExecutorVersion } from './executor/bundle.js';
import { PicoStore } from './core/store.js';
import {
  DEFAULT_THREAD_TITLE,
  type ContextManagementSettings,
  type ExecutorKind,
  type MiscellaneousSettings,
  type ThreadModelSelection,
} from './core/types.js';

function bodyObject(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new ServiceError(400, 'Request body must be a JSON object');
  }
  return request.body as Record<string, unknown>;
}

function requiredText(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new ServiceError(400, `${key} is required`);
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ServiceError(400, `${key} must be a boolean`);
  return value;
}

function parseMcpServerInput(body: Record<string, unknown>): McpServerInput {
  const name = requiredText(body, 'name');
  const transport = body.transport;
  const autoStart = optionalBoolean(body, 'autoStart');
  const visibleByDefault = optionalBoolean(body, 'visibleByDefault');
  if (transport === 'stdio') {
    const args = body.args === undefined ? [] : body.args;
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
      throw new ServiceError(400, 'args must be an array of strings');
    }
    const cwd = body.cwd;
    if (cwd !== undefined && typeof cwd !== 'string') throw new ServiceError(400, 'cwd must be a string');
    const env = body.env;
    if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env))) {
      throw new ServiceError(400, 'env must be an object of string values');
    }
    if (env && typeof env === 'object' && Object.values(env).some((value) => typeof value !== 'string')) {
      throw new ServiceError(400, 'env must be an object of string values');
    }
    return {
      name,
      transport,
      command: requiredText(body, 'command'),
      args: args as string[],
      ...(typeof cwd === 'string' && cwd.trim() ? { cwd: cwd.trim() } : {}),
      ...(env && typeof env === 'object' ? { env: env as Record<string, string> } : {}),
      ...(autoStart === undefined ? {} : { autoStart }),
      ...(visibleByDefault === undefined ? {} : { visibleByDefault }),
    };
  }
  if (transport === 'streamable-http') {
    const bearerToken = body.bearerToken;
    const clearBearerToken = optionalBoolean(body, 'clearBearerToken') ?? false;
    const confirmPrivateNetworkAccess = optionalBoolean(body, 'confirmPrivateNetworkAccess');
    if (bearerToken !== undefined && typeof bearerToken !== 'string') {
      throw new ServiceError(400, 'bearerToken must be a string');
    }
    if (clearBearerToken && typeof bearerToken === 'string' && bearerToken !== '') {
      throw new ServiceError(400, 'bearerToken cannot be set while clearBearerToken is true');
    }
    const url = requiredText(body, 'url');
    return {
      name,
      transport,
      url,
      // A blank field preserves the saved value unless the user explicitly asked to clear it.
      ...(clearBearerToken
        ? { bearerToken: '' }
        : typeof bearerToken === 'string' && bearerToken
          ? { bearerToken }
          : {}),
      ...(confirmPrivateNetworkAccess === undefined ? {} : { confirmPrivateNetworkAccess }),
      ...(autoStart === undefined ? {} : { autoStart }),
      ...(visibleByDefault === undefined ? {} : { visibleByDefault }),
    };
  }
  throw new ServiceError(400, 'transport must be stdio or streamable-http');
}

function notFound(response: Response, message = 'Not found'): void {
  response.status(404).json({ error: message, code: 'not_found' });
}

function pluginUiHeaders(request: Request, response: Response): void {
  const host = request.get('host');
  const protocol = request.protocol === 'https' ? 'https' : 'http';
  let requestOrigin = '';
  if (host && !/[/?#@\\]/.test(host)) {
    try {
      const parsedOrigin = new URL(`${protocol}://${host}`);
      if (!parsedOrigin.username && !parsedOrigin.password && parsedOrigin.pathname === '/') {
        requestOrigin = parsedOrigin.origin;
      }
    } catch {
      // Keep the existing self-only policy if the request Host is malformed.
    }
  }
  const appOrigin = requestOrigin && requestOrigin !== 'null' ? ` ${requestOrigin}` : '';
  response.set({
    'cache-control': 'no-cache',
    'content-security-policy': `default-src 'none'; script-src 'self'${appOrigin}; style-src 'self'${appOrigin} 'unsafe-inline'; img-src 'self'${appOrigin} data: blob:; font-src 'self'${appOrigin} data:; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
}

function pluginUiUnavailable(request: Request, response: Response): void {
  pluginUiHeaders(request, response);
  response
    .status(200)
    .type('html')
    .send(
      '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plugin UI unavailable</title><style>body{margin:0;padding:18px;color:#617066;background:transparent;font:13px system-ui,sans-serif}p{padding:14px;background:#f5f8f4;border:1px solid #e4ebe2;border-radius:12px;line-height:1.6}</style><p>This plugin has no Web UI assets installed. Install its UI bundle next to the Runtime plugin and reload Pico.</p></html>',
    );
}

function safeThemeAssetPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || /[\\%\0?#:]/.test(value)) return false;
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function isThemeImagePath(value: string): boolean {
  return ['.avif', '.gif', '.jpg', '.jpeg', '.png', '.svg', '.webp'].includes(
    value.slice(value.lastIndexOf('.')).toLowerCase(),
  );
}

async function servePluginUiAsset(
  runtime: PicoRuntime,
  request: Request,
  response: Response,
  production: boolean,
): Promise<void> {
  const pathname = new URL(request.originalUrl, 'http://pico.invalid').pathname;
  const match = /^\/_pico\/plugin-ui\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)(?:\/(.*))?$/.exec(pathname);
  if (!match) return notFound(response, 'Plugin UI asset not found');
  const pluginId = match[1]!;
  const entry = match[2]!;
  const rawAsset = match[3] || 'index.html';
  const segments: string[] = [];
  try {
    for (const rawSegment of rawAsset.split('/')) {
      const segment = decodeURIComponent(rawSegment);
      if (!segment || segment === '.' || segment === '..' || /[\\/\0]/.test(segment)) {
        return notFound(response, 'Plugin UI asset not found');
      }
      segments.push(segment);
    }
  } catch {
    return notFound(response, 'Plugin UI asset not found');
  }
  let location = runtime.plugins.webUiAssetLocation(pluginId, entry);
  if (!location) return notFound(response, 'Plugin UI asset not found');
  const currentAsset = segments[0] === 'current';
  const requestedSegments = currentAsset ? segments.slice(1) : segments;
  if (currentAsset && requestedSegments.length === 0) return notFound(response, 'Plugin UI asset not found');
  const deployedPackageRoot = resolve(process.cwd(), 'dist', 'plugin-ui', pluginId);
  const deployedAssetRoot = resolve(deployedPackageRoot, 'webui');
  if (
    production &&
    location.pluginsRoot === resolve(process.cwd(), 'plugins') &&
    existsSync(resolve(deployedAssetRoot, 'index.html'))
  ) {
    location = {
      pluginsRoot: resolve(process.cwd(), 'dist', 'plugin-ui'),
      packageRoot: deployedPackageRoot,
      assetRoot: deployedAssetRoot,
    };
  }
  if (currentAsset && production && location.pluginsRoot !== resolve(process.cwd(), 'dist', 'plugin-ui')) {
    return notFound(response, 'Plugin UI theme asset not found');
  }

  let safeRoot: string;
  let safeFile: string;
  try {
    const [safePluginsRoot, safePackageRoot] = await Promise.all([
      realpath(location.pluginsRoot),
      realpath(location.packageRoot),
    ]);
    const packageFromPluginsRoot = relative(safePluginsRoot, safePackageRoot);
    if (packageFromPluginsRoot !== pluginId) return notFound(response, 'Plugin UI asset not found');
    safeRoot = await realpath(location.assetRoot);
    if (relative(safePackageRoot, safeRoot) !== 'webui') return notFound(response, 'Plugin UI asset not found');
    let fileRoot = safeRoot;
    if (currentAsset) {
      let releaseRoot = safeRoot;
      if (production && location.pluginsRoot === resolve(process.cwd(), 'dist', 'plugin-ui')) {
        const stableIndex = await realpath(resolve(safeRoot, 'index.html'));
        const stableIndexRelative = relative(safeRoot, stableIndex);
        if (stableIndexRelative !== 'index.html' || !(await stat(stableIndex)).isFile()) {
          return notFound(response, 'Plugin UI theme asset not found');
        }
        const stableHtml = await readFile(stableIndex, 'utf8');
        const releaseMatch = /<!--\s*pico-plugin-ui-release:([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*-->/.exec(stableHtml);
        if (!releaseMatch) return notFound(response, 'Plugin UI theme asset not found');
        releaseRoot = await realpath(resolve(safeRoot, 'releases', releaseMatch[1]!));
        const releaseRelative = relative(safeRoot, releaseRoot);
        if (releaseRelative !== `releases${sep}${releaseMatch[1]}`) {
          return notFound(response, 'Plugin UI theme asset not found');
        }
      }
      const manifestPath = await realpath(resolve(releaseRoot, 'theme-assets.json'));
      const manifestRelative = relative(releaseRoot, manifestPath);
      if (manifestRelative !== 'theme-assets.json' || !(await stat(manifestPath)).isFile()) {
        return notFound(response, 'Plugin UI theme asset not found');
      }
      let manifest: unknown;
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      } catch {
        return notFound(response, 'Plugin UI theme asset not found');
      }
      const assetPath = requestedSegments.join('/');
      if (
        !manifest ||
        typeof manifest !== 'object' ||
        !('assets' in manifest) ||
        !Array.isArray(manifest.assets) ||
        !manifest.assets.every((asset) => safeThemeAssetPath(asset) && isThemeImagePath(asset)) ||
        !manifest.assets.includes(assetPath) ||
        !safeThemeAssetPath(assetPath) ||
        !isThemeImagePath(assetPath)
      ) {
        return notFound(response, 'Plugin UI theme asset not found');
      }
      fileRoot = releaseRoot;
      safeFile = await realpath(resolve(releaseRoot, ...requestedSegments));
    } else {
      safeFile = await realpath(resolve(safeRoot, ...requestedSegments));
    }
    const pathFromRoot = relative(fileRoot, safeFile);
    if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot.startsWith(sep)) {
      return notFound(response, 'Plugin UI asset not found');
    }
    if (!(await stat(safeFile)).isFile()) return notFound(response, 'Plugin UI asset not found');
  } catch {
    if (segments.length === 1 && segments[0] === 'index.html') return pluginUiUnavailable(request, response);
    return notFound(response, 'Plugin UI asset not found');
  }

  pluginUiHeaders(request, response);
  response.sendFile(safeFile, (error) => {
    if (error && !response.headersSent) notFound(response, 'Plugin UI asset not found');
  });
}

export async function startServer(): Promise<{ close(): Promise<void>; runtime: PicoRuntime; port: number }> {
  const host = process.env.PICO_HOST ?? '127.0.0.1';
  const accessToken = process.env.PICO_ACCESS_TOKEN;
  if (accessToken !== undefined && Buffer.byteLength(accessToken) < 32) {
    throw new Error('PICO_ACCESS_TOKEN must contain at least 32 bytes');
  }
  if (!accessToken && !isLoopbackHost(host)) {
    throw new Error('PICO_ACCESS_TOKEN is required when PICO_HOST is not a loopback address');
  }
  const trustProxy = process.env.PICO_TRUST_PROXY === '1';
  const store = new PicoStore();
  const sessions = new AccessSessions(accessToken, store);
  const runtime = new PicoRuntime(store);
  await runtime.initialize();

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  const jsonErrors: ErrorRequestHandler = (error, _request, _response, next) => {
    next(parserError(error) ?? error);
  };
  app.use(jsonErrors);
  app.use('/api', (_request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    next();
  });

  app.get('/api/auth/status', (request, response) => {
    response.json({
      authRequired: sessions.required,
      authenticated: sessions.authenticated(readSessionCookie(request.headers.cookie)),
    });
  });
  app.post('/api/auth/session', (request, response) => {
    if (!sessions.required) return response.json({ authenticated: true });
    const body = bodyObject(request);
    const sessionId = sessions.login(body.token);
    if (!sessionId) return response.status(401).json({ error: 'Invalid Pico access token' });
    response.setHeader('set-cookie', sessionCookie(sessionId, request.secure));
    return response.json({ authenticated: true });
  });
  app.delete('/api/auth/session', (request, response) => {
    sessions.revoke(readSessionCookie(request.headers.cookie));
    response.setHeader('set-cookie', clearedSessionCookie(request.secure));
    response.json({ authenticated: !sessions.required });
  });
  app.use('/api', (request, response, next) => {
    if (sessions.authenticated(readSessionCookie(request.headers.cookie))) return next();
    response.status(401).json({ error: 'Pico access token required', code: 'AUTH_REQUIRED' });
  });

  app.get('/api/health', (_request, response) => response.json({ ok: true }));
  app.get('/api/threads/:threadId/workspace-file', async (request, response) => {
    await serveWorkspaceFile(runtime, request.params.threadId!, request.query.path, response);
  });
  app.get('/api/info', (_request, response) =>
    response.json({ defaultWorkspace: process.cwd(), version: currentExecutorVersion() }),
  );

  app.get('/api/projects', (_request, response) => response.json(runtime.listProjects()));
  app.post('/api/projects', async (request, response) => {
    const body = bodyObject(request);
    if (body.name !== undefined && typeof body.name !== 'string') throw new ServiceError(400, 'name must be a string');
    if (body.workspacePath !== undefined && typeof body.workspacePath !== 'string') {
      throw new ServiceError(400, 'workspacePath must be a string');
    }
    const project = await runtime.createProject(
      typeof body.name === 'string' ? body.name : undefined,
      typeof body.workspacePath === 'string' ? body.workspacePath : undefined,
    );
    response.status(201).json(project);
  });
  app.post('/api/projects/:projectId/workspace', async (request, response) => {
    const body = bodyObject(request);
    response.json(await runtime.setProjectWorkspace(request.params.projectId!, requiredText(body, 'workspacePath')));
  });
  app.get('/api/projects/:projectId/threads', (request, response) => {
    const project = runtime.listProjects().find((candidate) => candidate.id === request.params.projectId);
    if (!project) return notFound(response, 'Project not found');
    response.json(runtime.listThreads(project.id));
  });
  app.post('/api/projects/:projectId/threads', async (request, response) => {
    const body = bodyObject(request);
    const kind = body.executorKind;
    if (kind !== 'container' && kind !== 'host' && kind !== 'runtime') {
      throw new ServiceError(400, 'executorKind must be container, host, or runtime');
    }
    if (body.remoteConnectionId !== undefined &&
        (typeof body.remoteConnectionId !== 'string' || !body.remoteConnectionId.trim() || kind !== 'host')) {
      throw new ServiceError(400, 'Remote Executor Threads must use Host execution kind.');
    }
    const title = typeof body.title === 'string' ? body.title : DEFAULT_THREAD_TITLE;
    const thread =
      typeof body.remoteConnectionId === 'string'
        ? await runtime.createRemoteThread(
            request.params.projectId!,
            body.remoteConnectionId,
            requiredText(body, 'remoteWorkspacePath'),
            title,
          )
        : runtime.createThread(request.params.projectId!, kind as ExecutorKind, title);
    response.status(201).json(thread);
  });

  app.post('/api/threads', (request, response) => {
    const body = bodyObject(request);
    const kind = body.executorKind;
    if (kind !== 'container' && kind !== 'host' && kind !== 'runtime') {
      throw new ServiceError(400, 'executorKind must be container, host, or runtime');
    }
    if (body.remoteConnectionId !== undefined &&
        (typeof body.remoteConnectionId !== 'string' || !body.remoteConnectionId.trim() || kind !== 'host')) {
      throw new ServiceError(400, 'Remote Executor Threads must use Host execution kind.');
    }
    if (body.title !== undefined && typeof body.title !== 'string') throw new ServiceError(400, 'title must be a string');
    response.status(201).json(
      runtime.createIndependentThread(
        kind,
        typeof body.title === 'string' ? body.title : DEFAULT_THREAD_TITLE,
        typeof body.remoteConnectionId === 'string' ? body.remoteConnectionId : undefined,
      ),
    );
  });
  app.post('/api/threads/:threadId/project', async (request, response) => {
    const body = bodyObject(request);
    if (body.name !== undefined && typeof body.name !== 'string') throw new ServiceError(400, 'name must be a string');
    if (body.workspacePath !== undefined && typeof body.workspacePath !== 'string') {
      throw new ServiceError(400, 'workspacePath must be a string');
    }
    response.status(201).json(
      await runtime.createProjectFromThread(
        request.params.threadId!,
        typeof body.name === 'string' ? body.name : undefined,
        typeof body.workspacePath === 'string' ? body.workspacePath : undefined,
      ),
    );
  });

  app.get('/api/executor-connections', (_request, response) => {
    response.json(runtime.remoteExecutorConnections());
  });
  app.post('/api/executor-connections', async (request, response) => {
    const body = bodyObject(request);
    const connection = await runtime.addRemoteExecutorConnection(
      requiredText(body, 'name'),
      requiredText(body, 'endpointUrl'),
      requiredText(body, 'accessToken'),
    );
    response.status(201).json(connection);
  });
  app.put('/api/executor-connections/:id', async (request, response) => {
    const body = bodyObject(request);
    const connection = await runtime.updateRemoteExecutorConnection(
      request.params.id!,
      requiredText(body, 'name'),
      requiredText(body, 'endpointUrl'),
      typeof body.accessToken === 'string' ? body.accessToken : undefined,
    );
    response.json(connection);
  });

  app.get('/api/mcp/servers', (_request, response) => {
    response.json({ servers: runtime.listMcpServers() });
  });
  app.post('/api/mcp/servers', async (request, response) => {
    const server = await runtime.createMcpServer(parseMcpServerInput(bodyObject(request)));
    response.status(201).json({ server });
  });
  app.put('/api/mcp/servers/:id', async (request, response) => {
    const server = await runtime.updateMcpServer(request.params.id!, parseMcpServerInput(bodyObject(request)));
    response.json({ server });
  });
  app.delete('/api/mcp/servers/:id', async (request, response) => {
    await runtime.deleteMcpServer(request.params.id!);
    response.json({ ok: true });
  });
  app.post('/api/mcp/servers/:id/start', async (request, response) => {
    const id = request.params.id!;
    const configured = runtime.listMcpServers().find((server) => server.id === id);
    if (!configured) return notFound(response, 'MCP server not found');
    const body =
      request.body && typeof request.body === 'object' && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    if (configured.transport === 'stdio' && body.confirmLocalExecution !== true) {
      throw new ServiceError(400, 'Starting a local MCP process requires confirmLocalExecution: true');
    }
    if (configured.transport === 'stdio') {
      if (
        typeof body.executionFingerprint !== 'string' ||
        body.executionFingerprint !== configured.executionFingerprint
      ) {
        throw new ServiceError(400, 'The local MCP configuration changed. Review the command and confirm it again.');
      }
    }
    const server = await runtime.startMcpServer(
      id,
      configured.transport === 'stdio'
        ? { confirmLocalExecution: true, executionFingerprint: body.executionFingerprint as string }
        : undefined,
    );
    response.json({ server });
  });
  app.post('/api/mcp/servers/:id/stop', async (request, response) => {
    response.json({ server: await runtime.stopMcpServer(request.params.id!) });
  });

  app.get('/api/threads', (request, response) => {
    const projectId = typeof request.query.projectId === 'string' ? request.query.projectId : undefined;
    if (request.query.unassigned === 'true') return response.json(runtime.listThreads(null));
    return response.json(runtime.listThreads(projectId));
  });
  app.get('/api/threads/archived', (_request, response) => {
    response.json({ threads: runtime.listArchivedThreads() });
  });
  app.get('/api/threads/:threadId/initial-snapshot', (request, response) => {
    const view = request.query.view === 'timeline' ? 'timeline' : 'full';
    if (request.query.view !== undefined && request.query.view !== 'timeline' && request.query.view !== 'full') {
      throw new ServiceError(400, 'view must be timeline or full.');
    }
    const beforeSeqValue = request.query.beforeSeq;
    if (beforeSeqValue !== undefined && typeof beforeSeqValue !== 'string') {
      throw new ServiceError(400, 'beforeSeq must be a positive safe integer.');
    }
    const beforeSeq = beforeSeqValue === undefined ? undefined : Number(beforeSeqValue);
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) {
      throw new ServiceError(400, 'beforeSeq must be a positive safe integer.');
    }
    const result = runtime.getInitialSnapshot(request.params.threadId!, beforeSeq, view);
    if (!result) return notFound(response, 'Thread not found');
    response.json(result);
  });
  app.get('/api/threads/:threadId', (request, response) => {
    const view = request.query.view === 'timeline' ? 'timeline' : 'full';
    if (request.query.view !== undefined && request.query.view !== 'timeline' && request.query.view !== 'full') {
      throw new ServiceError(400, 'view must be timeline or full.');
    }
    const beforeSeqValue = request.query.beforeSeq;
    if (beforeSeqValue !== undefined && typeof beforeSeqValue !== 'string') {
      throw new ServiceError(400, 'beforeSeq must be a positive safe integer.');
    }
    const beforeSeq = beforeSeqValue === undefined ? undefined : Number(beforeSeqValue);
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) {
      throw new ServiceError(400, 'beforeSeq must be a positive safe integer.');
    }
    const snapshot = runtime.getSnapshot(request.params.threadId!, beforeSeq, false, view);
    if (!snapshot) return notFound(response, 'Thread not found');
    response.json(snapshot);
  });
  app.patch('/api/threads/:threadId', (request, response) => {
    const body = bodyObject(request);
    response.json(runtime.updateThreadTitle(request.params.threadId!, requiredText(body, 'title')));
  });
  app.get('/api/threads/:threadId/model-selection', (request, response) => {
    response.json(runtime.threadModelSelection(request.params.threadId!));
  });
  app.put('/api/threads/:threadId/model-selection', (request, response) => {
    response.json(
      runtime.updateThreadModelSelection(
        request.params.threadId!,
        bodyObject(request) as unknown as ThreadModelSelection,
      ),
    );
  });
  app.post('/api/threads/:threadId/archive', (request, response) => {
    response.json(runtime.archiveThread(request.params.threadId!));
  });
  app.post('/api/threads/:threadId/unarchive', (request, response) => {
    response.json(runtime.unarchiveThread(request.params.threadId!));
  });
  app.delete('/api/threads/:threadId', (request, response) => {
    response.json(runtime.hideArchivedThread(request.params.threadId!));
  });
  app.post('/api/threads/:threadId/draft-handoff-state', (request, response) => {
    const body = bodyObject(request);
    const executionIds = body.executionIds;
    if (
      !Array.isArray(executionIds) ||
      executionIds.length < 1 ||
      executionIds.length > 50 ||
      executionIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 256)
    ) {
      throw new ServiceError(400, 'executionIds must contain 1..50 non-empty strings of at most 256 characters');
    }
    if (!runtime.store.getThread(request.params.threadId!)) return notFound(response, 'Thread not found');
    response.json({ executions: runtime.getDraftHandoffState(request.params.threadId!, executionIds as string[]) });
  });
  app.get('/api/threads/:threadId/tools', async (request, response) => {
    response.json({ tools: await runtime.listThreadTools(request.params.threadId!) });
  });
  app.put('/api/threads/:threadId/tools', async (request, response) => {
    const body = bodyObject(request);
    const toolName = requiredText(body, 'name');
    if (typeof body.enabled !== 'boolean') throw new ServiceError(400, 'enabled must be a boolean');
    response.json({
      tools: await runtime.setThreadToolEnabled(request.params.threadId!, toolName, body.enabled),
    });
  });
  app.get('/api/threads/:threadId/executions/:executionId/model-input', (request, response) => {
    const attempts = runtime.getModelInputAttempts(request.params.threadId!, request.params.executionId!);
    if (!attempts) return notFound(response, 'Model Execution not found in this Thread');
    response.json({ attempts });
  });
  app.post('/api/threads/:threadId/executions/:executionId/retry', (request, response) => {
    response.status(202).json(runtime.retryModelExecution(request.params.threadId!, request.params.executionId!));
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
  app.post('/api/threads/:threadId/context/restore', (request, response) => {
    response.json(runtime.restoreContextCheckpoint(request.params.threadId!));
  });
  app.post('/api/threads/:threadId/context/rewind', (request, response) => {
    const body = bodyObject(request);
    response.json(runtime.rewindContextToMessage(request.params.threadId!, requiredText(body, 'targetRecordId')));
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
  app.post('/api/threads/:threadId/executor/update', async (request, response) => {
    response.json(await runtime.updateExecutor(request.params.threadId!));
  });
  app.post('/api/threads/:threadId/executor/restart', async (request, response) => {
    response.json(await runtime.restartContainerExecutor(request.params.threadId!));
  });
  app.get('/api/settings/model', (_request, response) => response.json(runtime.publicModelSettings()));
  app.get('/api/model-catalog', (_request, response) => response.json(runtime.modelCatalogView()));
  app.get('/api/model-catalog/adapters', (request, response) => {
    if (typeof request.query.modelId !== 'string') throw new ServiceError(400, 'modelId is required');
    response.json({ adapters: runtime.modelCatalog.matchingAdapters(request.query.modelId) });
  });
  app.post('/api/provider-instances', (request, response) => {
    const body = bodyObject(request);
    runtime.modelCatalog.createEmptyInstance(requiredText(body, 'typeId'));
    response.json(runtime.modelCatalogView());
  });
  app.post('/api/provider-instances/:instanceId/refresh', async (request, response) => {
    await runtime.modelCatalog.refreshInstance(request.params.instanceId!);
    response.json(runtime.modelCatalogView());
  });
  app.patch('/api/provider-instances/:instanceId', (request, response) => {
    const instance = runtime.modelCatalog.listInstances().find((item) => item.id === request.params.instanceId);
    if (!instance) throw new ServiceError(404, 'Provider instance unavailable');
    const body = request.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'label') ||
      typeof body.label !== 'string'
    )
      throw new ServiceError(400, 'Invalid provider name');
    runtime.modelCatalog.updateInstance(instance.owner, instance.id, { label: body.label, config: instance.config });
    response.json(runtime.modelCatalogView());
  });
  app.delete('/api/provider-instances/:instanceId', async (request, response) => {
    const instance = runtime.modelCatalog.listInstances().find((item) => item.id === request.params.instanceId);
    if (!instance) throw new ServiceError(404, 'Provider instance unavailable');
    await runtime.modelCatalog.removeInstance(instance.owner, instance.id);
    response.json(runtime.modelCatalogView());
  });
  app.get('/api/plugins/model-selections', (_request, response) => response.json(runtime.pluginModelSelectionsView()));
  app.put('/api/plugins/:pluginId/model-selection', (request, response) => {
    response.json(
      runtime.updatePluginModelSelection(
        request.params.pluginId!,
        bodyObject(request) as unknown as Parameters<PicoRuntime['updatePluginModelSelection']>[1],
      ),
    );
  });
  app.get('/api/settings/context-management', (_request, response) => {
    response.json(runtime.getContextManagementSettings());
  });
  app.put('/api/settings/context-management', (request, response) => {
    const body = bodyObject(request);
    const update: Partial<ContextManagementSettings> = {};
    const hasContextWindowTokens = Object.hasOwn(body, 'contextWindowTokens');
    const hasCompactionThresholdTokens = Object.hasOwn(body, 'compactionThresholdTokens');
    const hasKeepRecentTokens = Object.hasOwn(body, 'keepRecentTokens');
    if (!hasContextWindowTokens && !hasCompactionThresholdTokens && !hasKeepRecentTokens) {
      throw new ServiceError(
        400,
        'Provide a context window, compaction threshold, or recent history budget to update.',
      );
    }
    if (hasContextWindowTokens) {
      if (typeof body.contextWindowTokens !== 'number') {
        throw new ServiceError(400, 'Context window must be a number of tokens.');
      }
      update.contextWindowTokens = body.contextWindowTokens;
    }
    if (hasCompactionThresholdTokens) {
      if (typeof body.compactionThresholdTokens !== 'number') {
        throw new ServiceError(400, 'Compaction threshold must be a number of tokens.');
      }
      update.compactionThresholdTokens = body.compactionThresholdTokens;
    }
    if (hasKeepRecentTokens) {
      if (typeof body.keepRecentTokens !== 'number') {
        throw new ServiceError(400, 'Recent history budget must be a number of tokens.');
      }
      update.keepRecentTokens = body.keepRecentTokens;
    }
    response.json(runtime.updateContextManagementSettings(update));
  });
  app.get('/api/settings/miscellaneous', (_request, response) => {
    response.json(runtime.getMiscellaneousSettings());
  });
  app.put('/api/settings/miscellaneous', (request, response) => {
    const body = bodyObject(request);
    const update: Partial<MiscellaneousSettings> = {};
    for (const key of ['toolCardsExpandedByDefault', 'convenientModelParameters'] as const) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== 'boolean') throw new ServiceError(400, `${key} must be a boolean.`);
        update[key] = body[key];
      }
    }
    if (Object.keys(update).length === 0) throw new ServiceError(400, 'A miscellaneous setting is required.');
    response.json(runtime.updateMiscellaneousSettings(update));
  });
  app.get('/api/commands', (_request, response) => response.json(runtime.availableCommands()));
  app.post('/api/commands/execute', async (request, response) => {
    const body = bodyObject(request);
    const pluginId = requiredText(body, 'pluginId');
    const threadId = requiredText(body, 'threadId');
    const id = requiredText(body, 'id');
    const command = requiredText(body, 'command');
    if (!runtime.commands.owns(pluginId, command)) {
      return response.status(403).json({ error: 'Command is not owned by the requested plugin.' });
    }
    return response.json(await runtime.executeCommand(threadId, id, command));
  });
  app.get('/api/plugins', (_request, response) => response.json(runtime.pluginInfo()));
  app.put('/api/plugins/:pluginId', async (request, response) => {
    const body = bodyObject(request);
    if (typeof body.enabled !== 'boolean') {
      throw new ServiceError(400, 'Plugin updates require an enabled boolean.');
    }
    return response.json(await runtime.setPluginEnabled(request.params.pluginId!, body.enabled));
  });
  app.post('/api/plugins/:pluginId/reload', async (request, response) => {
    return response.json(await runtime.reloadPlugin(request.params.pluginId!));
  });
  app.use('/_pico/plugin-ui', async (request, response) => {
    await servePluginUiAsset(runtime, request, response, production);
  });
  app.use('/api/plugins/:pluginId', async (request, response) => {
    const route = runtime.pluginHttpRoute(request.params.pluginId!, request.method, request.path || '/');
    if (!route) return notFound(response, 'Plugin API route not found');
    const mutatesState = !['GET', 'HEAD'].includes(request.method);
    const origin = request.headers.origin ?? null;
    const forwardedProto =
      trustProxy &&
      String(request.headers['x-forwarded-proto'] ?? '')
        .split(',')[0]
        ?.trim()
        .toLowerCase() === 'https';
    if (
      mutatesState &&
      (!origin ||
        !sameOrigin(
          origin,
          request.headers.host,
          Boolean((request.socket as import('node:tls').TLSSocket).encrypted) || forwardedProto,
        ))
    ) {
      throw new ServiceError(400, 'Plugin state changes must come from the Pico Web UI.');
    }
    const requestUrl = new URL(request.originalUrl, `http://${request.headers.host ?? 'localhost'}`);
    const result = await route.handler({ body: request.body, query: requestUrl.searchParams, origin });
    if (result === undefined) return response.status(204).end();
    return response.json(result);
  });

  const httpServer = createServer(app);
  const sockets = new Set<WebSocket>();
  const websocketServer = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/api/events') {
      if (production) socket.destroy();
      return;
    }
    const forwardedProto =
      trustProxy &&
      String(request.headers['x-forwarded-proto'] ?? '')
        .split(',')[0]
        ?.trim()
        .toLowerCase() === 'https';
    if (
      !sameOrigin(
        request.headers.origin,
        request.headers.host,
        Boolean((request.socket as import('node:tls').TLSSocket).encrypted) || forwardedProto,
      )
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!sessions.authenticated(readSessionCookie(request.headers.cookie))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) =>
      websocketServer.emit('connection', websocket, request),
    );
  });
  websocketServer.on('connection', (socket) => {
    sockets.add(socket);
    attachModelDraftResume(socket, runtime);
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
    app.use('/releases/:releaseId', (request, response, next) => {
      const releaseId = request.params.releaseId!;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(releaseId)) return notFound(response, 'Web release not found');
      express.static(resolve(clientBuild, 'releases', releaseId), { index: false, fallthrough: true })(
        request,
        response,
        (error) => {
          if (error && error.status !== 404) return next(error);
          return notFound(response, 'Web release asset not found');
        },
      );
    });
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
    const result = errorResponse(error);
    response.status(result.status).json({ error: result.message, code: result.code });
  };
  app.use(errors);

  const port = Number(process.env.PICO_PORT ?? '4173');
  await new Promise<void>((resolvePromise, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolvePromise();
    });
  });
  const boundPort = httpServer.address();
  const actualPort = typeof boundPort === 'object' && boundPort ? boundPort.port : port;
  console.log(`Pico is ready at http://${host}:${actualPort}`);
  if (runtime.pluginInfo().errors.length > 0) console.warn('Plugin load issues:', runtime.pluginInfo().errors);

  let closePromise: Promise<void> | null = null;
  return {
    runtime,
    port: actualPort,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        unsubscribe();
        for (const socket of sockets) socket.close();
        websocketServer.close();
        await new Promise<void>((resolvePromise) => httpServer.close(() => resolvePromise()));
        await runtime.shutdown();
        await vite?.close();
        runtime.store.close();
      })();
      return closePromise;
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
