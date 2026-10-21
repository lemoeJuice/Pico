import type { Thread, ToolDefinition } from '../core/types.js';

export interface ExecutorToolContext {
  workspacePath: string;
  executionId: string;
  signal: AbortSignal;
}

export interface RuntimeToolContext extends ExecutorToolContext {
  thread: Thread;
}

export interface ExecutorToolImplementation {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, context: ExecutorToolContext): Promise<unknown>;
}

export type ToolSource = 'executor' | 'runtime';

export type RegisteredTool =
  | (ExecutorToolImplementation & { owner: string; source: 'executor' })
  | {
      definition: ToolDefinition;
      owner: string;
      source: 'runtime';
      execute(args: Record<string, unknown>, context: RuntimeToolContext): Promise<unknown>;
    };

export class ToolCatalog {
  private readonly items = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.items.has(tool.definition.name)) {
      throw new Error(`Tool ${tool.definition.name} is already registered`);
    }
    this.items.set(tool.definition.name, tool);
  }

  replace(tool: RegisteredTool): void {
    this.items.set(tool.definition.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.items.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.items.values()].map(({ definition }) => definition);
  }

  listBySource(source: ToolSource): RegisteredTool[] {
    return [...this.items.values()].filter((tool) => tool.source === source);
  }

  removeOwner(owner: string): void {
    for (const [name, tool] of this.items) {
      if (tool.owner === owner) this.items.delete(name);
    }
  }
}
