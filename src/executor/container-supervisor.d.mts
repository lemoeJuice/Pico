import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface ContainerSupervisorOptions {
  agentPath?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  exit?: (code: number) => void;
  signalSource?: Pick<NodeJS.Process, 'once'>;
  onError?: (message: string) => void;
  restartDelay?: number;
}

export declare function runContainerSupervisor(options?: ContainerSupervisorOptions): void;
