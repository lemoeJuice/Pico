import type { PromptTurn } from '../contracts/model.js';
import type { ProjectionProvenance } from '../contracts/runtime.js';
import { isDeepStrictEqual } from 'node:util';

export interface BoundContextProvenance extends ProjectionProvenance {
  threadId: string;
  branchId: string | null;
}

export interface ContextStateSnapshot {
  threadId: string;
  branchId: string | null;
  sourceThrough: number;
  revision: number;
  turns: ReadonlyArray<Readonly<PromptTurn>>;
  provenance: ReadonlyArray<Readonly<BoundContextProvenance>>;
}

export interface ContextStateInput {
  branchId?: string | null;
  /** Canonical boundary used to construct the projection; guards late historical projections. */
  sourceThrough?: number;
  turns: PromptTurn[];
  provenance?: ProjectionProvenance[];
}

export interface ContextAppendInput {
  /** A branch can be selected on first append. Switching branches requires replace(). */
  branchId?: string;
  sourceThrough?: number;
  turns: PromptTurn[];
  /** Turn indexes in this list are relative to the appended turns. */
  provenance?: ProjectionProvenance[];
}

export interface MutableContextState {
  branchId: string | null;
  turns: PromptTurn[];
  provenance: ProjectionProvenance[];
}

export type ContextCommitResult =
  | { committed: true; snapshot: ContextStateSnapshot }
  | { committed: false; snapshot: ContextStateSnapshot };

export type ContextQueuedCommitResult = ContextCommitResult;

export interface QueuedContextCommit {
  replacement: ContextStateInput;
  /** Synchronous external fact write; false means its preconditions no longer hold. */
  commit: () => boolean;
}

export interface ContextTransactionResult<T> {
  value: T;
  snapshot: ContextStateSnapshot;
}

interface StoredContextState {
  branchId: string | null;
  sourceThrough: number;
  revision: number;
  turns: PromptTurn[];
  provenance: ProjectionProvenance[];
}

/**
 * Process-local, per-Thread serialized context state. Every returned or accepted value
 * is cloned so retained snapshots, inputs, and async transaction drafts cannot mutate
 * the stored state after their operation completes.
 */
export class ThreadContextState {
  private readonly states = new Map<string, StoredContextState>();
  private readonly queues = new Map<string, Promise<void>>();

  read(threadId: string): Promise<ContextStateSnapshot> {
    return this.enqueue(threadId, () => this.makeSnapshot(threadId, this.state(threadId)));
  }

  append(threadId: string, input: ContextAppendInput): Promise<ContextStateSnapshot> {
    const captured = clone(input);
    this.assertThreadId(threadId);
    if (captured.sourceThrough !== undefined) this.assertSourceThrough(captured.sourceThrough);
    return this.enqueue(threadId, () => {
      const state = this.state(threadId);
      if (captured.sourceThrough !== undefined) this.assertSourceThrough(captured.sourceThrough);
      if (captured.branchId !== undefined && state.branchId !== null && captured.branchId !== state.branchId) {
        throw new Error('Context branch changed; replace the complete context before appending.');
      }
      const branchId = captured.branchId ?? state.branchId;
      const offset = state.turns.length;
      state.turns.push(...captured.turns);
      state.provenance.push(...(captured.provenance ?? []).map((item) => ({
        ...item,
        ...(item.turnStartIndex === undefined ? {} : { turnStartIndex: item.turnStartIndex + offset }),
        ...(item.turnEndIndex === undefined ? {} : { turnEndIndex: item.turnEndIndex + offset }),
        ...(item.turnIndex === undefined ? {} : { turnIndex: item.turnIndex + offset }),
      })));
      state.branchId = branchId;
      if (captured.sourceThrough !== undefined) state.sourceThrough = Math.max(state.sourceThrough, captured.sourceThrough);
      state.revision += 1;
      return this.makeSnapshot(threadId, state);
    });
  }

