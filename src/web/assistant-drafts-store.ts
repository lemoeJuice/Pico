import {
  appendAssistantDraft,
  appendAssistantPreview,
  clearAssistantDraft,
  type AssistantDrafts,
  type ToolCallPreview,
} from './assistant-drafts.js';

export interface AssistantDraftContent {
  executionId: string;
  text: string;
  unconfirmed?: boolean;
  previewIncomplete?: boolean;
  reasoningSummary?: string;
}

export interface AssistantToolPreviewSlot {
  index: number;
  name?: string;
}

type Listener = () => void;
type ScheduleContentNotification = (callback: () => void) => void;
const EMPTY_TOOL_SLOTS: readonly AssistantToolPreviewSlot[] = [];

function scheduleContentNotification(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
  else callback();
}

function toolSubscriptionKey(threadId: string, executionId: string, index: number): string {
  return `${threadId}\u0000${executionId}\u0000${index}`;
}

function toolListSubscriptionKey(threadId: string, executionId: string): string {
  return `${threadId}\u0000${executionId}`;
}

function sameToolSlots(left: readonly AssistantToolPreviewSlot[], right: readonly AssistantToolPreviewSlot[]): boolean {
  return (
    left.length === right.length &&
    left.every((slot, index) => slot.index === right[index]?.index && slot.name === right[index]?.name)
  );
}

export class AssistantDraftStore {
  private drafts: AssistantDrafts = {};
  private readonly contentSnapshots = new Map<string, AssistantDraftContent>();
  private readonly toolSlots = new Map<string, { executionId: string; slots: readonly AssistantToolPreviewSlot[] }>();
  private readonly contentListeners = new Map<string, Set<Listener>>();
  private readonly executionListeners = new Map<string, Set<Listener>>();
  private readonly toolListListeners = new Map<string, Set<Listener>>();
  private readonly toolListeners = new Map<string, Set<Listener>>();
  private readonly pendingContentNotifications = new Map<string, object>();

  constructor(private readonly scheduleContent: ScheduleContentNotification = scheduleContentNotification) {}

  getAll(): AssistantDrafts {
    return this.drafts;
  }

  getContent(threadId: string): AssistantDraftContent | null {
    return this.contentSnapshots.get(threadId) ?? null;
  }

  getExecutionId(threadId: string): string | null {
    return this.drafts[threadId]?.executionId ?? null;
  }

  getToolSlots(threadId: string, executionId: string): readonly AssistantToolPreviewSlot[] {
    const current = this.toolSlots.get(threadId);
    return current?.executionId === executionId ? current.slots : EMPTY_TOOL_SLOTS;
  }

  getToolPreview(threadId: string, executionId: string, index: number): ToolCallPreview | null {
    const current = this.drafts[threadId];
    return current?.executionId === executionId ? (current.tools?.find((call) => call.index === index) ?? null) : null;
  }

  subscribeContent(threadId: string, listener: Listener): () => void {
    return this.subscribe(this.contentListeners, threadId, listener);
  }

  subscribeExecution(threadId: string, listener: Listener): () => void {
    return this.subscribe(this.executionListeners, threadId, listener);
  }

  subscribeToolSlots(threadId: string, executionId: string, listener: Listener): () => void {
    return this.subscribe(this.toolListListeners, toolListSubscriptionKey(threadId, executionId), listener);
  }

  subscribeToolPreview(threadId: string, executionId: string, index: number, listener: Listener): () => void {
    return this.subscribe(this.toolListeners, toolSubscriptionKey(threadId, executionId, index), listener);
  }

  appendText(threadId: string, executionId: string, delta: string): void {
    this.replaceDrafts(appendAssistantDraft(this.drafts, threadId, executionId, delta), true);
  }

  appendPreview(
    threadId: string,
    executionId: string,
    preview: { type: 'reasoning'; delta: string } | { type: 'tool'; call: ToolCallPreview },
  ): void {
    const current = this.drafts[threadId];
    if (current?.executionId === executionId && current.previewIncomplete) return;
    this.replaceDrafts(appendAssistantPreview(this.drafts, threadId, executionId, preview));
  }

  markUnconfirmed(threadId: string, executionId: string): void {
    const draft = this.drafts[threadId];
    if (!draft || draft.executionId !== executionId || draft.unconfirmed) return;
    this.replaceDrafts({ ...this.drafts, [threadId]: { ...draft, unconfirmed: true } });
  }

  resumeText(threadId: string, executionId: string, offset: number, text: string): boolean {
    const draft = this.drafts[threadId];
    if ((draft && draft.executionId !== executionId) || (draft?.text.length ?? 0) < offset) return false;
    const currentText = draft?.text ?? '';
    const overlap = Math.min(currentText.length - offset, text.length);
    if (currentText.slice(offset, offset + overlap) !== text.slice(0, overlap)) return false;
    this.replaceDrafts({
      ...this.drafts,
      [threadId]: {
        ...(draft ?? {}),
        executionId,
        text: currentText + text.slice(overlap),
        unconfirmed: false,
        previewIncomplete: true,
      },
    });
    return true;
  }

