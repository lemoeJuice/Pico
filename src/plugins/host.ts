import { ServiceError } from '../contracts/service-error.js';
import type { ExecutorPluginContext } from '../executor/plugin-host.js';
import type { PipelineStage, StageInputs, StageOutputs } from '../contracts/plugin-pipeline.js';
import { unavailablePluginServices, type PluginServices } from './services.js';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import type {
  CanonicalRecord,
  ModelProviderContribution,
  Thread,
  ToolDefinition,
  UiContribution,
} from '../core/types.js';
import type { ExecutionPipelines, Interceptor } from '../core/pipeline.js';
import type { PicoStore } from '../core/store.js';
import type { RuntimeToolContext, ToolCatalog } from '../executor/tool-catalog.js';
import type {
  InitialModelSelection,
  ModelProviderRegistry,
  ModelSelectionNormalizer,
  RegisteredModelHandler,
} from '../runtime/provider-registry.js';

function validExternalAuthOrigins(origins: unknown): origins is string[] {
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 8) return false;
  const seen = new Set<string>();
  return origins.every((origin) => {
    if (typeof origin !== 'string') return false;
    try {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || seen.has(origin))
        return false;
      seen.add(origin);
      return true;
    } catch {
      return false;
    }
  });
}

export interface CommandContext {
  thread: Thread | null;
  projectId: string | null;
  /** The original text after the command name, preserving spaces and newlines. */
  rawArgs: string;
}

export type CommandEnvironment = Omit<CommandContext, 'rawArgs'>;

export interface CommandResult {
  text?: string;
  openThreadId?: string;
  severity?: 'notice' | 'error';
  presentation?: 'timeline';
}

export interface PluginCommand {
  name: string;
  description: string;
  execute(args: string[], context: CommandContext): Promise<CommandResult | void> | CommandResult | void;
}

