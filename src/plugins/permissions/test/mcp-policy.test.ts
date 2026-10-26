import { expect, it } from 'vitest';
import type { Thread } from '../../../core/types.js';
import { defaultPolicy } from '../../../plugins/permissions.js';

it('defaults MCP tools to ask in the Runtime permission catalog', async () => {
  const hostThread = { executorKind: 'host' } as Thread;
  const runtimeThread = { executorKind: 'runtime' } as Thread;
  expect(defaultPolicy('mcp', hostThread)).toBe('ask');
  expect(defaultPolicy('mcp', runtimeThread)).toBe('ask');
  expect(defaultPolicy('runtime', runtimeThread)).toBe('allow');
});
