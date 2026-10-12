export type PipelineStage = 'step' | 'projection' | 'model' | 'toolBatch' | 'toolInvocation';

export interface Next<I, O> {
  (): Promise<O>;
  (input: I): Promise<O>;
}
export type Interceptor<I = unknown, O = unknown> = (input: I, next: Next<I, O>) => Promise<O>;

interface Entry {
  pluginId: string;
  registration: number;
  interceptor: (input: any, next: any) => Promise<any>;
}

/** Stable, inspectable semantic stages. Registration order is the composition order. */
export class ExecutionPipelines {
  private readonly entries = new Map<PipelineStage, Entry[]>();
  private nextRegistration = 0;

  use<I, O>(stage: PipelineStage, pluginId: string, interceptor: Interceptor<I, O>): void {
    const registered = this.entries.get(stage) ?? [];
    registered.push({
      pluginId,
      registration: this.nextRegistration++,
      interceptor: interceptor as (input: any, next: any) => Promise<any>,
    });
    this.entries.set(stage, registered);
  }

  registrations(): Array<{ stage: PipelineStage; pluginId: string; order: number }> {
    return [...this.entries.entries()].flatMap(([stage, entries]) =>
      entries.map(({ pluginId, registration }) => ({ stage, pluginId, order: registration })),
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
    const entries = [...(this.entries.get(stage) ?? [])].sort((a, b) => a.registration - b.registration);
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
