import type { PipelineStage } from '../contracts/plugin-pipeline.js';

export type { PipelineStage } from '../contracts/plugin-pipeline.js';
const pipelineStages = [
  'step',
  'projection',
  'model',
  'toolBatch',
  'toolInvocation',
] as const satisfies readonly PipelineStage[];

function assertPipelineStage(stage: string): asserts stage is PipelineStage {
  if (!pipelineStages.includes(stage as PipelineStage)) {
    throw new Error(`Unsupported execution pipeline stage: ${stage}`);
  }
}

export interface Next<I, O> {
  (): Promise<O>;
  (input: I): Promise<O>;
}
export type Interceptor<I = unknown, O = unknown> = (input: I, next: Next<I, O>) => Promise<O>;

interface Entry {
  pluginId: string;
  registration: number;
  priority: number;
  interceptor: (input: any, next: any) => Promise<any>;
}

function ordered(entries: Entry[]): Entry[] {
  return [...entries].sort((left, right) => left.priority - right.priority || left.registration - right.registration);
}

/** Stable, inspectable semantic stages. Registration order is the composition order. */
export class ExecutionPipelines {
  private readonly entries = new Map<PipelineStage, Entry[]>();
  private nextRegistration = 0;

  use<I, O>(stage: PipelineStage, pluginId: string, interceptor: Interceptor<I, O>, priority = 0): void {
    assertPipelineStage(stage);
    if (typeof interceptor !== 'function') throw new Error('Pipeline interceptor must be a function.');
    if (!Number.isFinite(priority)) throw new Error('Pipeline priority must be a finite number.');
    const registered = this.entries.get(stage) ?? [];
    registered.push({
      pluginId,
      registration: this.nextRegistration++,
      priority,
      interceptor: interceptor as (input: any, next: any) => Promise<any>,
    });
    this.entries.set(stage, registered);
  }

  registrations(): Array<{ stage: PipelineStage; pluginId: string; order: number }> {
    return [...this.entries.entries()].flatMap(([stage, entries]) =>
      ordered(entries).map(({ pluginId }, order) => ({ stage, pluginId, order })),
    );
  }

  removePlugin(pluginId: string): void {
    for (const [stage, entries] of this.entries) {
      this.entries.set(
        stage,
        entries.filter((entry) => entry.pluginId !== pluginId),
      );
    }
  }

  run<I, O>(stage: PipelineStage, input: I, terminal: (input: I) => Promise<O>): Promise<O> {
    assertPipelineStage(stage);
    const entries = ordered(this.entries.get(stage) ?? []);
    let index = -1;
    const dispatch = async (position: number, value: I): Promise<O> => {
      if (position <= index) throw new Error(`Pipeline ${stage} next() called more than once`);
      index = position;
      const entry = entries[position];
      if (!entry) return terminal(value);
      const next = ((replacement?: I) =>
        dispatch(position + 1, replacement === undefined ? value : (replacement as I))) as Next<I, O>;
      return entry.interceptor(value, next) as Promise<O>;
    };
    return dispatch(0, input);
  }
}
