import { randomUUID } from 'node:crypto';
import type { ExecutorBinding } from '../core/types.js';
import type { RemoteExecutorLeaseIdentity } from '../executor/remote-executor.js';

type ActivitySource = RemoteExecutorLeaseIdentity['source'];
interface Activity {
  threadId: string;
  identity: RemoteExecutorLeaseIdentity;
  expiresAt: number | null;
}

/** Tracks independent activity sources; the executor owns the actual lease timeout. */
export class ExecutorActivity {
  private readonly runtimeId = randomUUID();
  private readonly activities = new Map<string, Activity>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly bindings = new Map<string, ExecutorBinding>();
  private readonly nextRefreshAt = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly resolve: (threadId: string) => ExecutorBinding | null,
    private readonly heartbeat: (binding: ExecutorBinding, identity: RemoteExecutorLeaseIdentity) => Promise<void>,
    private readonly release: (binding: ExecutorBinding, identity: RemoteExecutorLeaseIdentity) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    this.timer = setInterval(() => this.expire(), 5_000);
    this.timer.unref();
  }

  /** True while any viewer, plugin, Thread, or Runtime lease for this Thread is live. */
  hasThread(threadId: string): boolean {
    const now = Date.now();
    for (const activity of this.activities.values()) {
      if (activity.threadId === threadId && (activity.expiresAt === null || activity.expiresAt > now)) return true;
    }
    return false;
  }

  renew(source: ActivitySource, leaseId: string, threadId: string, ttlMs: number | null): void {
    if (this.closed) return;
    const key = JSON.stringify([source, leaseId]);
    const previous = this.activities.get(key);
    const activity: Activity = {
      threadId,
      identity: { runtimeId: this.runtimeId, source, leaseId },
      expiresAt: ttlMs === null ? null : Date.now() + ttlMs,
    };
    this.activities.set(key, activity);
    const previousBinding = this.bindings.get(key);
    const currentBinding = this.resolve(threadId);
    if (
      !previous ||
      previous.threadId !== threadId ||
      (!previousBinding && !this.queues.has(key)) ||
      (previousBinding && !this.sameBinding(previousBinding, currentBinding))
    )
      this.enqueue(key, previous);
  }

  clear(source: ActivitySource, leaseId: string): void {
    const key = JSON.stringify([source, leaseId]);
    const previous = this.activities.get(key);
    if (!previous) return;
    this.activities.delete(key);
    this.nextRefreshAt.delete(key);
    this.enqueue(key, previous);
  }

  private enqueue(key: string, previous?: Activity): void {
    const prior = this.queues.get(key) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(async () => {
        const oldBinding = this.bindings.get(key);
        const current = this.activities.get(key);
        const binding = current ? this.resolve(current.threadId) : null;
        if (
          oldBinding &&
          (!current || previous?.threadId !== current.threadId || !this.sameBinding(oldBinding, binding))
        ) {
          this.bindings.delete(key);
          await this.release(oldBinding, previous?.identity ?? current!.identity);
        }
        if (!current || this.closed) return;
        if (!binding || binding.kind === 'runtime') return;
        // Local adapters renew successful leases themselves. Retry an initial
        // failure for every kind; remote connections are refreshed here too.
        this.nextRefreshAt.set(key, Date.now() + 20_000);
        await this.heartbeat(binding, current.identity);
        this.bindings.set(key, binding);
        if (!binding.remoteConnectionId) this.nextRefreshAt.delete(key);
        if (this.activities.get(key) !== current && !this.activities.has(key)) {
          this.bindings.delete(key);
          await this.release(binding, current.identity);
        }
      })
      .catch((error: unknown) => this.onError(error));
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  private sameBinding(left: ExecutorBinding, right: ExecutorBinding | null): boolean {
    return Boolean(
      right &&
      left.id === right.id &&
      left.kind === right.kind &&
      left.workspacePath === right.workspacePath &&
      left.remoteConnectionId === right.remoteConnectionId,
    );
  }

  private expire(): void {
    const now = Date.now();
    for (const [key, activity] of this.activities) {
      if (activity.expiresAt !== null && activity.expiresAt <= now) {
        this.activities.delete(key);
        this.nextRefreshAt.delete(key);
        this.enqueue(key, activity);
      } else if ((this.nextRefreshAt.get(key) ?? Infinity) <= now && !this.queues.has(key)) {
        this.nextRefreshAt.set(key, now + 20_000);
        this.enqueue(key, activity);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    clearInterval(this.timer);
    for (const [key, activity] of this.activities) {
      this.activities.delete(key);
      this.enqueue(key, activity);
    }
    this.closed = true;
    await Promise.allSettled([...this.queues.values()]);
  }
}