  /** Replace the full projected context, suitable for restoring from canonical history. */
  replace(threadId: string, input: ContextStateInput): Promise<ContextStateSnapshot> {
    const captured = clone(input);
    this.assertThreadId(threadId);
    if (captured.sourceThrough !== undefined) this.assertSourceThrough(captured.sourceThrough);
    return this.enqueue(threadId, () => {
      const state = this.state(threadId);
      state.branchId = captured.branchId ?? null;
      state.sourceThrough = captured.sourceThrough ?? 0;
      state.turns = captured.turns;
      state.provenance = captured.provenance ?? [];
      state.revision += 1;
      return this.makeSnapshot(threadId, state);
    });
  }

  /**
   * Reconcile a fresh ordinary projection with the queued state. Exact matches are
   * reads (no revision change), strict suffixes append, and branch/source changes
   * replace the complete projection.
   */
  synchronize(threadId: string, input: ContextStateInput): Promise<ContextStateSnapshot> {
    const captured = clone(input);
    this.assertThreadId(threadId);
    return this.enqueue(threadId, () => {
      const state = this.state(threadId);
      const branchId = captured.branchId ?? null;
      const sourceThrough = captured.sourceThrough ?? state.sourceThrough;
      this.assertSourceThrough(sourceThrough);
      if (sourceThrough < state.sourceThrough) return this.makeSnapshot(threadId, state);
      const provenance = captured.provenance ?? [];
      if (
        state.branchId === branchId &&
        isDeepStrictEqual(state.turns, captured.turns) &&
        isDeepStrictEqual(state.provenance, provenance)
      ) {
        state.sourceThrough = Math.max(state.sourceThrough, sourceThrough);
        return this.makeSnapshot(threadId, state);
      }

      const isTurnPrefix =
        state.turns.length <= captured.turns.length &&
        isDeepStrictEqual(state.turns, captured.turns.slice(0, state.turns.length));
      const isProvenancePrefix =
        state.provenance.length <= provenance.length &&
        isDeepStrictEqual(state.provenance, provenance.slice(0, state.provenance.length));
      if (state.branchId === branchId && isTurnPrefix && isProvenancePrefix) {
        const offset = state.turns.length;
        state.turns.push(...captured.turns.slice(offset));
        state.provenance.push(...provenance.slice(state.provenance.length));
      } else {
        state.turns = captured.turns;
        state.provenance = provenance;
      }
      state.branchId = branchId;
      state.sourceThrough = sourceThrough;
      state.revision += 1;
      return this.makeSnapshot(threadId, state);
    });
  }

  clear(threadId: string): Promise<ContextStateSnapshot> {
    this.assertThreadId(threadId);
    return this.enqueue(threadId, () => {
      const state = this.state(threadId);
      state.branchId = null;
      state.sourceThrough = 0;
      state.turns = [];
      state.provenance = [];
      state.revision += 1;
      return this.makeSnapshot(threadId, state);
    });
  }

