import type { ExecutorPluginContext } from '../executor/plugin-host.js';
import { unavailablePluginServices, type PluginServices } from './services.js';
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
import type { ExecutionPipelines, Interceptor, PipelineStage } from '../core/pipeline.js';
import type { PicoStore } from '../core/store.js';
import type { ToolCatalog, ToolContext } from '../executor/tools.js';

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
  activate?(context: PluginContext): Promise<void> | void;
  activateExecutor?(context: ExecutorPluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

export interface PluginPageContribution {
  id: string;
  label: string;
  description?: string;
  entry: string;
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

export interface PluginContext extends PluginServices {
  tools: {
    register(
      definition: ToolDefinition,
      execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown> | unknown,
    ): void;
  };
  models: { registerProvider(provider: ModelProviderContribution): void };
  pipelines: {
    use<I, O>(stage: PipelineStage, interceptor: Interceptor<I, O>): void;
  };
  commands: { register(command: PluginCommand): void };
  ui: {
    contribute(contribution: UiContribution): void;
    registerPage(page: PluginPageContribution): void;
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

  list(): Array<{ name: string; description: string }> {
    return [...this.commands.values()].map(({ command }) => ({ name: command.name, description: command.description }));
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
    if (!entry) return { text: `Unknown command /${name || '?'}; use /help to see available commands.` };
    return (await entry.command.execute(args, { ...context, rawArgs })) ?? {};
  }
}

export class PluginHost {
  private readonly loaded: LoadedPlugin[] = [];
  private readonly contributions: UiContribution[] = [];
  private readonly pages: RegisteredPluginPage[] = [];
  private readonly providers: Array<{ pluginId: string } & ModelProviderContribution> = [
    { pluginId: 'pico.core', id: 'openai-compatible', label: 'OpenAI-compatible API key' },
  ];
  private readonly routes: RegisteredPluginHttpRoute[] = [];
  private readonly activePlugins: PicoPlugin[] = [];
  private readonly subscriptions = new Map<string, Array<() => void>>();
  private readonly loadErrors: string[] = [];

  constructor(
    private readonly store: PicoStore,
    private readonly tools: ToolCatalog,
    private readonly pipelines: ExecutionPipelines,
    readonly commands: CommandRegistry,
    private readonly pluginDirectory = resolve(process.env.PICO_PLUGIN_DIR ?? join(process.cwd(), 'plugins')),
    private readonly services: PluginServices = unavailablePluginServices,
  ) {}

  list(): LoadedPlugin[] {
    return [...this.loaded];
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
    return this.providers.map(({ id, label, description }) => ({ id, label, ...(description ? { description } : {}) }));
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

  async shutdown(): Promise<void> {
    for (const plugin of this.activePlugins.splice(0).reverse()) {
      for (const unsubscribe of this.subscriptions.get(plugin.id) ?? []) unsubscribe();
      this.subscriptions.delete(plugin.id);
      try {
        await plugin.deactivate?.();
      } catch (error) {
        this.loadErrors.push(`${plugin.id} shutdown: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async load(plugins: PicoPlugin[] = []): Promise<LoadedPlugin[]> {
    const candidates: Array<{ plugin: PicoPlugin; source: string }> = plugins.map((plugin) => ({
      plugin,
      source: 'built-in',
    }));
    const files: string[] = [];
    try {
      files.push(...(await readdir(this.pluginDirectory)).filter((file) => file.endsWith('.mjs')).sort());
    } catch {
      // The built-in plugin set remains available when there is no user plugin directory.
    }
    for (const filename of files) {
      try {
        const moduleUrl = pathToFileURL(join(this.pluginDirectory, filename));
        moduleUrl.searchParams.set('loadedAt', String(Date.now()));
        const imported = (await import(moduleUrl.href)) as { default?: PicoPlugin; plugin?: PicoPlugin };
        const plugin = imported.default ?? imported.plugin;
        if (!plugin) throw new Error(`Plugin ${filename} must export a default PicoPlugin`);
        candidates.push({ plugin, source: filename });
      } catch (error) {
        this.loadErrors.push(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const { plugin, source } of candidates) {
      try {
        await this.activate(plugin, source);
      } catch (error) {
        this.loadErrors.push(`${plugin.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return this.list();
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
    const providersStart = this.providers.length;
    const routesStart = this.routes.length;
    const assertStaticPath = (path: string, label: string): void => {
      if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.split('/').includes('..')) {
        throw new Error(`${label} must be an absolute, static path.`);
      }
    };
    const subscriptions: Array<() => void> = [];
    const context: PluginContext = {
      threads: this.services.threads,
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
            definition,
            execute: async (args, toolContext) => await execute(args, toolContext),
          }),
      },
      pipelines: {
        use: (stage, interceptor) => this.pipelines.use(stage, plugin.id, interceptor),
      },
      models: {
        registerProvider: (provider) => {
          if (!/^[a-z0-9][a-z0-9._-]*$/.test(provider.id)) throw new Error(`Invalid model provider ID: ${provider.id}`);
          if (!provider.label.trim()) throw new Error('Model provider label is required.');
          if (this.providers.some((item) => item.id === provider.id)) {
            throw new Error(`Model provider ${provider.id} is already registered`);
          }
          this.providers.push({ ...provider, pluginId: plugin.id });
        },
      },
      commands: { register: (command) => this.commands.register(plugin.id, command) },
      ui: {
        contribute: (contribution) => {
          if (
            !['thread.toolbar', 'composer.action', 'composer.model', 'sidebar.panel', 'tool.renderer'].includes(
              contribution.slot,
            )
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
            (contribution.slot === 'composer.model' || contribution.slot === 'tool.renderer') &&
            (!contribution.entry || !contribution.component)
          ) {
            throw new Error('composer.model contributions must name a Web UI entry and component.');
          }
          if (
            (contribution.controlWidthPx !== undefined &&
              (!Number.isFinite(contribution.controlWidthPx) ||
                contribution.controlWidthPx < 24 ||
                contribution.controlWidthPx > 420)) ||
            (contribution.controlHeightPx !== undefined &&
              (!Number.isFinite(contribution.controlHeightPx) ||
                contribution.controlHeightPx < 24 ||
                contribution.controlHeightPx > 64)) ||
            (contribution.supportsPopover !== undefined && typeof contribution.supportsPopover !== 'boolean') ||
            (contribution.supportsPopover &&
              (contribution.slot !== 'thread.toolbar' ||
                contribution.controlWidthPx === undefined ||
                contribution.controlHeightPx === undefined))
          ) {
            throw new Error('Toolbar popovers require valid control dimensions and the thread.toolbar slot.');
          }
          this.contributions.push({ ...contribution, pluginId: plugin.id, id: `${plugin.id}:${contribution.id}` });
        },
        registerPage: (page) => {
          if (!/^[a-z0-9][a-z0-9._-]*$/.test(page.id)) throw new Error(`Invalid plugin page ID: ${page.id}`);
          if (!page.label.trim() || !/^[a-z0-9][a-z0-9._-]*$/.test(page.entry)) {
            throw new Error('Plugin pages require a label and a simple Web UI entry name.');
          }
          if (this.pages.some((item) => item.pluginId === plugin.id && item.id === page.id)) {
            throw new Error(`Plugin page ${page.id} is already registered`);
          }
          this.pages.push({ ...page, pluginId: plugin.id });
        },
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
      this.contributions.splice(contributionsStart);
      this.pages.splice(pagesStart);
      this.providers.splice(providersStart);
      this.routes.splice(routesStart);
      await plugin.deactivate?.();
      throw error;
    }
  }
}