export interface PicoPlugin {
  id: string;
  name: string;
  version: string;
  /** Runtime tools registered by this plugin are enabled in new Thread defaults only when opted in. */
  defaultToolsEnabled?: boolean;
  pipelinePriority?: Partial<Record<PipelineStage, number>>;
  activate?(context: PluginContext): Promise<void> | void;
  activateExecutor?(context: ExecutorPluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

export interface PluginPageContribution {
  id: string;
  label: string;
  description?: string;
  entry: string;
  group?: string;
  /** Explicit HTTPS origins authorized for marked external-auth buttons in this page. */
  externalAuthOrigins?: string[];
}

export interface PluginHttpRequest {
  body: unknown;
  query: URLSearchParams;
  origin: string | null;
}

interface RegisteredPluginHttpRoute {
  pluginId: string;
  method: string;
  path: string;
  handler(request: PluginHttpRequest): Promise<unknown> | unknown;
}

interface RegisteredPluginPage extends PluginPageContribution {
  pluginId: string;
}

export interface PluginContext extends Omit<PluginServices, 'models' | 'continuations' | 'threads'> {
  threads: Omit<PluginServices['threads'], 'updateTitle'> & {
    updateTitle(threadId: string, title: string): Thread;
    /** Register synchronous, required Thread initialization inside the Thread creation transaction. */
    onCreated(listener: (thread: Thread) => void): () => void;
  };
  tools: {
    register(
      definition: ToolDefinition,
      execute: (args: Record<string, unknown>, context: RuntimeToolContext) => Promise<unknown> | unknown,
    ): void;
  };
  models: {
    complete: (
      request: Parameters<PluginServices['models']['complete']>[1],
    ) => ReturnType<PluginServices['models']['complete']>;
    history: PluginServices['models']['history'];
    subscribe: PluginServices['models']['subscribe'];
    registerProvider(provider: ModelProviderContribution, handler: RegisteredModelHandler): void;
    registerSelectionNormalizer(
      provider: string,
      normalize: ModelSelectionNormalizer,
      initial?: InitialModelSelection,
    ): void;
  };
  continuations: {
    register(hasPendingWork: (threadId: string) => boolean): () => void;
  };
  pipelines: {
    use<S extends PipelineStage>(stage: S, interceptor: Interceptor<StageInputs[S], StageOutputs[S]>): void;
  };
  commands: { register(command: PluginCommand): void };
  ui: {
    contribute(contribution: UiContribution): void;
    registerPage(page: PluginPageContribution): void;
    invalidate(): void;
  };
  http: {
    register(
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      handler: (request: PluginHttpRequest) => Promise<unknown> | unknown,
    ): void;
  };
  state: {
    get<T>(key: string, fallback: T): T;
    set<T>(key: string, value: T): void;
    transaction<T>(run: () => T): T;
    subscribe(listener: () => void): () => void;
  };
  secrets?: {
    get<T>(key: string, fallback: T): T;
    set<T>(key: string, value: T): void;
    delete(key: string): void;
  };
  cache: {
    get<T>(key: string, fallback: T): T;
    set<T>(key: string, value: T): void;
  };
  canonical: {
    append(threadId: string, payload: Record<string, unknown>): CanonicalRecord;
    list(threadId: string): CanonicalRecord[];
    read(threadId: string, options?: { afterSeq?: number; limit?: number }): CanonicalRecord[];
    subscribe(threadId: string, listener: (record: CanonicalRecord) => void): () => void;
  };
}

export interface LoadedPlugin {
  id: string;
  name: string;
  version: string;
  source: string;
}

export interface PluginCatalogEntry extends LoadedPlugin {
  enabled: boolean;
  loaded: boolean;
  hotReloadable: boolean;
  required: boolean;
  error?: string;
}

interface PluginCandidate {
  plugin: PicoPlugin;
  source: string;
  filename?: string;
}

export interface PluginHostOptions {
  canReload?: () => { allowed: boolean; reason?: string };
  onChange?: (pluginId: string) => void;
}

export class CommandRegistry {
  private readonly commands = new Map<string, { owner: string; command: PluginCommand }>();

  register(owner: string, command: PluginCommand): void {
    const name = command.name.replace(/^\/+/, '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error(`Invalid slash command name: ${command.name}`);
    if (this.commands.has(name)) throw new Error(`Slash command /${name} is already registered`);
    this.commands.set(name, { owner, command: { ...command, name } });
  }

  removeOwner(owner: string): void {
    for (const [name, item] of this.commands) if (item.owner === owner) this.commands.delete(name);
  }

  list(): Array<{ name: string; description: string; pluginId: string }> {
    return [...this.commands.values()].map(({ owner, command }) => ({
      name: command.name,
      description: command.description,
      pluginId: owner,
    }));
  }

  owns(owner: string, text: string): boolean {
    const name = text.trim().replace(/^\//, '').split(/\s/, 1)[0]?.toLowerCase() ?? '';
    return text.trim().startsWith('/') && this.commands.get(name)?.owner === owner;
  }

  async execute(text: string, context: CommandEnvironment): Promise<CommandResult | null> {
    if (!text.startsWith('/')) return null;
    const body = text.slice(1).trimStart();
    const separator = body.search(/\s/);
    const rawName = separator < 0 ? body : body.slice(0, separator);
    const rawArgs = separator < 0 ? '' : body.slice(separator).trimStart();
    const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
    const name = (rawName ?? '').toLowerCase();
    const entry = this.commands.get(name);
    if (!entry)
      return { text: `Unknown command /${name || '?'}; use /help to see available commands.`, severity: 'error' };
    return (await entry.command.execute(args, { ...context, rawArgs })) ?? {};
  }
}

export class PluginHost {
  private readonly loaded: LoadedPlugin[] = [];
  private readonly contributions: UiContribution[] = [];
  private readonly pages: RegisteredPluginPage[] = [];
  private readonly routes: RegisteredPluginHttpRoute[] = [];
  private readonly activePlugins: PicoPlugin[] = [];
  private readonly subscriptions = new Map<string, Array<() => void>>();
  private readonly threadCreatedListeners = new Map<string, Set<(thread: Thread) => void>>();
  private readonly continuations = new Map<string, (threadId: string) => boolean>();
  private readonly loadErrors: string[] = [];
  private readonly candidates = new Map<string, PluginCandidate>();
  private readonly candidateErrors = new Map<string, { source: string; error: string }>();
  private readonly enablement = new Map<string, boolean>();
  private readonly lifecycleQueues = new Map<string, Promise<void>>();
  private readonly requiredPlugins = new Set(['pico.workspace', 'pico.commands']);
  private readonly forcedDisabled = new Set<string>();
  private shutdownStarted = false;
  private importSequence = 0;

  constructor(
    private readonly store: PicoStore,
    private readonly tools: ToolCatalog,
    private readonly pipelines: ExecutionPipelines,
    readonly commands: CommandRegistry,
    private readonly pluginDirectory = resolve(process.env.PICO_PLUGIN_DIR ?? join(process.cwd(), 'plugins')),
    private readonly services: PluginServices = unavailablePluginServices,
    private readonly options: PluginHostOptions = {},
    private readonly providerRegistry?: ModelProviderRegistry,
  ) {}

  list(): LoadedPlugin[] {
    return [...this.loaded];
  }

  /** Run required plugin initialization while the caller's Thread creation transaction is open. */
  initializeThread(thread: Thread): void {
    for (const listeners of this.threadCreatedListeners.values()) {
      for (const listener of listeners) listener(thread);
    }
  }

  catalog(): PluginCatalogEntry[] {
    const entries = [...this.candidates.entries()].map(([id, candidate]) => {
      const error = this.candidateErrors.get(id)?.error;
      return {
        id,
        name: candidate.plugin.name,
        version: candidate.plugin.version,
        source: candidate.source,
        enabled: this.enablement.get(id) ?? false,
        loaded: this.loaded.some((plugin) => plugin.id === id),
        hotReloadable: Boolean(candidate.filename),
        required: this.requiredPlugins.has(id),
        ...(error ? { error } : {}),
      };
    });
    for (const [id, diagnostic] of this.candidateErrors) {
      if (this.candidates.has(id)) continue;
      entries.push({
        id,
        name: id,
        version: 'unknown',
        source: diagnostic.source,
        enabled: false,
        loaded: false,
        hotReloadable: true,
        required: this.requiredPlugins.has(id),
        error: diagnostic.error,
      });
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginCatalogEntry[]> {
    return this.withLifecycleLock(pluginId, () => this.applyEnabled(pluginId, enabled));
  }

  private async applyEnabled(pluginId: string, enabled: boolean): Promise<PluginCatalogEntry[]> {
    if (this.shutdownStarted) throw new ServiceError(409, 'Plugin host is shutting down.');
    const candidate = this.candidates.get(pluginId);
    if (!candidate) throw new ServiceError(404, 'Plugin is not installed.');
    if (!enabled && this.requiredPlugins.has(pluginId)) throw new ServiceError(409, 'This plugin is required by Pico.');
    if (enabled && this.forcedDisabled.has(pluginId)) throw new ServiceError(409, 'This plugin is disabled by Runtime policy.');
    if (this.enablement.get(pluginId) === enabled) return this.catalog();
    this.assertLifecycleSafe();
    if (!enabled) {
      await this.deactivatePlugin(pluginId);
      this.enablement.set(pluginId, false);
      this.persistEnablement();
      this.options.onChange?.(pluginId);
      return this.catalog();
    }
    try {
      const plugin = candidate.filename ? await this.importPlugin(candidate.filename) : candidate.plugin;
      candidate.plugin = plugin;
      await this.activate(plugin, candidate.source);
      this.enablement.set(pluginId, true);
      this.candidateErrors.delete(pluginId);
      this.persistEnablement();
      this.options.onChange?.(pluginId);
      return this.catalog();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.candidateErrors.set(pluginId, { source: candidate.source, error: message });
      this.loadErrors.push(`${pluginId}: ${message}`);
      throw error;
    }
  }

  async reload(pluginId: string): Promise<PluginCatalogEntry[]> {
    return this.withLifecycleLock(pluginId, () => this.reloadUnlocked(pluginId));
  }

  private async reloadUnlocked(pluginId: string): Promise<PluginCatalogEntry[]> {
    if (this.shutdownStarted) throw new ServiceError(409, 'Plugin host is shutting down.');
    const candidate = this.candidates.get(pluginId);
    if (!candidate) throw new ServiceError(404, 'Plugin is not installed.');
    if (!this.enablement.get(pluginId)) throw new ServiceError(409, 'This plugin is disabled.');
    this.assertLifecycleSafe();
    const previous = candidate.plugin;
    await this.deactivatePlugin(pluginId);
    try {
      candidate.plugin = candidate.filename ? await this.importPlugin(candidate.filename) : previous;
      await this.activate(candidate.plugin, candidate.source);
      this.candidateErrors.delete(pluginId);
      this.options.onChange?.(pluginId);
      return this.catalog();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.candidateErrors.set(pluginId, { source: candidate.source, error: message });
      this.loadErrors.push(`${pluginId} reload: ${message}`);
      candidate.plugin = previous;
      try {
        await this.activate(previous, candidate.source);
      } catch (restoreError) {
        const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
        this.loadErrors.push(`${pluginId} restore after failed reload: ${restoreMessage}`);
        this.candidateErrors.set(pluginId, {
          source: candidate.source,
          error: `${message}; restore failed: ${restoreMessage}`,
        });
      }
      this.options.onChange?.(pluginId);
      throw new Error(
        `Plugin reload failed; the previous version ${this.loaded.some((item) => item.id === pluginId) ? 'was restored' : 'could not be restored'}: ${message}`,
        { cause: error },
      );
    }
  }

  private assertLifecycleSafe(): void {
    const result = this.options.canReload?.();
    if (result && !result.allowed)
      throw new ServiceError(409, result.reason ?? 'Plugins cannot be changed while Runtime executions are active.');
  }

  private async withLifecycleLock<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleQueues.get(pluginId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.lifecycleQueues.set(pluginId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.lifecycleQueues.get(pluginId) === current) this.lifecycleQueues.delete(pluginId);
    }
  }

  private persistEnablement(): void {
    this.store.setSetting('plugin-enablement', Object.fromEntries(this.enablement));
  }

  private async deactivatePlugin(pluginId: string): Promise<void> {
    const index = this.activePlugins.findIndex((plugin) => plugin.id === pluginId);
    const plugin = index < 0 ? undefined : this.activePlugins[index];
    if (!plugin) {
      this.loaded.splice(0, this.loaded.length, ...this.loaded.filter((item) => item.id !== pluginId));
      return;
    }
    this.activePlugins.splice(index, 1);
    this.loaded.splice(0, this.loaded.length, ...this.loaded.filter((item) => item.id !== pluginId));
    for (const unsubscribe of this.subscriptions.get(pluginId) ?? []) unsubscribe();
    this.subscriptions.delete(pluginId);
    this.continuations.delete(pluginId);
    this.tools.removeOwner(pluginId);
    this.pipelines.removePlugin(pluginId);
    this.commands.removeOwner(pluginId);
    this.contributions.splice(
      0,
      this.contributions.length,
      ...this.contributions.filter((item) => item.pluginId !== pluginId),
    );
    this.pages.splice(0, this.pages.length, ...this.pages.filter((item) => item.pluginId !== pluginId));
    this.providerRegistry?.removeOwner(pluginId);
    this.routes.splice(0, this.routes.length, ...this.routes.filter((item) => item.pluginId !== pluginId));
    try {
      await plugin.deactivate?.();
    } catch (error) {
      this.loadErrors.push(`${pluginId} deactivate: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  uiContributions(): UiContribution[] {
    return [...this.contributions];
  }

  uiPages(): RegisteredPluginPage[] {
    return [...this.pages];
  }

  webUiAssetLocation(
    pluginId: string,
    entry: string,
  ): { pluginsRoot: string; packageRoot: string; assetRoot: string } | undefined {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(pluginId) || !/^[a-z0-9][a-z0-9._-]*$/.test(entry)) return undefined;
    if (!this.loaded.some((plugin) => plugin.id === pluginId)) return undefined;
    const registered =
      this.pages.some((page) => page.pluginId === pluginId && page.entry === entry) ||
      this.contributions.some((contribution) => contribution.pluginId === pluginId && contribution.entry === entry);
    if (!registered) return undefined;
    const pluginsRoot =
      this.loaded.find((plugin) => plugin.id === pluginId)?.source === 'built-in'
        ? resolve(process.cwd(), 'plugins')
        : this.pluginDirectory;
    return {
      pluginsRoot,
      packageRoot: join(pluginsRoot, pluginId),
      assetRoot: join(pluginsRoot, pluginId, 'webui'),
    };
  }

  modelProviders(): ModelProviderContribution[] {
    return this.providerRegistry?.list() ?? [];
  }

  httpRoutes(): ReadonlyArray<RegisteredPluginHttpRoute> {
    return [...this.routes];
  }

  findHttpRoute(pluginId: string, method: string, path: string): RegisteredPluginHttpRoute | undefined {
    return this.routes.find((route) => route.pluginId === pluginId && route.method === method && route.path === path);
  }

  errors(): string[] {
    return [...this.loadErrors];
  }

  hasPendingPluginWork(threadId: string): boolean {
    for (const [pluginId, hasPendingWork] of this.continuations) {
      try {
        if (hasPendingWork(threadId)) return true;
      } catch (error) {
        this.loadErrors.push(`${pluginId} continuation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return false;
  }

  registerContinuation(pluginId: string, hasPendingWork: (threadId: string) => boolean): () => void {
    if (typeof hasPendingWork !== 'function') throw new Error('Plugin continuation must be a function.');
    if (this.continuations.has(pluginId)) throw new Error(`Plugin ${pluginId} already registered a continuation.`);
    this.continuations.set(pluginId, hasPendingWork);
    return () => {
      if (this.continuations.get(pluginId) === hasPendingWork) this.continuations.delete(pluginId);
    };
  }

  async shutdown(): Promise<void> {
    this.shutdownStarted = true;
    for (const { plugin } of [...this.candidates.values()].reverse())
      await this.withLifecycleLock(plugin.id, () => this.deactivatePlugin(plugin.id));
  }

  async load(plugins: PicoPlugin[] = [], defaultDisabled: string[] = []): Promise<LoadedPlugin[]> {
    this.forcedDisabled.clear();
    for (const id of defaultDisabled) this.forcedDisabled.add(id);
    const candidates: PluginCandidate[] = plugins.map((plugin) => ({ plugin, source: 'built-in' }));
    const files: string[] = [];
    try {
      files.push(...(await readdir(this.pluginDirectory)).filter((file) => file.endsWith('.mjs')).sort());
    } catch {
      // The built-in plugin set remains available when there is no user plugin directory.
    }
    for (const filename of files) {
      try {
        const plugin = await this.importPlugin(filename);
        candidates.push({ plugin, source: filename, filename });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.loadErrors.push(`${filename}: ${message}`);
        const id = filename.replace(/\.mjs$/i, '');
        if (/^[a-z0-9][a-z0-9._-]*$/.test(id)) this.candidateErrors.set(id, { source: filename, error: message });
      }
    }
    const persisted = this.store.getSetting<unknown>('plugin-enablement', {});
    const saved =
      persisted && typeof persisted === 'object' && !Array.isArray(persisted)
        ? (persisted as Record<string, unknown>)
        : {};
    for (const { plugin, source, filename } of candidates) {
      if (this.candidates.has(plugin.id)) {
        this.loadErrors.push(`${plugin.id}: Duplicate plugin ID from ${source}`);
        continue;
      }
      this.candidates.set(plugin.id, { plugin, source, ...(filename ? { filename } : {}) });
      const savedValue = saved[plugin.id];
      const enabled = this.forcedDisabled.has(plugin.id) ? false : typeof savedValue === 'boolean' ? savedValue : true;
      this.enablement.set(plugin.id, enabled);
    }
    for (const [pluginId, candidate] of this.candidates) {
      if (!this.enablement.get(pluginId)) continue;
      try {
        await this.activate(candidate.plugin, candidate.source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.loadErrors.push(`${pluginId}: ${message}`);
        this.candidateErrors.set(pluginId, { source: candidate.source, error: message });
      }
    }
    this.options.onChange?.('pico.plugin-manager');
    return this.list();
  }

  private async importPlugin(filename: string): Promise<PicoPlugin> {
    const packageRuntime = join(this.pluginDirectory, filename.replace(/\.mjs$/i, ''), 'runtime.mjs');
    const moduleUrl = pathToFileURL(existsSync(packageRuntime) ? packageRuntime : join(this.pluginDirectory, filename));
    moduleUrl.searchParams.set('loadedAt', `${Date.now()}-${++this.importSequence}`);
    const imported = (await import(moduleUrl.href)) as {
      default?: PicoPlugin;
      plugin?: PicoPlugin;
      createChatGptPlanPlugin?: () => PicoPlugin;
    };
    const plugin = imported.default ?? imported.plugin ?? imported.createChatGptPlanPlugin?.();
    if (!plugin) throw new Error(`Plugin ${filename} must export a default PicoPlugin`);
    return plugin;
  }

  private async activate(plugin: PicoPlugin, source: string): Promise<void> {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(plugin.id) ||
      !plugin.name ||
      !plugin.version ||
      (typeof plugin.activate !== 'function' && typeof plugin.activateExecutor !== 'function')
    ) {
      throw new Error(`Invalid plugin manifest in ${source}`);
    }
    if (this.loaded.some((item) => item.id === plugin.id)) throw new Error(`Duplicate plugin ID: ${plugin.id}`);
    if (!plugin.activate) return;
    const contributionsStart = this.contributions.length;
    const pagesStart = this.pages.length;
    const routesStart = this.routes.length;
    const assertStaticPath = (path: string, label: string): void => {
      if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.split('/').includes('..')) {
        throw new Error(`${label} must be an absolute, static path.`);
      }
    };
    const subscriptions: Array<() => void> = [];
    const context: PluginContext = {
      projects: { ...this.services.projects },
      mcp: { ...this.services.mcp },
      threads: {
        ...this.services.threads,
        updateTitle: (threadId, title) => this.services.threads.updateTitle(plugin.id, threadId, title),
        onCreated: (listener) => {
          let listeners = this.threadCreatedListeners.get(plugin.id);
          if (!listeners) {
            listeners = new Set();
            this.threadCreatedListeners.set(plugin.id, listeners);
          }
          listeners.add(listener);
          const unsubscribe = () => {
            listeners?.delete(listener);
            if (listeners?.size === 0) this.threadCreatedListeners.delete(plugin.id);
          };
          subscriptions.push(unsubscribe);
          return unsubscribe;
        },
        create: (projectId, executorKind, title, options = {}) =>
          this.services.threads.create(projectId, executorKind, title, {
            ...options,
            ...(options.idempotencyKey ? { idempotencyKey: `${plugin.id}:${options.idempotencyKey}` } : {}),
          }),
      },
      executions: {
        ...this.services.executions,
        subscribe: (listener) => {
          const unsubscribe = this.services.executions.subscribe(listener);
          subscriptions.push(unsubscribe);
          return unsubscribe;
        },
      },
      tools: {
        register: (definition, execute) =>
          this.tools.register({
            owner: plugin.id,
            source: 'runtime',
            enabledByDefault: plugin.defaultToolsEnabled === true,
            definition,
            execute: async (args, toolContext) => await execute(args, toolContext),
          }),
      },
      pipelines: {
        use: <S extends PipelineStage>(stage: S, interceptor: Interceptor<StageInputs[S], StageOutputs[S]>) =>
          this.pipelines.use<StageInputs[S], StageOutputs[S]>(
            stage,
            plugin.id,
            interceptor,
            plugin.pipelinePriority?.[stage] ?? 0,
          ),
      },
      models: {
        complete: (request) => this.services.models.complete(plugin.id, request),
        history: this.services.models.history,
        subscribe: (listener) => {
          const unsubscribe = this.services.models.subscribe(listener);
          subscriptions.push(unsubscribe);
          return unsubscribe;
        },
        registerProvider: (provider, handler) => {
          if (!this.providerRegistry) throw new Error('Model provider registry is unavailable.');
          this.providerRegistry.register(plugin.id, provider, handler);
        },
        registerSelectionNormalizer: (provider, normalize, initial) => {
          if (!this.providerRegistry) throw new Error('Model provider registry is unavailable.');
          this.providerRegistry.registerSelectionNormalizer(plugin.id, provider, normalize, initial);
        },
      },
      continuations: {
        register: (hasPendingWork) => {
          const remove = this.registerContinuation(plugin.id, hasPendingWork);
          subscriptions.push(remove);
          return remove;
        },
      },
      commands: { register: (command) => this.commands.register(plugin.id, command) },
      ui: {
        contribute: (contribution) => {
          if (
            ![
              'thread.toolbar',
              'composer.action',
              'composer.model',
              'composer.status',
              'sidebar.panel',
              'tool.result',
            ].includes(contribution.slot)
          ) {
            throw new Error(`Unsupported UI semantic slot: ${contribution.slot}`);
          }
          if (
            (contribution.entry !== undefined && !/^[a-z0-9][a-z0-9._-]*$/.test(contribution.entry)) ||
            (contribution.component !== undefined && !/^[A-Za-z][A-Za-z0-9]*$/.test(contribution.component)) ||
            (contribution.component !== undefined && contribution.entry === undefined)
          ) {
            throw new Error('UI component contributions must name a valid Web UI entry and component.');
          }
          if (
            (contribution.slot === 'composer.model' || contribution.slot === 'tool.result') &&
            (!contribution.entry || !contribution.component)
          ) {
            throw new Error('composer.model and tool.result contributions must name a Web UI entry and component.');
          }
          if (
            contribution.providers !== undefined &&
            (contribution.slot !== 'composer.model' ||
              !Array.isArray(contribution.providers) ||
              contribution.providers.some(
                (provider) => typeof provider !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(provider),
              ))
          ) {
            throw new Error('Provider filters require valid provider IDs in the composer.model slot.');
          }
          if (
            contribution.externalAuthOrigins !== undefined &&
            !validExternalAuthOrigins(contribution.externalAuthOrigins)
          ) {
            throw new Error('External auth popup origins must be unique HTTPS origins.');
          }
          if (
            (contribution.supportsPopover !== undefined && typeof contribution.supportsPopover !== 'boolean') ||
            (contribution.supportsPopover &&
              (!['thread.toolbar', 'composer.model'].includes(contribution.slot) ||
                !contribution.entry ||
                !contribution.component))
          ) {
            throw new Error('Popover controls require a Web UI component in thread.toolbar or composer.model.');
          }
          this.contributions.push({ ...contribution, pluginId: plugin.id, id: `${plugin.id}:${contribution.id}` });
        },
        registerPage: (page) => {
          if (!/^[a-z0-9][a-z0-9._-]*$/.test(page.id)) throw new Error(`Invalid plugin page ID: ${page.id}`);
          if (page.externalAuthOrigins !== undefined && !validExternalAuthOrigins(page.externalAuthOrigins)) {
            throw new Error('External auth popup origins must be unique HTTPS origins.');
          }
          if (!page.label.trim() || !/^[a-z0-9][a-z0-9._-]*$/.test(page.entry)) {
            throw new Error('Plugin pages require a label and a simple Web UI entry name.');
          }
          if (this.pages.some((item) => item.pluginId === plugin.id && item.id === page.id)) {
            throw new Error(`Plugin page ${page.id} is already registered`);
          }
          this.pages.push({ ...page, pluginId: plugin.id });
        },
        invalidate: () => this.options.onChange?.(plugin.id),
      },
      http: {
        register: (method, path, handler) => {
          assertStaticPath(path, 'Plugin API route');
          if (
            this.routes.some((route) => route.pluginId === plugin.id && route.method === method && route.path === path)
          ) {
            throw new Error(`Plugin API route ${method} ${path} is already registered`);
          }
          this.routes.push({ pluginId: plugin.id, method, path, handler });
        },
      },
      state: {
        get: (key, fallback) => this.store.getPluginState(plugin.id, key, fallback),
        set: (key, value) => this.store.setPluginState(plugin.id, key, value),
        transaction: (run) => this.store.transaction(run),
        subscribe: (listener) => {
          const unsubscribe = this.store.subscribePluginState((owner) => {
            if (owner === plugin.id) listener();
          });
          subscriptions.push(unsubscribe);
          return unsubscribe;
        },
      },
      secrets: {
        get: (key, fallback) => this.store.getPrivateSecret(plugin.id, key, fallback),
        set: (key, value) => this.store.setPrivateSecret(plugin.id, key, value),
        delete: (key) => this.store.deletePrivateSecret(plugin.id, key),
      },
      cache: {
        get: (key, fallback) => this.store.getPluginCache(plugin.id, key, fallback),
        set: (key, value) => this.store.setPluginCache(plugin.id, key, value),
      },
      canonical: {
        append: (threadId, payload) => this.store.appendPluginRecord(threadId, plugin.id, payload),
        list: (threadId) => this.store.listRecords(threadId).map((record) => record),
        read: (threadId, options = {}) => this.store.readCanonical(threadId, options.afterSeq, options.limit),
        subscribe: (threadId, listener) => {
          const unsubscribe = this.store.subscribeCanonical((record) => {
            if (record.threadId === threadId) listener(record);
          });
          subscriptions.push(unsubscribe);
          return unsubscribe;
        },
      },
    };
    try {
      await plugin.activate(context);
      this.loaded.push({ id: plugin.id, name: plugin.name, version: plugin.version, source });
      this.activePlugins.push(plugin);
      this.subscriptions.set(plugin.id, subscriptions);
    } catch (error) {
      for (const unsubscribe of subscriptions) unsubscribe();
      this.tools.removeOwner(plugin.id);
      this.pipelines.removePlugin(plugin.id);
      this.commands.removeOwner(plugin.id);
      this.providerRegistry?.removeOwner(plugin.id);
      this.contributions.splice(contributionsStart);
      this.pages.splice(pagesStart);
      this.routes.splice(routesStart);
      this.continuations.delete(plugin.id);
      await plugin.deactivate?.();
      throw error;
    }
  }
}
