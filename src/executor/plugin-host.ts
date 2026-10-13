import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolDefinition } from '../core/types.js';
import type { ToolCatalog, ToolContext } from './tools.js';

export interface ExecutorPluginContext {
  tools: {
    register(
      definition: ToolDefinition,
      execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown> | unknown,
    ): void;
  };
}

export interface ExecutorPluginManifest {
  id: string;
  name: string;
  version: string;
  activateExecutor?: (context: ExecutorPluginContext) => Promise<void> | void;
  activate?: (context: unknown) => Promise<void> | void;
}

export interface LoadedExecutorPlugin {
  id: string;
  name: string;
  version: string;
  source: string;
}

export interface ExecutorPluginLoadResult {
  loaded: LoadedExecutorPlugin[];
  errors: string[];
}

export interface ExecutorPluginHostOptions {
  pluginDirectory?: string;
}

export function executorPluginDirectory(): string {
  return resolve(process.env.PICO_EXECUTOR_PLUGIN_DIR?.trim() || join(process.cwd(), 'executor-plugins'));
}

export function validateToolDefinition(value: unknown): ToolDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Tool definition must be an object.');
  const definition = value as Record<string, unknown>;
  if (typeof definition.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(definition.name)) {
    throw new Error('Tool name must start with a letter and contain only letters, numbers, underscores, or hyphens.');
  }
  if (typeof definition.description !== 'string' || !definition.description.trim()) {
    throw new Error(`Tool ${definition.name} must have a description.`);
  }
  const schema = definition.parameters;
  if (
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    (schema as Record<string, unknown>).type !== 'object'
  ) {
    throw new Error(`Tool ${definition.name} parameters must be a JSON object schema.`);
  }
  validateJsonSchema(schema as Record<string, unknown>, `Tool ${definition.name} parameters`);
  return {
    name: definition.name,
    description: definition.description,
    parameters: schema as Record<string, unknown>,
  };
}

function validateJsonSchema(schema: Record<string, unknown>, label: string): void {
  const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  if (schema.type !== undefined && (typeof schema.type !== 'string' || !types.has(schema.type))) {
    throw new Error(`${label} has an unsupported JSON schema type.`);
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      throw new Error(`${label} schema properties must be an object.`);
    }
    for (const [name, child] of Object.entries(schema.properties)) {
      if (!child || typeof child !== 'object' || Array.isArray(child)) {
        throw new Error(`${label} property ${name} must be a JSON schema object.`);
      }
      validateJsonSchema(child as Record<string, unknown>, `${label}.${name}`);
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== 'string')) {
      throw new Error(`${label} schema required must be an array of strings.`);
    }
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (schema.required.some((name) => !properties || !Object.hasOwn(properties, name))) {
      throw new Error(`${label} required names must exist in properties.`);
    }
  }
  if (schema.items !== undefined) {
    if (!schema.items || typeof schema.items !== 'object' || Array.isArray(schema.items)) {
      throw new Error(`${label} schema items must be a JSON schema object.`);
    }
    validateJsonSchema(schema.items as Record<string, unknown>, `${label}[]`);
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    if (
      !schema.additionalProperties ||
      typeof schema.additionalProperties !== 'object' ||
      Array.isArray(schema.additionalProperties)
    ) {
      throw new Error(`${label} schema additionalProperties must be a boolean or schema object.`);
    }
    validateJsonSchema(schema.additionalProperties as Record<string, unknown>, `${label} additional properties`);
  }
}

export function validateToolDefinitions(values: unknown): ToolDefinition[] {
  if (!Array.isArray(values)) throw new Error('Executor tools must be an array.');
  const result = values.map(validateToolDefinition);
  const names = new Set<string>();
  for (const tool of result) {
    if (names.has(tool.name)) throw new Error(`Executor returned duplicate tool name: ${tool.name}.`);
    names.add(tool.name);
  }
  return result;
}

/** Loads self-contained executor plugin manifests from PICO_EXECUTOR_PLUGIN_DIR. */
export async function loadExecutorPlugins(
  catalog: ToolCatalog,
  options: ExecutorPluginHostOptions = {},
): Promise<ExecutorPluginLoadResult> {
  const pluginDirectory = resolve(options.pluginDirectory ?? executorPluginDirectory());
  const loaded: LoadedExecutorPlugin[] = [];
  const errors: string[] = [];
  let filenames: string[] = [];
  try {
    filenames = (await readdir(pluginDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      errors.push(`plugin directory: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { loaded, errors };
  }

  for (const filename of filenames) {
    try {
      const url = pathToFileURL(join(pluginDirectory, filename));
      url.searchParams.set('loadedAt', String(Date.now()));
      const imported = (await import(url.href)) as {
        default?: ExecutorPluginManifest;
        plugin?: ExecutorPluginManifest;
      };
      const manifest = imported.default ?? imported.plugin;
      if (!manifest || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id) || !manifest.name || !manifest.version) {
        throw new Error('Expected a valid Pico plugin manifest.');
      }
      if (typeof manifest.activateExecutor !== 'function') continue;
      if (loaded.some((plugin) => plugin.id === manifest.id)) throw new Error(`Duplicate plugin ID: ${manifest.id}`);
      const staged: Array<{
        definition: ToolDefinition;
        execute: ExecutorPluginContext['tools']['register'] extends (...args: infer P) => void ? P[1] : never;
      }> = [];
      await manifest.activateExecutor({
        tools: {
          register(definition, execute) {
            const validDefinition = validateToolDefinition(definition);
            if (typeof execute !== 'function')
              throw new Error(`Tool ${validDefinition.name} needs an execute function.`);
            if (staged.some((tool) => tool.definition.name === validDefinition.name)) {
              throw new Error(`Plugin ${manifest.id} registered duplicate tool ${validDefinition.name}.`);
            }
            staged.push({ definition: validDefinition, execute });
          },
        },
      });
      // Publish as a unit: a broken plugin cannot leave half of its tools registered.
      for (const tool of staged) {
        if (catalog.get(tool.definition.name)) throw new Error(`Tool ${tool.definition.name} is already registered.`);
      }
      for (const tool of staged) {
        catalog.register({
          owner: manifest.id,
          source: 'executor',
          definition: tool.definition,
          execute: async (args, context) => await tool.execute(args, context),
        });
      }
      loaded.push({ id: manifest.id, name: manifest.name, version: manifest.version, source: filename });
    } catch (error) {
      errors.push(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { loaded, errors };
}
