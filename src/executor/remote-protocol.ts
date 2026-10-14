import type { ToolDefinition } from '../core/types.js';

export type RemoteExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';

export const EXECUTOR_PROTOCOL_VERSION = 2;

export interface RemoteExecutorInfo {
  protocolVersion: number;
  executorVersion?: string;
  updateSupported?: boolean;
  name: string;
  kind: string;
  workspaceRoot: string;
  tools: ToolDefinition[];
}

export interface RemoteExecutionRequest {
  toolName: string;
  arguments: Record<string, unknown>;
  workspacePath: string;
}

export interface RemoteExecutionState {
  id: string;
  status: RemoteExecutionStatus;
  result?: unknown;
  error?: string;
}

export function remoteExecutorUrl(baseUrl: string, path: string): URL {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const base = new URL(trimmed);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Remote Executor URL must be an http or https URL without credentials, query, or fragment.');
  }
  return new URL(`${base.pathname.replace(/\/+$/, '')}${path}`, base.origin);
}

export function normalizeRemoteExecutorUrl(baseUrl: string): string {
  remoteExecutorUrl(baseUrl, '/api/info');
  const base = new URL(baseUrl.trim());
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
