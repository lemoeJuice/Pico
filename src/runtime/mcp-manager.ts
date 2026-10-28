import { ServiceError } from '../contracts/service-error.js';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { accessSync, constants as fsConstants, realpathSync, statSync } from 'node:fs';
import { request as httpRequest, type RequestOptions as HttpRequestOptions } from 'node:http';
import { isIP } from 'node:net';
import { delimiter as pathDelimiter, isAbsolute, resolve } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { Readable, type Stream } from 'node:stream';
import {
  Client,
  StreamableHTTPClientTransport,
  type Tool as SdkMcpTool,
  type Transport,
} from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { PicoStore } from '../core/store.js';
import type { ToolDefinition } from '../core/types.js';
import type { ToolCatalog } from '../executor/tool-catalog.js';
import type {
  McpServerInput,
  McpServerStatus,
  McpServerToolView,
  McpServerView,
  StartMcpServerOptions,
} from '../contracts/mcp.js';

const MCP_SERVERS_SETTING = 'mcp-servers';
const MCP_SECRET_OWNER = 'pico.mcp';
const MCP_FINGERPRINT_KEY = '__stdio_fingerprint_key__';
const MCP_TOOL_IDENTITY_KEY = '__tool_identity_key__';
const MCP_CONNECT_TIMEOUT_MS = 20_000;
const MCP_STDERR_TAIL_CHARS = 8_192;
const SENSITIVE_QUERY_KEY =
  /(?:token|secret|password|passwd|credential|api[_-]?key|auth|signature|^sig$|jwt|bearer|refresh|access[_-]?key|client[_-]?secret|^code$|^key$)/i;

type StdioConfig = {
  id: string;
  name: string;
  transport: 'stdio';
  command: string;
  args: string[];
  cwd?: string;
  autoStart: boolean;
  visibleByDefault: boolean;
  localExecutionFingerprint?: string;
};

type HttpConfig = {
  id: string;
  name: string;
  transport: 'streamable-http';
  url: string;
  autoStart: boolean;
  visibleByDefault: boolean;
  confirmPrivateNetworkAccess: boolean;
  confirmedPrivateNetworkOrigin?: string;
};

type StoredMcpServer = StdioConfig | HttpConfig;

interface McpServerSecret {
  bearerToken?: string;
  env?: Record<string, string>;
  redactionValues?: string[];
}

interface RuntimeMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpClientLike {
  connect(transport: Transport, options?: { timeout?: number }): Promise<void>;
  close(): Promise<void>;
  listTools(
    params?: undefined,
    options?: { cacheMode?: 'use' | 'refresh' | 'bypass'; signal?: AbortSignal; timeout?: number },
  ): Promise<{ tools: SdkMcpTool[] }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

interface McpTransportLike extends Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  stderr?: Stream | null;
}

interface McpManagerDependencies {
  createClient(options: { onToolsChanged(error: Error | null, tools?: unknown[]): void }): McpClientLike;
  createStdioTransport(input: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string>;
  }): McpTransportLike;
  createHttpTransport(input: { url: URL; bearerToken?: string; allowPrivate: boolean }): McpTransportLike;
}

interface McpRuntimeState {
  status: McpServerStatus;
  lastError: string | null;
  tools: McpServerToolView[];
  runtimeTools: RuntimeMcpTool[];
  generation: number;
  connection?: {
    client: McpClientLike;
    transport: McpTransportLike;
    stopController: AbortController;
  };
  startPromise?: Promise<McpServerView>;
  stopPromise?: Promise<McpServerView>;
  transitionQueue: Promise<void>;
  activeCalls: Set<Promise<unknown>>;
}

