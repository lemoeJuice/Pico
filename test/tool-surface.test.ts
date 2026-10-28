import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../src/core/types.js';
import type { McpToolTarget } from '../src/executor/tool-catalog.js';
import { resolveToolSurface } from '../src/runtime/tool-surface.js';

function tool(name: string, parameters: Record<string, unknown> = { type: 'object' }): ToolDefinition {
  return { name, description: `${name} description`, parameters };
}

function target(serverId: string, toolKey: string): McpToolTarget {
  return { serverId, toolKey };
}

function expectedMcpAlias(name: string, mcpTarget: McpToolTarget, length: number): string {
  const digest = createHash('sha256').update(`${mcpTarget.serverId}\0${mcpTarget.toolKey}`).digest('hex');
  return `${name.slice(0, 63 - length).replace(/[_-]+$/g, '')}_${digest.slice(0, length)}`;
}

describe('resolveToolSurface', () => {
  it('combines Runtime, Executor, and MCP tools while preserving source and target identity', () => {
    const runtime = tool('runtime_tool');
    const runtimeSecond = tool('runtime_tool_second');
    const executor = tool('executor_tool');
    const executorSecond = tool('executor_tool_second');
    const mcpTarget = target('server-a', 'search');
    const parameters = { type: 'object', properties: { query: { type: 'string' } } };
    const mcp = tool('search', parameters);

    const surface = resolveToolSurface(
      [runtime, runtimeSecond],
      [executor, executorSecond],
      [{ definition: mcp, target: mcpTarget, mcpToolName: 'search' }],
    );

    expect(surface.tools).toEqual([runtime, runtimeSecond, mcp, executor, executorSecond]);
    expect(surface.sources).toEqual({
      runtime_tool: 'runtime',
      runtime_tool_second: 'runtime',
      search: 'mcp',
      executor_tool: 'executor',
      executor_tool_second: 'executor',
    });
    expect(surface.mcpTargets).toEqual({ search: mcpTarget });
    expect(surface.tools[2]?.parameters).toBe(parameters);
  });

  it('throws when Runtime and Executor register the same name', () => {
    expect(() => resolveToolSurface([tool('shared')], [tool('shared')], [])).toThrow(
      /Tool name collision: shared is registered by both Runtime and Executor sources\./,
    );
  });

  it('renames an MCP tool that conflicts with a Runtime tool', () => {
    const mcpTarget = target('server-a', 'lookup');
    const surface = resolveToolSurface([tool('lookup')], [], [{ definition: tool('lookup'), target: mcpTarget }]);
    const alias = expectedMcpAlias('lookup', mcpTarget, 8);

    expect(surface.tools.map((definition) => definition.name)).toEqual(['lookup', alias]);
    expect(surface.sources[alias]).toBe('mcp');
    expect(surface.mcpTargets[alias]).toEqual(mcpTarget);
  });

  it('renames an MCP tool that conflicts with an Executor tool', () => {
    const mcpTarget = target('server-a', 'lookup');
    const surface = resolveToolSurface([], [tool('lookup')], [{ definition: tool('lookup'), target: mcpTarget }]);
    const alias = expectedMcpAlias('lookup', mcpTarget, 8);

    expect(surface.tools.map((definition) => definition.name)).toEqual([alias, 'lookup']);
    expect(surface.sources).toEqual({ [alias]: 'mcp', lookup: 'executor' });
    expect(surface.mcpTargets[alias]).toEqual(mcpTarget);
  });

  it('extends a short hash collision and preserves MCP definition and target identity', () => {
    const mcpTarget = target('server-a', 'lookup');
    const parameters = { type: 'object', additionalProperties: false };
    const mcpDefinition = tool('lookup', parameters);
    const occupiedShortAlias = expectedMcpAlias('lookup', mcpTarget, 8);
    const surface = resolveToolSurface(
      [],
      [tool('lookup'), tool(occupiedShortAlias)],
      [{ definition: mcpDefinition, target: mcpTarget, mcpToolName: 'lookup' }],
    );
    const longAlias = expectedMcpAlias('lookup', mcpTarget, 12);

    expect(surface.tools.map((definition) => definition.name)).toEqual([longAlias, 'lookup', occupiedShortAlias]);
    expect(surface.tools[0]).toMatchObject({ description: mcpDefinition.description, parameters });
    expect(surface.tools[0]?.parameters).toBe(parameters);
    expect(surface.mcpTargets[longAlias]).toBe(mcpTarget);
    expect(surface.sources[longAlias]).toBe('mcp');
  });

  it('keeps the same MCP name-to-target mapping when the input order changes', () => {
    const firstTarget = target('server-a', 'lookup');
    const secondTarget = target('server-b', 'lookup');
    const first = { definition: tool('lookup'), target: firstTarget };
    const second = { definition: tool('lookup'), target: secondTarget };
    const forward = resolveToolSurface([], [], [first, second]);
    const reversed = resolveToolSurface([], [], [second, first]);

    expect(forward.mcpTargets).toEqual(reversed.mcpTargets);
    expect(forward.tools.map((definition) => definition.name)).toEqual(
      reversed.tools.map((definition) => definition.name),
    );
    expect(forward.mcpTargets.lookup).toEqual(firstTarget);
    expect(forward.mcpTargets[expectedMcpAlias('lookup', secondTarget, 8)]).toEqual(secondTarget);
  });
});
