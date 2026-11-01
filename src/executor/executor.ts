import type { Execution, ExecutorBinding, ExecutorKind } from '../core/types.js';
import type { ToolDefinition } from '../core/types.js';

export interface ExecutorConnectionInfo {
  protocolVersion?: number;
  kind?: string;
  executorVersion?: string;
  updateSupported?: boolean;
  workspaceFileDownload?: boolean;
  workspaceOptional?: boolean;
  leaseHeartbeat?: boolean;
}

export interface ExecutorServiceAddress {
  endpointUrl: string;
  accessToken: string;
  workspacePath?: string;
}

export type ExecutorServiceAddressResolver = (
  binding: ExecutorBinding,
  signal?: AbortSignal,
) => Promise<ExecutorServiceAddress>;

export interface ExecutorAdapter {
  readonly kind: ExecutorKind;
  listTools(binding: ExecutorBinding): Promise<ToolDefinition[]>;
  checkConnection(binding: ExecutorBinding): Promise<void | ExecutorConnectionInfo>;
  update(binding: ExecutorBinding, bundle: Uint8Array, version: string): Promise<{ executorVersion: string }>;
  readWorkspaceFile(binding: ExecutorBinding, path: string, signal?: AbortSignal): Promise<Response>;
  execute(executionId: string, binding: ExecutorBinding, signal?: AbortSignal): Promise<Execution>;
  status(executionId: string, binding: ExecutorBinding): Promise<Execution | null>;
  interrupt(executionId: string, binding: ExecutorBinding): Promise<Execution | null>;
}

export type ExecutionListener = (execution: Execution) => void;

export function requiresExternalExecutor(kind: ExecutorKind): boolean {
  return kind !== 'runtime';
}

export { HostExecutor } from './host-executor.js';