type McpRuntimeEvent = { type: string; [key: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function configList(store: PicoStore): StoredMcpServer[] {
  const value = store.getSetting<unknown>(MCP_SERVERS_SETTING, []);
  if (!Array.isArray(value)) return [];
  const configs = value.filter((item): item is StoredMcpServer => {
    if (!isRecord(item)) return false;
    if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.autoStart !== 'boolean') {
      return false;
    }
    if (item.transport === 'stdio') {
      return (
        typeof item.command === 'string' &&
        Array.isArray(item.args) &&
        item.args.every((argument) => typeof argument === 'string')
      );
    }
    return item.transport === 'streamable-http' && typeof item.url === 'string';
  });
  return configs.map((config) => ({
    ...config,
    visibleByDefault: config.visibleByDefault === true,
    ...(config.transport === 'streamable-http'
      ? {
          confirmPrivateNetworkAccess: config.confirmPrivateNetworkAccess === true,
          ...(typeof config.confirmedPrivateNetworkOrigin === 'string'
            ? { confirmedPrivateNetworkOrigin: config.confirmedPrivateNetworkOrigin }
            : {}),
        }
      : {}),
  }));
}

function safeNamePart(value: string, fallback = 'tool'): string {
  return (
    value
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || fallback
  );
}

function legacyNamespacedToolName(serverId: string, toolName: string): string {
  const serverSuffix = createHash('sha256').update(serverId).digest('hex').slice(0, 8);
  const toolSuffix = createHash('sha256').update(toolName).digest('hex').slice(0, 8);
  return `mcp_${serverSuffix}_${safeNamePart(toolName).slice(0, 40)}_${toolSuffix}`;
}

function readableToolName(serverName: string, toolName: string): string {
  let serverPart = safeNamePart(serverName, 'server').toLowerCase();
  if (!/^[a-z]/.test(serverPart)) serverPart = `server_${serverPart}`;
  serverPart = serverPart.slice(0, 24);
  const toolPart = safeNamePart(toolName).toLowerCase();
  const maxToolLength = 64 - serverPart.length - 2;
  return `${serverPart}__${toolPart.slice(0, maxToolLength)}`;
}

function disambiguatedToolName(baseName: string, serverId: string, toolKey: string, occupied: Set<string>): string {
  const digest = createHash('sha256').update(`${serverId}\0${toolKey}`).digest('hex');
  for (const length of [8, 12, 16, 24, 32]) {
    const suffix = digest.slice(0, length);
    const candidate = `${baseName.slice(0, 63 - suffix.length).replace(/[_-]+$/g, '')}_${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error(`MCP tool name collision could not be resolved: ${baseName}`);
}

function stringValues(secret: McpServerSecret): string[] {
  return [secret.bearerToken, ...Object.values(secret.env ?? {}), ...(secret.redactionValues ?? [])].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

function redactText(value: string, secret: McpServerSecret): string {
  let text = value;
  for (const secretValue of stringValues(secret).sort((left, right) => right.length - left.length)) {
    text = text.split(secretValue).join('[redacted]');
  }
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/(\bbearer\s+)\S+/gi, '$1[redacted]')
    .slice(0, 1_000);
}

function redactResult(value: unknown, secret: McpServerSecret): unknown {
  if (typeof value === 'string') return redactText(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactResult(item, secret));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [redactText(key, secret), redactResult(item, secret)]),
  );
}

function toolDefinition(
  config: StoredMcpServer,
  tool: RuntimeMcpTool,
  secret: McpServerSecret,
  name = readableToolName(config.name, redactText(tool.name, secret)),
): ToolDefinition {
  const parameters = redactResult(tool.inputSchema, secret);
  return {
    name,
    description: redactText(`${config.name} · ${tool.name}: ${tool.description}`, secret).slice(0, 2_000),
    parameters: isRecord(parameters) ? parameters : { type: 'object' },
  };
}

function normalizeTool(value: unknown): RuntimeMcpTool {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error('The MCP server returned an invalid tool definition.');
  }
  return {
    name: value.name,
    description: typeof value.description === 'string' ? value.description : '',
    inputSchema: isRecord(value.inputSchema) ? structuredClone(value.inputSchema) : { type: 'object' },
  };
}

function defaultDependencies(): McpManagerDependencies {
  return {
    createClient: ({ onToolsChanged }) =>
      new Client(
        { name: 'pico', version: '0.2.0' },
        {
          listChanged: {
            tools: {
              onChanged: (error, tools) => onToolsChanged(error ?? null, tools ?? undefined),
            },
          },
        },
      ),
    createStdioTransport: ({ command, args, cwd, env }) =>
      new StdioClientTransport({
        command,
        args,
        ...(cwd === undefined ? {} : { cwd }),
        env: { ...getDefaultEnvironment(), ...env },
        stderr: 'pipe',
      }),
    createHttpTransport: ({ url, bearerToken, allowPrivate }) =>
      new StreamableHTTPClientTransport(url, {
        ...(bearerToken ? { authProvider: { token: async () => bearerToken } } : {}),
        fetch: createPinnedHttpFetch(url, allowPrivate),
        redirectPolicy: 'same-origin',
        requestInit: { redirect: 'error' },
      }),
  };
}

function validateHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServiceError(400, 'MCP server URL must be a valid HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ServiceError(400, 'MCP server URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) throw new ServiceError(400, 'MCP server URLs cannot contain embedded credentials.');
  if (url.hash) throw new ServiceError(400, 'MCP server URLs cannot contain fragments.');
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      throw new ServiceError(400, 'Put MCP authentication in the Bearer token field, not in the URL query string.');
    }
  }
  return url;
}

function sanitizedUrlForView(value: string): string {
  const url = new URL(value);
  for (const key of [...new Set(url.searchParams.keys())]) url.searchParams.set(key, '[redacted]');
  return url.toString();
}

function restoreRedactedQuery(value: string, existing: string): string {
  const next = new URL(value);
  const previous = new URL(existing);
  if (next.origin !== previous.origin || next.pathname !== previous.pathname || next.hash !== previous.hash) {
    return value;
  }
  const previousEntries = [...previous.searchParams.entries()];
  const nextEntries = [...next.searchParams.entries()];
  if (
    previousEntries.length !== nextEntries.length ||
    previousEntries.some(([key], index) => key !== nextEntries[index]?.[0])
  ) {
    return value;
  }
  next.search = '';
  nextEntries.forEach(([key, item], index) => {
    next.searchParams.append(key, item === '[redacted]' ? previousEntries[index]![1] : item);
  });
  return next.toString();
}

function ipv4Number(value: string): number {
  return value.split('.').reduce((result, part) => result * 256 + Number(part), 0) >>> 0;
}

function inIpv4Range(address: number, network: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (address & mask) === (ipv4Number(network) & mask);
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    const nonPublicRanges: Array<[string, number]> = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.88.99.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ];
    return !nonPublicRanges.some(([network, prefix]) => inIpv4Range(value, network, prefix));
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  // Only global unicast IPv6 (2000::/3) is allowed by default. This excludes
  // mapped IPv4, ULA, link-local, multicast, NAT64 and other special ranges.
  const groups = normalized.split('::');
  if (groups.length > 2) return false;
  const left = groups[0] ? groups[0].split(':') : [];
  const right = groups[1] ? groups[1].split(':') : [];
  const all = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (all.length !== 8) return false;
  const value = all.reduce((result, part) => (result << 16n) | BigInt(Number.parseInt(part || '0', 16)), 0n);
  const first = Number((value >> 112n) & 0xffffn);
  const second = Number((value >> 96n) & 0xffffn);
  if (first < 0x2000 || first > 0x3fff) return false;
  // Protocol assignment, documentation, benchmarking, and 6to4 ranges.
  if (first === 0x2000 && second <= 0x01ff) return false; // 2000::/23
  if (first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) return false; // assigned special ranges + 2001:db8::/32
  if (first === 0x2002) return false; // 2002::/16
  if (first === 0x3fff) return false; // 3fff::/16 documentation
  return true;
}

function hostFromUrl(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

export async function resolveMcpTarget(
  url: URL,
  allowPrivate: boolean,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const hostname = hostFromUrl(url);
  if (!allowPrivate && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))) {
    throw new Error(
      'The MCP server resolves to a private or reserved network address. Enable private-network access to connect intentionally.',
    );
  }
  let addresses: Array<{ address: string; family: 4 | 6 }>;
  const family = isIP(hostname);
  if (family === 4 || family === 6) {
    addresses = [{ address: hostname, family }];
  } else {
    try {
      addresses = (await dnsLookup(hostname, { all: true, verbatim: true })).map((result) => ({
        address: result.address,
        family: result.family as 4 | 6,
      }));
    } catch {
      throw new Error('Could not resolve the MCP server hostname.');
    }
  }
  if (addresses.length === 0) throw new Error('The MCP server hostname resolved to no addresses.');
  if (!allowPrivate && addresses.some(({ address }) => !isPublicNetworkAddress(address))) {
    throw new Error(
      'The MCP server resolves to a private or reserved network address. Enable private-network access to connect intentionally.',
    );
  }
  return addresses;
}

function createPinnedHttpFetch(endpoint: URL, allowPrivate: boolean) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) throw new DOMException('MCP request was aborted.', 'AbortError');
    let url: URL;
    try {
      url = new URL(input.toString());
    } catch {
      throw new Error('MCP request URL is invalid.');
    }
    if (url.origin !== endpoint.origin || url.username || url.password || url.hash) {
      throw new Error('MCP requests must stay on the configured server origin.');
    }
    const addresses = await resolveMcpTarget(url, allowPrivate);
    if (init?.signal?.aborted) throw new DOMException('MCP request was aborted.', 'AbortError');
    const headers = new Headers(init?.headers);
    const requestOptions: HttpRequestOptions = {
      protocol: url.protocol,
      hostname: hostFromUrl(url),
      port: url.port || undefined,
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(headers.entries()),
      signal: init?.signal ?? undefined,
      lookup: ((
        _hostname: string,
        options: { all?: boolean; family?: number },
        callback: (...args: unknown[]) => void,
      ) => {
        const compatibleAddresses = options.family
          ? addresses.filter((item) => item.family === options.family)
          : addresses;
        if (compatibleAddresses.length === 0) {
          callback(new Error('No previously validated address matches the requested network family.'));
          return;
        }
        if (options.all) {
          callback(
            null,
            compatibleAddresses.map((item) => ({ address: item.address, family: item.family })),
          );
        } else {
          const selected = compatibleAddresses[0]!;
          callback(null, selected.address, selected.family);
        }
      }) as NonNullable<HttpRequestOptions['lookup']>,
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(requestOptions);
    const body = init?.body ?? null;
    return await new Promise<Response>((resolve, reject) => {
      request.once('error', reject);
      request.once('response', (response) => {
        const status = response.statusCode ?? 500;
        if (status >= 300 && status < 400) {
          response.destroy();
          request.destroy();
          reject(new Error('MCP HTTP redirects are disabled.'));
          return;
        }
        try {
          const responseHeaders = new Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            responseHeaders.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
          }
          const responseBody = [204, 205, 304].includes(status)
            ? null
            : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
          resolve(
            new Response(responseBody, {
              status,
              ...(response.statusMessage === undefined ? {} : { statusText: response.statusMessage }),
              headers: responseHeaders,
            }),
          );
        } catch {
          response.destroy();
          reject(new Error('MCP server returned an invalid HTTP response.'));
        }
      });

      if (body === null) {
        request.end();
      } else if (body instanceof ReadableStream) {
        Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>)
          .on('error', (error) => {
            request.destroy(error);
          })
          .pipe(request);
      } else {
        void new Response(body).arrayBuffer().then(
          (bytes) => request.end(Buffer.from(bytes)),
          (error: unknown) => request.destroy(error instanceof Error ? error : undefined),
        );
      }
    });
  };
}

function validateInput(input: McpServerInput): McpServerInput {
  if (!input || typeof input !== 'object') throw new ServiceError(400, 'MCP server configuration is required.');
  const name = input.name.trim();
  if (!name) throw new ServiceError(400, 'MCP server name is required.');
  if (name.length > 120) throw new ServiceError(400, 'MCP server name must be 120 characters or fewer.');
  if (input.autoStart !== undefined && typeof input.autoStart !== 'boolean') {
    throw new ServiceError(400, 'autoStart must be a boolean.');
  }
  if (input.visibleByDefault !== undefined && typeof input.visibleByDefault !== 'boolean') {
    throw new ServiceError(400, 'visibleByDefault must be a boolean.');
  }
  if (input.transport === 'stdio') {
    const command = input.command.trim();
    if (!command || command.includes('\0')) throw new ServiceError(400, 'MCP server command is required.');
    const args = input.args ?? [];
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
      throw new ServiceError(400, 'MCP server arguments must be strings without NUL characters.');
    }
    if (hasCredentialLikeStdioArguments(command, args)) {
      throw new ServiceError(400, 'Pass credentials to MCP stdio servers through environment variables, not command arguments.');
    }
    if (input.cwd !== undefined && (!input.cwd.trim() || input.cwd.includes('\0'))) {
      throw new ServiceError(400, 'MCP server working directory must be a non-empty path.');
    }
    if (input.env !== undefined) {
      if (!isRecord(input.env)) throw new ServiceError(400, 'MCP server environment must be a string map.');
      for (const [key, value] of Object.entries(input.env)) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
          typeof value !== 'string' ||
          value.includes('\0') ||
          value.length > 2_048
        ) {
          throw new ServiceError(400, 'MCP server environment variable names or values are invalid.');
        }
      }
    }
    return { ...input, name, command, args: [...args] };
  }
  if (input.transport === 'streamable-http') {
    const url = validateHttpUrl(input.url);
    if (input.confirmPrivateNetworkAccess !== undefined && typeof input.confirmPrivateNetworkAccess !== 'boolean') {
      throw new ServiceError(400, 'confirmPrivateNetworkAccess must be a boolean.');
    }
    if (
      input.bearerToken !== undefined &&
      (typeof input.bearerToken !== 'string' || input.bearerToken.length > 2_048)
    ) {
      throw new ServiceError(400, 'MCP Bearer token must be a string.');
    }
    if (url.protocol !== 'https:' && input.bearerToken) {
      throw new ServiceError(400, 'MCP Bearer tokens require HTTPS.');
    }
    return { ...input, name, url: url.toString() };
  }
  throw new ServiceError(400, 'MCP server transport is not supported.');
}

function hasCredentialLikeStdioArguments(command: string, args: string[]): boolean {
  const isSensitiveOption = (name: string): boolean => {
    const normalizedName = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
    return /token|password|passwd|secret|credential|auth|bearer|(?:^|[^a-z0-9])key(?:$|[^a-z0-9])/i.test(
      normalizedName,
    );
  };
  const containsSensitiveUrlQuery = (value: string): boolean => {
    const embeddedUrl = value.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
    if (!embeddedUrl) return false;
    try {
      const url = new URL(embeddedUrl);
      return (
        Boolean(url.username || url.password || url.hash) ||
        [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key))
      );
    } catch {
      return false;
    }
  };
  if (
    containsSensitiveUrlQuery(command) ||
    (/^--?/.test(command) && isSensitiveOption(command.replace(/^--?/, '').split('=', 1)[0]!))
  ) {
    return true;
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (containsSensitiveUrlQuery(argument) || /\b(?:authorization\s*:\s*)?bearer\s+\S+/i.test(argument)) return true;
    const option = argument.replace(/^--?/, '').split('=', 1)[0]!;
    if ((argument.startsWith('-') || argument.startsWith('/')) && isSensitiveOption(option)) return true;
  }
  return false;
}

function effectiveStdioEnvironment(secret: McpServerSecret): Record<string, string> {
  return { ...getDefaultEnvironment(), ...(secret.env ?? {}) };
}

function resolvedExecutableIdentity(config: StdioConfig, environment: Record<string, string>): unknown {
  const command = config.command;
  const cwd = resolve(config.cwd ?? process.cwd());
  const candidates: string[] = [];
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    candidates.push(resolve(cwd, command));
  } else {
    for (const directory of (environment.PATH ?? '').split(pathDelimiter)) {
      candidates.push(resolve(cwd, directory || '.', command));
      if (process.platform === 'win32' && !/\.[^\\/]+$/.test(command)) {
        for (const extension of (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')) {
          candidates.push(resolve(cwd, directory || '.', `${command}${extension}`));
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      const realPath = realpathSync.native(candidate);
      const stat = statSync(realPath);
      return { path: realPath, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      // Keep searching PATH. An unresolved command is still bound to its text and PATH below.
    }
  }
  return null;
}

export class McpManager {
  private readonly store: PicoStore;
  private readonly tools: ToolCatalog;
  private readonly onChange: (event: McpRuntimeEvent) => void;
  private readonly dependencies: McpManagerDependencies;
  private readonly states = new Map<string, McpRuntimeState>();

  constructor(
    store: PicoStore,
    tools: ToolCatalog,
    onChange: (event: McpRuntimeEvent) => void,
    dependencies: McpManagerDependencies = defaultDependencies(),
  ) {
    this.store = store;
    this.tools = tools;
    this.onChange = onChange;
    this.dependencies = dependencies;
    for (const config of configList(store)) this.ensureState(config.id);
  }

  list(): McpServerView[] {
    return configList(this.store).map((config) => this.view(config));
  }

  isToolVisibleByDefault(serverId: string): boolean {
    return configList(this.store).find((config) => config.id === serverId)?.visibleByDefault ?? false;
  }

  async create(input: McpServerInput): Promise<McpServerView> {
    const validated = validateInput(input);
    const id = randomUUID();
    let secret: McpServerSecret = {};
    const autoStart = validated.autoStart ?? false;
    const visibleByDefault = validated.visibleByDefault ?? false;
    const config: StoredMcpServer =
      validated.transport === 'stdio'
        ? {
            id,
            name: validated.name,
            transport: 'stdio',
            command: validated.command,
            args: validated.args ?? [],
            ...(validated.cwd === undefined ? {} : { cwd: validated.cwd }),
            autoStart,
            visibleByDefault,
          }
        : {
            id,
            name: validated.name,
            transport: 'streamable-http',
            url: validated.url,
            autoStart,
            visibleByDefault,
            confirmPrivateNetworkAccess: validated.confirmPrivateNetworkAccess === true,
            ...(validated.confirmPrivateNetworkAccess === true
              ? { confirmedPrivateNetworkOrigin: new URL(validated.url).origin }
              : {}),
          };
    if (validated.transport === 'stdio' && validated.env && Object.keys(validated.env).length > 0) {
      secret = { env: { ...validated.env } };
    } else if (validated.transport === 'streamable-http' && validated.bearerToken) {
      secret = { bearerToken: validated.bearerToken };
    }
    const configs = configList(this.store);
    this.store.transaction(() => {
      this.saveConfigs([...configs, config]);
      this.saveSecret(id, secret);
    });
    const state = this.ensureState(id);
    state.status = 'stopped';
    state.lastError = null;
    state.tools = [];
    this.publish(config);
    return this.view(config);
  }

  async update(id: string, input: McpServerInput): Promise<McpServerView> {
    const currentBeforeUpdate = this.requireConfig(id);
    if (currentBeforeUpdate.transport === 'streamable-http' && input.transport === 'streamable-http') {
      input = { ...input, url: restoreRedactedQuery(input.url, currentBeforeUpdate.url) };
    }
    const validated = validateInput(input);
    const currentSecret = this.secret(id);
    const currentEnv = currentSecret.env ?? {};
    const nextEnv = validated.transport === 'stdio' ? validated.env ?? currentEnv : currentEnv;
    const sameEnvironment =
      Object.keys(nextEnv).length === Object.keys(currentEnv).length &&
      Object.entries(nextEnv).every(([key, value]) => currentEnv[key] === value);
    const onlyVisibilityDefaultChanged =
      validated.visibleByDefault !== undefined &&
      validated.visibleByDefault !== currentBeforeUpdate.visibleByDefault &&
      validated.name === currentBeforeUpdate.name &&
      validated.transport === currentBeforeUpdate.transport &&
      (validated.autoStart === undefined || validated.autoStart === currentBeforeUpdate.autoStart) &&
      (validated.transport === 'stdio'
        ? currentBeforeUpdate.transport === 'stdio' &&
          validated.command === currentBeforeUpdate.command &&
          JSON.stringify(validated.args ?? []) === JSON.stringify(currentBeforeUpdate.args) &&
          validated.cwd === currentBeforeUpdate.cwd &&
          sameEnvironment
        : currentBeforeUpdate.transport === 'streamable-http' &&
          validated.url === currentBeforeUpdate.url &&
          (validated.bearerToken === undefined || validated.bearerToken === currentSecret.bearerToken) &&
          (validated.confirmPrivateNetworkAccess === undefined ||
            validated.confirmPrivateNetworkAccess === currentBeforeUpdate.confirmPrivateNetworkAccess));
    const stopPromise = onlyVisibilityDefaultChanged ? Promise.resolve(undefined) : this.stop(id);
    return this.enqueueTransition(id, async () => {
      await stopPromise;
      const current = this.requireConfig(id);
      const previousSecret = this.secret(id);
      let nextSecret: McpServerSecret = {};
      if (validated.transport === 'stdio') {
        const env = validated.env ?? (current.transport === 'stdio' ? previousSecret.env : undefined);
        if (env && Object.keys(env).length > 0) nextSecret.env = { ...env };
      } else {
        const token = validated.bearerToken !== undefined ? validated.bearerToken : previousSecret.bearerToken;
        if (token) nextSecret.bearerToken = token;
        if (
          current.transport === 'streamable-http' &&
          current.url !== validated.url &&
          new URL(current.url).origin !== new URL(validated.url).origin &&
          validated.bearerToken === undefined &&
          previousSecret.bearerToken
        ) {
          throw new ServiceError(400, 'Clear or replace the Bearer token before changing the MCP server origin.');
        }
        if (validated.url.startsWith('http:') && nextSecret.bearerToken) {
          throw new ServiceError(400, 'MCP Bearer tokens require HTTPS.');
        }
      }
      const previousConsent =
        current.transport === 'stdio' && current.localExecutionFingerprint === this.executionFingerprint(current)
          ? current.localExecutionFingerprint
          : undefined;
      const sameHttpOrigin =
        validated.transport === 'streamable-http' &&
        current.transport === 'streamable-http' &&
        new URL(current.url).origin === new URL(validated.url).origin;
      const privateNetworkConfirmed =
        validated.transport === 'streamable-http' &&
        (validated.confirmPrivateNetworkAccess === true ||
          (validated.confirmPrivateNetworkAccess === undefined &&
            sameHttpOrigin &&
            current.transport === 'streamable-http' &&
            current.confirmPrivateNetworkAccess &&
            current.confirmedPrivateNetworkOrigin === new URL(current.url).origin));
      const config: StoredMcpServer =
        validated.transport === 'stdio'
          ? {
              id,
              name: validated.name,
              transport: 'stdio',
              command: validated.command,
              args: validated.args ?? [],
              ...(validated.cwd === undefined ? {} : { cwd: validated.cwd }),
              autoStart: validated.autoStart ?? current.autoStart,
              visibleByDefault: validated.visibleByDefault ?? current.visibleByDefault,
            }
          : {
              id,
              name: validated.name,
              transport: 'streamable-http',
              url: validated.url,
              autoStart: validated.autoStart ?? current.autoStart,
              visibleByDefault: validated.visibleByDefault ?? current.visibleByDefault,
              confirmPrivateNetworkAccess: privateNetworkConfirmed,
              ...(privateNetworkConfirmed ? { confirmedPrivateNetworkOrigin: new URL(validated.url).origin } : {}),
            };
      if (config.transport === 'stdio' && previousConsent === this.executionFingerprint(config)) {
        config.localExecutionFingerprint = previousConsent;
      }
      this.store.transaction(() => {
        this.saveSecret(id, nextSecret);
        this.saveConfigs(configList(this.store).map((item) => (item.id === id ? config : item)));
      });
      this.publish(config);
      return this.view(config);
    });
  }

  async delete(id: string): Promise<void> {
    this.requireConfig(id);
    const stopPromise = this.stop(id);
    await this.enqueueTransition(id, async () => {
      await stopPromise;
      this.store.transaction(() => {
        this.saveConfigs(configList(this.store).filter((item) => item.id !== id));
        this.store.deletePrivateSecret(MCP_SECRET_OWNER, id);
      });
      this.rebuildTools();
      this.onChange({ type: 'mcp.server.deleted', serverId: id });
    });
    this.states.delete(id);
  }

  async start(id: string, options: StartMcpServerOptions = {}): Promise<McpServerView> {
    return this.startInternal(id, options, false);
  }

  private async startInternal(id: string, options: StartMcpServerOptions, autoStart: boolean): Promise<McpServerView> {
    const state = this.ensureState(id);
    if (state.stopPromise) {
      await state.stopPromise;
      return this.startInternal(id, options, autoStart);
    }
    if (state.startPromise) return state.startPromise;
    const queuedStart = this.enqueueTransition(id, async () => {
      const config = this.requireConfig(id);
      if (state.status === 'stopping') throw new Error('MCP server start was stopped.');
      if (state.status === 'ready') return this.view(config);
      if (config.transport === 'stdio') {
        const fingerprint = this.executionFingerprint(config);
        if (autoStart) {
          if (config.localExecutionFingerprint !== fingerprint) {
            throw new Error('MCP autoStart requires a current local execution confirmation.');
          }
        } else {
          if (options.confirmLocalExecution !== true || !options.executionFingerprint) {
            throw new Error('Starting this local MCP server requires explicit execution confirmation.');
          }
          if (options.executionFingerprint !== fingerprint) {
            throw new Error('The MCP server configuration changed after confirmation. Review it and confirm again.');
          }
          const approved: StdioConfig = { ...config, localExecutionFingerprint: fingerprint };
          this.saveConfigs(configList(this.store).map((item) => (item.id === id ? approved : item)));
          return this.startNow(approved, state);
        }
      }
      return this.startNow(config, state);
    });
    const startPromise = queuedStart.finally(() => {
      if (state.startPromise === startPromise) delete state.startPromise;
    });
    state.startPromise = startPromise;
    return startPromise;
  }

  async stop(id: string): Promise<McpServerView> {
    const config = this.requireConfig(id);
    const state = this.ensureState(id);
    if (state.stopPromise) return state.stopPromise;
    const wasConnecting = state.status === 'starting' || state.status === 'connecting';
    state.status = 'stopping';
    state.lastError = null;
    state.runtimeTools = [];
    state.tools = [];
    this.rebuildTools();
    this.publish(config);
    const connection = state.connection;
    state.generation += 1;
    if (connection) {
      connection.stopController.abort();
      if (wasConnecting) void this.closeConnection(connection);
    }
    const stopPromise = this.enqueueTransition(id, async () => {
      const activeStart = state.startPromise;
      if (activeStart) await Promise.allSettled([activeStart]);
      await Promise.allSettled([...state.activeCalls]);
      const activeConnection = state.connection ?? connection;
      if (activeConnection) await this.closeConnection(activeConnection);
      if (state.connection === activeConnection) delete state.connection;
      state.status = 'stopped';
      state.lastError = null;
      this.publish(this.requireConfig(id));
      return this.view(this.requireConfig(id));
    });
    state.stopPromise = stopPromise;
    try {
      return await stopPromise;
    } finally {
      if (state.stopPromise === stopPromise) delete state.stopPromise;
    }
  }

  async startAutoStarted(): Promise<void> {
    const starts = configList(this.store)
      .filter(
        (config) =>
          config.autoStart &&
          (config.transport !== 'stdio' ||
            (config.localExecutionFingerprint !== undefined &&
              config.localExecutionFingerprint === this.executionFingerprint(config))),
      )
      .map((config) => this.startInternal(config.id, {}, true));
    await Promise.allSettled(starts);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(configList(this.store).map((config) => this.stop(config.id)));
  }

  private async startNow(config: StoredMcpServer, state: McpRuntimeState): Promise<McpServerView> {
    state.generation += 1;
    const generation = state.generation;
    state.status = 'starting';
    state.lastError = null;
    state.runtimeTools = [];
    state.tools = [];
    this.rebuildTools();
    this.publish(config);
    const secret = this.redactionSecret(config);
    let transport: McpTransportLike | undefined;
    let connection: NonNullable<McpRuntimeState['connection']> | undefined;
    let stderrTail = '';
    try {
      if (config.transport === 'stdio') {
        const latest = this.requireConfig(config.id);
        const latestFingerprint = latest.transport === 'stdio' ? this.executionFingerprint(latest) : null;
        if (state.generation !== generation || state.status !== 'starting') {
          throw new Error('MCP server start was stopped.');
        }
        if (
          latest.transport !== 'stdio' ||
          latestFingerprint !== this.executionFingerprint(config) ||
          latest.localExecutionFingerprint !== latestFingerprint
        ) {
          throw new Error('The MCP server configuration changed after confirmation. Review it and confirm again.');
        }
        config = latest;
      }
      transport =
        config.transport === 'stdio'
          ? this.dependencies.createStdioTransport({
              command: config.command,
              args: [...config.args],
              ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
              env: { ...(secret.env ?? {}) },
            })
          : this.dependencies.createHttpTransport({
              url: validateHttpUrl(config.url),
              ...(secret.bearerToken ? { bearerToken: secret.bearerToken } : {}),
              allowPrivate: this.privateNetworkConfirmed(config),
            });
      if (config.transport === 'stdio') {
        transport.stderr?.on('data', (chunk: Buffer | string) => {
          stderrTail = `${stderrTail}${chunk.toString()}`.slice(-MCP_STDERR_TAIL_CHARS);
        });
      }
      const client = this.dependencies.createClient({
        onToolsChanged: (error, tools) => {
          if (state.generation !== generation) return;
          if (error) {
            state.lastError = redactText(error.message, secret);
            this.publish(config);
            return;
          }
          if (tools) {
            try {
              this.applyTools(config, state, generation, tools.map(normalizeTool));
            } catch (toolError) {
              state.runtimeTools = [];
              state.tools = [];
              this.rebuildTools();
              state.lastError = redactText(toolError instanceof Error ? toolError.message : String(toolError), secret);
              this.publish(config);
            }
          }
        },
      });
      connection = { client, transport, stopController: new AbortController() };
      state.connection = connection;
      transport.onclose = () => this.connectionClosed(config, state, generation, stderrTail);
      transport.onerror = (error) => {
        if (state.generation !== generation) return;
        state.lastError = redactText(error.message, secret);
        this.publish(config);
      };
      state.status = 'connecting';
      this.publish(config);
      await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS });
      if (state.generation !== generation || state.status !== 'connecting') {
        throw new Error('MCP server start was cancelled.');
      }
      const { tools } = await client.listTools(undefined, {
        cacheMode: 'refresh',
        signal: connection.stopController.signal,
        timeout: MCP_CONNECT_TIMEOUT_MS,
      });
      if (state.generation !== generation || state.status !== 'connecting') {
        throw new Error('MCP server start was cancelled.');
      }
      this.applyTools(config, state, generation, tools.map(normalizeTool));
      state.status = 'ready';
      state.lastError = null;
      this.publish(config);
      return this.view(config);
    } catch (error) {
      let safeMessage =
        String(state.status) === 'stopping' ? 'MCP server start was stopped.' : 'MCP server start failed.';
      if (state.generation === generation) {
        state.runtimeTools = [];
        state.tools = [];
        this.rebuildTools();
        state.status = 'failed';
        const message = error instanceof Error ? error.message : String(error);
        state.lastError = redactText(stderrTail ? `${message}\n${stderrTail}` : message, secret);
        safeMessage = state.lastError;
        this.publish(config);
      }
      if (connection) await this.closeConnection(connection);
      else if (transport) {
        try {
          await transport.close();
        } catch {
          // Preserve the sanitized original failure as the visible status.
        }
      }
      if (state.connection === connection && state.generation === generation) delete state.connection;
      // The upstream error can include credentials; only propagate a sanitized cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(safeMessage, { cause: new Error(safeMessage) });
    }
  }

  private applyTools(
    config: StoredMcpServer,
    state: McpRuntimeState,
    generation: number,
    tools: RuntimeMcpTool[],
  ): void {
    if (state.generation !== generation || !state.connection) return;
    const secret = this.redactionSecret(config);
    try {
      if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
        throw new Error('The MCP server returned duplicate tool names.');
      }
      state.runtimeTools = structuredClone(tools);
      state.tools = tools.map(({ name, description }) => ({
        name: redactText(name, secret),
        description: redactText(description, secret),
      }));
      this.rebuildTools();
    } catch (error) {
      state.runtimeTools = [];
      state.tools = [];
      this.rebuildTools();
      state.lastError = redactText(
        error instanceof Error ? error.message : String(error),
        this.redactionSecret(config),
      );
      this.publish(config);
      throw new Error(state.lastError, { cause: new Error(state.lastError) });
    }
    this.onChange({ type: 'mcp.tools.updated', serverId: config.id, tools: state.tools });
    this.publish(config);
  }

  private rebuildTools(): void {
    const candidates = configList(this.store).flatMap((config) => {
      const state = this.states.get(config.id);
      if (!state?.connection || state.runtimeTools.length === 0) return [];
      const secret = this.redactionSecret(config);
      return state.runtimeTools.map((tool) => {
        const redactedToolName = redactText(tool.name, secret);
        return {
          config,
          tool,
          secret,
          baseName: readableToolName(config.name, redactedToolName),
          legacyName: legacyNamespacedToolName(config.id, redactedToolName),
          toolKey: this.toolIdentity(config.id, tool.name),
        };
      });
    });
    const baseCounts = new Map<string, number>();
    for (const candidate of candidates) {
      baseCounts.set(candidate.baseName, (baseCounts.get(candidate.baseName) ?? 0) + 1);
    }
    const runtimeNames = new Set(this.tools.listBySource('runtime').map(({ definition }) => definition.name));
    const needsSuffix = (candidate: (typeof candidates)[number]): boolean =>
      (baseCounts.get(candidate.baseName) ?? 0) > 1 || runtimeNames.has(candidate.baseName);
    const occupied = new Set([
      ...runtimeNames,
      ...candidates.filter((candidate) => !needsSuffix(candidate)).map((candidate) => candidate.baseName),
    ]);
    const names = new Map<string, string>();
    for (const candidate of [...candidates].sort((left, right) => {
      const serverOrder = left.config.id.localeCompare(right.config.id);
      return serverOrder || left.tool.name.localeCompare(right.tool.name);
    })) {
      const key = `${candidate.config.id}\0${candidate.tool.name}`;
      const name = needsSuffix(candidate)
        ? disambiguatedToolName(candidate.baseName, candidate.config.id, candidate.toolKey, occupied)
        : candidate.baseName;
      if (occupied.has(name) && needsSuffix(candidate)) {
        throw new Error(`MCP tool name collision could not be resolved: ${name}`);
      }
      occupied.add(name);
      names.set(key, name);
    }
    const planned = candidates.map((candidate) => ({
      ...candidate,
      name: names.get(`${candidate.config.id}\0${candidate.tool.name}`)!,
    }));

    const owners = new Set(this.tools.listBySource('mcp').map(({ owner }) => owner));
    for (const owner of owners) this.tools.removeOwner(owner);
    for (const candidate of planned) {
      this.tools.register({
        source: 'mcp',
        owner: this.owner(candidate.config.id),
        target: { serverId: candidate.config.id, toolKey: candidate.toolKey },
        mcpToolName: candidate.tool.name,
        legacyName: candidate.legacyName,
        definition: toolDefinition(candidate.config, candidate.tool, candidate.secret, candidate.name),
        execute: (args, context) => this.executeTool(candidate.config.id, candidate.tool.name, args, context.signal),
      });
    }
  }

  private connectionClosed(
    config: StoredMcpServer,
    state: McpRuntimeState,
    generation: number,
    stderrTail: string,
  ): void {
    if (state.generation !== generation || state.status === 'stopping' || state.status === 'stopped') return;
    state.runtimeTools = [];
    state.tools = [];
    this.rebuildTools();
    state.connection?.stopController.abort();
    delete state.connection;
    state.status = 'failed';
    state.lastError ??= redactText(
      stderrTail || 'MCP server connection closed unexpectedly.',
      this.redactionSecret(config),
    );
    this.publish(config);
  }

  private async executeTool(
    id: string,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const state = this.ensureState(id);
    const connection = state.connection;
    if (state.status !== 'ready' || !connection) throw new Error('MCP server is not connected.');
    if (signal.aborted) throw new DOMException('MCP tool call was interrupted.', 'AbortError');
    const config = this.requireConfig(id);
    const secret = this.redactionSecret(config);
    const combinedSignal = AbortSignal.any([signal, connection.stopController.signal]);
    const call = Promise.resolve().then(() =>
      connection.client.callTool({ name: toolName, arguments: args }, { signal: combinedSignal }),
    );
    state.activeCalls.add(call);
    try {
      const result = await call;
      return redactResult(result, secret);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const safeMessage = redactText(message, secret);
      // The upstream error can include credentials; only propagate a sanitized cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(safeMessage, { cause: new Error(safeMessage) });
    } finally {
      state.activeCalls.delete(call);
    }
  }

  private view(config: StoredMcpServer): McpServerView {
    const state = this.ensureState(config.id);
    const secret = this.secret(config.id);
    const common: McpServerView = {
      id: config.id,
      name: config.name,
      transport: config.transport,
      status: state.status,
      autoStart: config.autoStart,
      visibleByDefault: config.visibleByDefault,
      hasToken: Boolean(secret.bearerToken),
      localExecutionConfirmed:
        config.transport === 'stdio' && config.localExecutionFingerprint === this.executionFingerprint(config),
      privateNetworkConfirmed: config.transport === 'streamable-http' && this.privateNetworkConfirmed(config),
      lastError: state.lastError,
      tools: structuredClone(state.tools),
    };
    if (config.transport === 'stdio') {
      return {
        ...common,
        executionFingerprint: this.executionFingerprint(config),
        command: config.command,
        args: [...config.args],
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        envKeys: Object.keys(secret.env ?? {}).sort(),
      };
    }
    return { ...common, url: sanitizedUrlForView(config.url) };
  }

  private requireConfig(id: string): StoredMcpServer {
    const config = configList(this.store).find((item) => item.id === id);
    if (!config) throw new ServiceError(404, 'MCP server not found.');
    return config;
  }

  private ensureState(id: string): McpRuntimeState {
    let state = this.states.get(id);
    if (!state) {
      state = {
        status: 'stopped',
        lastError: null,
        tools: [],
        runtimeTools: [],
        generation: 0,
        transitionQueue: Promise.resolve(),
        activeCalls: new Set(),
      };
      this.states.set(id, state);
    }
    return state;
  }

  private secret(id: string): McpServerSecret {
    const value = this.store.getPrivateSecret<unknown>(MCP_SECRET_OWNER, id, {});
    if (!isRecord(value)) return {};
    const secret: McpServerSecret = {};
    if (typeof value.bearerToken === 'string') secret.bearerToken = value.bearerToken;
    if (isRecord(value.env)) {
      const env = Object.fromEntries(
        Object.entries(value.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
      if (Object.keys(env).length > 0) secret.env = env;
    }
    return secret;
  }

  private redactionSecret(config: StoredMcpServer): McpServerSecret {
    const secret = this.secret(config.id);
    if (config.transport === 'streamable-http') {
      secret.redactionValues = [...new URL(config.url).searchParams.values()].flatMap((value) => [
        value,
        encodeURIComponent(value),
      ]);
    }
    return secret;
  }

  private privateNetworkConfirmed(config: HttpConfig): boolean {
    return config.confirmPrivateNetworkAccess && config.confirmedPrivateNetworkOrigin === new URL(config.url).origin;
  }

  private saveSecret(id: string, secret: McpServerSecret): void {
    if (!secret.bearerToken && !secret.env) this.store.deletePrivateSecret(MCP_SECRET_OWNER, id);
    else this.store.setPrivateSecret(MCP_SECRET_OWNER, id, secret);
  }

  private saveConfigs(configs: StoredMcpServer[]): void {
    this.store.setSetting(MCP_SERVERS_SETTING, configs);
  }

  private enqueueTransition<T>(id: string, transition: () => Promise<T> | T): Promise<T> {
    const state = this.ensureState(id);
    const next = state.transitionQueue.then(transition, transition);
    state.transitionQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async closeConnection(connection: NonNullable<McpRuntimeState['connection']>): Promise<void> {
    try {
      await connection.client.close();
    } catch {
      try {
        await connection.transport.close();
      } catch {
        // The transport is already closed or failed; stopping remains authoritative.
      }
    }
  }

  private executionFingerprint(config: StdioConfig): string {
    const stored = this.store.getPrivateSecret<unknown>(MCP_SECRET_OWNER, MCP_FINGERPRINT_KEY, {});
    let key: string;
    if (isRecord(stored) && typeof stored.key === 'string' && /^[a-f0-9]{64}$/i.test(stored.key)) {
      key = stored.key;
    } else {
      key = randomBytes(32).toString('hex');
      this.store.setPrivateSecret(MCP_SECRET_OWNER, MCP_FINGERPRINT_KEY, { key });
    }
    const secret = this.secret(config.id);
    const env = Object.entries(effectiveStdioEnvironment(secret)).sort(([left], [right]) => left.localeCompare(right));
    const content = JSON.stringify([
      config.command,
      config.args,
      config.cwd ?? null,
      env,
      resolvedExecutableIdentity(config, Object.fromEntries(env)),
    ]);
    return createHmac('sha256', Buffer.from(key, 'hex')).update(content).digest('hex');
  }

  private toolIdentity(serverId: string, toolName: string): string {
    const stored = this.store.getPrivateSecret<unknown>(MCP_SECRET_OWNER, MCP_TOOL_IDENTITY_KEY, {});
    let key: string;
    if (isRecord(stored) && typeof stored.key === 'string' && /^[a-f0-9]{64}$/i.test(stored.key)) {
      key = stored.key;
    } else {
      key = randomBytes(32).toString('hex');
      this.store.setPrivateSecret(MCP_SECRET_OWNER, MCP_TOOL_IDENTITY_KEY, { key });
    }
    return createHmac('sha256', Buffer.from(key, 'hex'))
      .update(JSON.stringify(['mcp-tool-identity-v1', serverId, toolName]))
      .digest('hex');
  }

  private owner(id: string): string {
    return `mcp:${id}`;
  }

  private publish(config: StoredMcpServer): void {
    this.onChange({ type: 'mcp.server.updated', server: this.view(config) });
  }
}

export type { McpServerInput, McpServerView, StartMcpServerOptions } from '../contracts/mcp.js';
