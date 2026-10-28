import { createHash } from 'node:crypto';
import type { ToolDefinition } from '../core/types.js';
import type { McpToolTarget } from '../executor/tool-catalog.js';

export interface McpToolSurfaceInput {
  definition: ToolDefinition;
  target: McpToolTarget;
  mcpToolName?: string;
}

export interface ToolSurface {
  tools: ToolDefinition[];
  sources: Record<string, 'runtime' | 'executor' | 'mcp'>;
  mcpTargets: Record<string, McpToolTarget>;
}

function disambiguatedMcpToolName(name: string, target: McpToolTarget, occupied: Set<string>): string {
  const digest = createHash('sha256').update(`${target.serverId}\0${target.toolKey}`).digest('hex');
  for (const length of [8, 12, 16, 24, 32]) {
    const suffix = digest.slice(0, length);
    const candidate = `${name.slice(0, 63 - suffix.length).replace(/[_-]+$/g, '')}_${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error(`MCP tool name collision could not be resolved: ${name}`);
}

export function resolveToolSurface(
  runtimeTools: ToolDefinition[],
  executorTools: ToolDefinition[],
  mcpTools: McpToolSurfaceInput[],
): ToolSurface {
  const runtimeNames = new Set(runtimeTools.map((tool) => tool.name));
  const executorNames = new Set(executorTools.map((tool) => tool.name));
  for (const name of runtimeNames) {
    if (executorNames.has(name)) {
      throw new Error(`Tool name collision: ${name} is registered by both Runtime and Executor sources.`);
    }
  }

  const occupied = new Set([...runtimeNames, ...executorNames]);
  const sources: ToolSurface['sources'] = {};
  const mcpTargets: Record<string, McpToolTarget> = {};
  const tools: ToolDefinition[] = [];

  for (const definition of runtimeTools) {
    tools.push(definition);
    sources[definition.name] = 'runtime';
  }

  const orderedMcpTools = [...mcpTools].sort((left, right) => {
    const serverOrder =
      left.target.serverId < right.target.serverId ? -1 : left.target.serverId > right.target.serverId ? 1 : 0;
    if (serverOrder !== 0) return serverOrder;
    return left.target.toolKey < right.target.toolKey ? -1 : left.target.toolKey > right.target.toolKey ? 1 : 0;
  });
  for (const registered of orderedMcpTools) {
    const originalName = registered.definition.name;
    const name = occupied.has(originalName)
      ? disambiguatedMcpToolName(originalName, registered.target, occupied)
      : originalName;
    const definition = name === originalName ? registered.definition : { ...registered.definition, name };
    tools.push(definition);
    sources[name] = 'mcp';
    mcpTargets[name] = registered.target;
    occupied.add(name);
  }

  for (const definition of executorTools) {
    tools.push(definition);
    sources[definition.name] = 'executor';
  }

  return { tools, sources, mcpTargets };
}