  clear(threadId: string, executionId?: string): void {
    this.replaceDrafts(clearAssistantDraft(this.drafts, threadId, executionId));
  }

  clearAll(): void {
    this.replaceDrafts({});
  }

  markDisconnected(): void {
    const next: AssistantDrafts = {};
    for (const [threadId, draft] of Object.entries(this.drafts)) {
      next[threadId] = draft.unconfirmed ? draft : { ...draft, unconfirmed: true };
    }
    this.replaceDrafts(next);
  }

  private subscribe(registry: Map<string, Set<Listener>>, key: string, listener: Listener): () => void {
    const listeners = registry.get(key) ?? new Set<Listener>();
    listeners.add(listener);
    registry.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) registry.delete(key);
    };
  }

  private notify(registry: Map<string, Set<Listener>>, key: string): void {
    for (const listener of registry.get(key) ?? []) listener();
  }

  private notifyContent(threadId: string, deferred: boolean): void {
    if (!deferred) {
      this.pendingContentNotifications.delete(threadId);
      this.notify(this.contentListeners, threadId);
      return;
    }
    if (this.pendingContentNotifications.has(threadId)) return;
    const pending = {};
    this.pendingContentNotifications.set(threadId, pending);
    this.scheduleContent(() => {
      if (this.pendingContentNotifications.get(threadId) !== pending) return;
      this.pendingContentNotifications.delete(threadId);
      this.notify(this.contentListeners, threadId);
    });
  }

  private replaceDrafts(next: AssistantDrafts, deferContent = false): void {
    if (next === this.drafts) return;
    const previous = this.drafts;
    this.drafts = next;
    const threadIds = new Set([...Object.keys(previous), ...Object.keys(next)]);

    for (const threadId of threadIds) {
      const before = previous[threadId];
      const after = next[threadId];
      const beforeContent = this.contentSnapshots.get(threadId) ?? null;
      const afterContent = after
        ? {
            executionId: after.executionId,
            text: after.text,
            ...(after.unconfirmed ? { unconfirmed: true } : {}),
            ...(after.previewIncomplete ? { previewIncomplete: true } : {}),
            ...(after.reasoningSummary === undefined ? {} : { reasoningSummary: after.reasoningSummary }),
          }
        : null;
      if (
        beforeContent?.executionId !== afterContent?.executionId ||
        beforeContent?.text !== afterContent?.text ||
        beforeContent?.unconfirmed !== afterContent?.unconfirmed ||
        beforeContent?.previewIncomplete !== afterContent?.previewIncomplete ||
        beforeContent?.reasoningSummary !== afterContent?.reasoningSummary
      ) {
        if (afterContent) this.contentSnapshots.set(threadId, afterContent);
        else this.contentSnapshots.delete(threadId);
        this.notifyContent(threadId, deferContent);
      }

      if (before?.executionId !== after?.executionId) this.notify(this.executionListeners, threadId);

      const afterSlots =
        after?.tools?.map(({ index, name }) => ({ index, ...(name === undefined ? {} : { name }) })) ?? [];
      const cachedSlots = this.toolSlots.get(threadId);
      const previousSlots = cachedSlots?.slots ?? EMPTY_TOOL_SLOTS;
      const previousExecutionId = cachedSlots?.executionId ?? before?.executionId;
      if (previousExecutionId !== after?.executionId || !sameToolSlots(previousSlots, afterSlots)) {
        if (after?.executionId && afterSlots.length > 0) {
          const stableSlots = sameToolSlots(previousSlots, afterSlots) ? previousSlots : afterSlots;
          this.toolSlots.set(threadId, { executionId: after.executionId, slots: stableSlots });
        } else {
          this.toolSlots.delete(threadId);
        }
        if (previousExecutionId)
          this.notify(this.toolListListeners, toolListSubscriptionKey(threadId, previousExecutionId));
        if (after?.executionId && after.executionId !== previousExecutionId) {
          this.notify(this.toolListListeners, toolListSubscriptionKey(threadId, after.executionId));
        }
      } else if (after?.executionId && cachedSlots && cachedSlots.slots !== previousSlots) {
        this.toolSlots.set(threadId, { executionId: after.executionId, slots: previousSlots });
      }

      const beforeTools = before?.tools ?? [];
      const afterTools = after?.tools ?? [];
      const indices = new Set([...beforeTools.map((call) => call.index), ...afterTools.map((call) => call.index)]);
      for (const index of indices) {
        const oldCall =
          before?.executionId === after?.executionId ? beforeTools.find((call) => call.index === index) : undefined;
        const newCall = afterTools.find((call) => call.index === index);
        if (oldCall !== newCall || before?.executionId !== after?.executionId) {
          const executionId = after?.executionId ?? before?.executionId;
          if (executionId) this.notify(this.toolListeners, toolSubscriptionKey(threadId, executionId, index));
          if (before?.executionId && before.executionId !== executionId) {
            this.notify(this.toolListeners, toolSubscriptionKey(threadId, before.executionId, index));
          }
        }
      }
    }
  }
}

export const assistantDraftStore = new AssistantDraftStore();
