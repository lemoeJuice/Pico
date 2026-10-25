export type McpServerStatus = 'stopped' | 'starting' | 'connecting' | 'ready' | 'stopping' | 'failed';

interface McpServerInputBase {
  name: string;
  autoStart?: boolean;
}

export type McpServerInput = McpServerInputBase &
  (
    | {
        transport: 'stdio';
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
      }
    | {
        transport: 'streamable-http';
        url: string;
        bearerToken?: string;
        /** Explicitly permits this server to reach private, loopback, and link-local IP addresses. */
        confirmPrivateNetworkAccess?: boolean;
      }
  );

export interface McpServerToolView {
  name: string;
  description: string;
}

export interface McpServerView {
  id: string;
  name: string;
  transport: 'stdio' | 'streamable-http';
  status: McpServerStatus;
  autoStart: boolean;
  hasToken: boolean;
  localExecutionConfirmed: boolean;
  privateNetworkConfirmed: boolean;
  lastError: string | null;
  tools: McpServerToolView[];
  /** Opaque, Runtime-generated binding for stdio execution confirmation. */
  executionFingerprint?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  envKeys?: string[];
}

export interface StartMcpServerOptions {
  confirmLocalExecution?: boolean;
  executionFingerprint?: string;
}
