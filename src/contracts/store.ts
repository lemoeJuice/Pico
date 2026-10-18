import type { TokenUsage } from '../core/types.js';

export interface PluginModelCallRecord {
  id: string;
  pluginId: string;
  idempotencyKey: string;
  threadId: string | null;
  projectId: string | null;
  purpose: string;
  provider: string;
  model: string;
  prompt: unknown;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  response: unknown;
  usage: TokenUsage | null;
  attempts: Array<Record<string, unknown>>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
