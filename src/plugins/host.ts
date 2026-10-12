import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import type { CanonicalRecord, Thread, ToolDefinition, UiContribution } from '../core/types.js';
import type { ExecutionPipelines, Interceptor, PipelineStage } from '../core/pipeline.js';
import type { PicoStore } from '../core/store.js';
import type { ToolCatalog, ToolContext } from '../executor/tools.js';

export interface CommandContext {
  thread: Thread | null;
  projectId: string | null;
}

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
  activate(context: PluginContext): Promise<void> | void;
}

export interface PluginContext {
  tools: {
    register(
      definition: ToolDefinition,
      execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown> | unknown,
    ): void;
  };
  pipelines: {
    use<I, O>(stage: PipelineStage, interceptor: Interceptor<I, O>): void;
  };
  commands: { register(command: PluginCommand): void };
  ui: { contribute(contribution: UiContribution): void };
  state: {
    get<T>(key: string, fallback: T): T;
    set<T>(key: string, value: T): void;
  };
  canonical: {
    append(threadId: string, payload: Record<string, unknown>): CanonicalRecord;
    list(threadId: string): CanonicalRecord[];
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

  async execute(text: string, context: CommandContext): Promise<CommandResult | null> {
    if (!text.startsWith('/')) return null;
    const [rawName, ...args] = text.slice(1).trim().split(/\s+/);
    const name = (rawName ?? '').toLowerCase();
    const entry = this.commands.get(name);
    if (!entry) return { text: `Unknown command /${name || '?'}; use /help to see available commands.` };
    return (await entry.command.execute(args, context)) ?? {};
  }
}

export class PluginHost {
  private readonly loaded: LoadedPlugin[] = [];
  private readonly contributions: UiContribution[] = [];
  private readonly loadErrors: string[] = [];

  constructor(
    private readonly store: PicoStore,
    private readonly tools: ToolCatalog,
    private readonly pipelines: ExecutionPipelines,
    readonly commands: CommandRegistry,
    private readonly pluginDirectory = resolve(process.env.PICO_PLUGIN_DIR ?? join(process.cwd(), 'plugins')),
  ) {}

  list(): LoadedPlugin[] {
    return [...this.loaded];
  }

  uiContributions(): UiContribution[] {
    return [...this.contributions];
  }

  errors(): string[] {
    return [...this.loadErrors];
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
    if (!plugin.id || !plugin.name || !plugin.version || typeof plugin.activate !== 'function') {
      throw new Error(`Invalid plugin manifest in ${source}`);
    }
    if (this.loaded.some((item) => item.id === plugin.id)) throw new Error(`Duplicate plugin ID: ${plugin.id}`);
    const contributionsStart = this.contributions.length;
    const context: PluginContext = {
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
      commands: { register: (command) => this.commands.register(plugin.id, command) },
      ui: {
        contribute: (contribution) => {
          if (!['thread.toolbar', 'composer.action', 'sidebar.panel'].includes(contribution.slot)) {
            throw new Error(`Unsupported UI semantic slot: ${contribution.slot}`);
          }
          this.contributions.push({ ...contribution, id: `${plugin.id}:${contribution.id}` });
        },
      },
      state: {
        get: (key, fallback) => this.store.getPluginState(plugin.id, key, fallback),
        set: (key, value) => this.store.setPluginState(plugin.id, key, value),
      },
      canonical: {
        append: (threadId, payload) => this.store.appendPluginRecord(threadId, plugin.id, payload),
        list: (threadId) =>
          this.store
            .listRecords(threadId)
            .filter((record) => record.kind === 'plugin' && record.payload.pluginId === plugin.id),
      },
    };
    try {
      await plugin.activate(context);
      this.loaded.push({ id: plugin.id, name: plugin.name, version: plugin.version, source });
    } catch (error) {
      this.tools.removeOwner(plugin.id);
      this.pipelines.removePlugin(plugin.id);
      this.commands.removeOwner(plugin.id);
      this.contributions.splice(contributionsStart);
      throw error;
    }
  }
}