  /** Commit a previously prepared replacement only if its observed revision is current. */
  compareAndSwap(
    threadId: string,
    expectedRevision: number,
    replacement: ContextStateInput,
  ): Promise<ContextCommitResult> {
    const captured = clone(replacement);
    this.assertThreadId(threadId);
    if (captured.sourceThrough !== undefined) this.assertSourceThrough(captured.sourceThrough);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new RangeError('Context revision must be a non-negative safe integer.');
    }
    return this.enqueue(threadId, () => {
      const state = this.state(threadId);
      if (state.revision !== expectedRevision) {
        return { committed: false, snapshot: this.makeSnapshot(threadId, state) };
      }
      state.branchId = captured.branchId ?? null;
      state.sourceThrough = captured.sourceThrough ?? state.sourceThrough;
      state.turns = captured.turns;
      state.provenance = captured.provenance ?? [];
      state.revision += 1;
      return { committed: true, snapshot: this.makeSnapshot(threadId, state) };
    });
  }

  /**
   * Compare and synchronously commit external facts plus the replacement projection
   * in one queue slot. The callback must not return a promise: callers must prepare
   * all asynchronous work before entering this per-Thread critical section.
   */
  commitIfRevision(
    threadId: string,
    expectedRevision: number,
    prepare: (snapshot: ContextStateSnapshot) => QueuedContextCommit | null,
  ): Promise<ContextQueuedCommitResult> {
    this.assertThreadId(threadId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new RangeError('Context revision must be a non-negative safe integer.');
    }
    return this.enqueue(threadId, () => {
      const state = this.state(threadId);
      const current = this.makeSnapshot(threadId, state);
      if (state.revision !== expectedRevision) return { committed: false, snapshot: current };
      const prepared = prepare(current);
      if (prepared && typeof (prepared as unknown as { then?: unknown }).then === 'function') {
        throw new TypeError('Queued context preparation callbacks must be synchronous.');
      }
      if (!prepared) return { committed: false, snapshot: current };
      const captured = clone(prepared.replacement);
      if (captured.sourceThrough !== undefined) this.assertSourceThrough(captured.sourceThrough);
      if (typeof prepared.commit !== 'function') throw new TypeError('Queued context commit callback is required.');
      if (!prepared.commit()) return { committed: false, snapshot: current };
      state.branchId = captured.branchId ?? null;
      state.sourceThrough = captured.sourceThrough ?? state.sourceThrough;
      state.turns = captured.turns;
      state.provenance = captured.provenance ?? [];
      state.revision += 1;
      return { committed: true, snapshot: this.makeSnapshot(threadId, state) };
    });
  }

  /** Run an async draft update while holding this Thread's queue slot. */
  transact<T>(
    threadId: string,
    operation: (draft: MutableContextState) => T | Promise<T>,
  ): Promise<ContextTransactionResult<T>> {
    this.assertThreadId(threadId);
    return this.enqueue(threadId, async () => {
      const state = this.state(threadId);
      const draft: MutableContextState = {
        branchId: state.branchId,
        turns: clone(state.turns),
        provenance: clone(state.provenance),
      };
      const value = await operation(draft);
      // Clone at the commit boundary; a closure retaining draft cannot mutate state later.
      const committedDraft = clone(draft);
      const returnedValue = clone(value);
      state.branchId = committedDraft.branchId;
      state.turns = committedDraft.turns;
      state.provenance = committedDraft.provenance;
      state.revision += 1;
      return { value: returnedValue, snapshot: this.makeSnapshot(threadId, state) };
    });
  }

  private enqueue<T>(threadId: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const result = previous.then(operation);
    // Store a fulfilled tail regardless of operation failure so later work still runs.
    this.queues.set(threadId, result.then(() => undefined, () => undefined));
    return result;
  }

  private state(threadId: string): StoredContextState {
    let state = this.states.get(threadId);
    if (!state) {
      state = { branchId: null, sourceThrough: 0, revision: 0, turns: [], provenance: [] };
      this.states.set(threadId, state);
    }
    return state;
  }

  private makeSnapshot(threadId: string, state: StoredContextState): ContextStateSnapshot {
    const provenance: BoundContextProvenance[] = state.provenance.map((item) => ({
      ...clone(item),
      threadId,
      branchId: state.branchId,
      sourceThrough: state.sourceThrough,
    }));
    return {
      threadId,
      branchId: state.branchId,
      sourceThrough: state.sourceThrough,
      revision: state.revision,
      turns: clone(state.turns),
      provenance: clone(provenance),
    };
  }

  private assertThreadId(threadId: string): void {
    if (!threadId.trim()) throw new TypeError('Thread ID must not be empty.');
  }

  private assertSourceThrough(sourceThrough: number): void {
    if (!Number.isSafeInteger(sourceThrough) || sourceThrough < 0) {
      throw new RangeError('Context source boundary must be a non-negative safe integer.');
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
