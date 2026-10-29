import {
  appendAssistantDraft,
  appendAssistantPreview,
  clearAssistantDraft,
  type AssistantDraft,
  type AssistantDrafts,
  type ToolCallPreview,
} from './assistant-drafts.js';

export interface AssistantDraftContent {
  executionId: string;
  text: string;
  settled?: boolean;
  committedSeq?: number;
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
const EMPTY_CONTENTS: readonly AssistantDraftContent[] = [];

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

function sameContents(left: readonly AssistantDraftContent[], right: readonly AssistantDraftContent[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return item.executionId === other?.executionId && item.text === other.text &&
      item.settled === other.settled && item.committedSeq === other.committedSeq &&
      item.unconfirmed === other.unconfirmed && item.previewIncomplete === other.previewIncomplete &&
      item.reasoningSummary === other.reasoningSummary;
  });
}

function sameToolSlots(left: readonly AssistantToolPreviewSlot[], right: readonly AssistantToolPreviewSlot[]): boolean {
  return (
    left.length === right.length &&
    left.every((slot, index) => slot.index === right[index]?.index && slot.name === right[index]?.name)
  );
}

export class AssistantDraftStore {
  private drafts: AssistantDrafts = {};
  private readonly handoffs = new Map<string, Map<string, AssistantDraft>>();
  private readonly contentSnapshots = new Map<string, AssistantDraftContent>();
  private readonly contentsSnapshots = new Map<string, readonly AssistantDraftContent[]>();
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

  getContentForExecution(threadId: string, executionId: string): AssistantDraftContent | null {
    return this.contentsSnapshots.get(threadId)?.find((content) => content.executionId === executionId) ?? null;
  }

  getContents(threadId: string): readonly AssistantDraftContent[] {
    return this.contentsSnapshots.get(threadId) ?? EMPTY_CONTENTS;
  }

  getExecutionId(threadId: string): string | null {
    return this.drafts[threadId]?.executionId ?? null;
  }

  getToolSlots(threadId: string, executionId: string): readonly AssistantToolPreviewSlot[] {
    const key = toolListSubscriptionKey(threadId, executionId);
    const cached = this.toolSlots.get(key);
    if (cached) return cached.slots;
    const draft = this.findDraft(threadId, executionId);
    const slots = draft?.tools?.map(({ index, name }) => ({ index, ...(name === undefined ? {} : { name }) })) ?? [];
    if (slots.length > 0) this.toolSlots.set(key, { executionId, slots });
    return slots.length > 0 ? slots : EMPTY_TOOL_SLOTS;
  }

  getToolPreview(threadId: string, executionId: string, index: number): ToolCallPreview | null {
    const current = this.findDraft(threadId, executionId);
    return current?.tools?.find((call) => call.index === index) ?? null;
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
    this.preserveCurrentDraftForHandoff(threadId, executionId);
    this.replaceDrafts(appendAssistantDraft(this.drafts, threadId, executionId, delta), true);
  }

  appendPreview(
    threadId: string,
    executionId: string,
    preview: { type: 'reasoning'; delta: string } | { type: 'tool'; call: ToolCallPreview },
  ): void {
    const current = this.drafts[threadId];
    if (current?.executionId === executionId && current.previewIncomplete) return;
    this.preserveCurrentDraftForHandoff(threadId, executionId);
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
    if (executionId === undefined) {
      this.handoffs.delete(threadId);
    } else {
      const byExecution = this.handoffs.get(threadId);
      byExecution?.delete(executionId);
      if (byExecution?.size === 0) this.handoffs.delete(threadId);
    }
    this.replaceDrafts(clearAssistantDraft(this.drafts, threadId, executionId));
  }

  clearAll(): void {
    this.handoffs.clear();
    this.replaceDrafts({});
  }

  /** A settled preview stays available until its canonical record can take over. */
  markSettled(threadId: string, executionId: string, committedSeq?: number): void {
    const current = this.findDraft(threadId, executionId);
    if (!current || (current.settled && (committedSeq === undefined || current.committedSeq === committedSeq))) return;
    const updated = { ...current, settled: true, ...(committedSeq === undefined ? {} : { committedSeq }) };
    if (this.drafts[threadId]?.executionId === executionId) {
      this.replaceDrafts({ ...this.drafts, [threadId]: updated });
    } else {
      this.handoffs.get(threadId)?.set(executionId, updated);
      this.replaceDrafts(this.drafts);
    }
  }

  clearCommitted(threadId: string): void {
    for (const draft of this.getContents(threadId)) {
      if (draft.committedSeq !== undefined) this.clear(threadId, draft.executionId);
    }
  }

  markDisconnected(): void {
    const next: AssistantDrafts = {};
    for (const [threadId, draft] of Object.entries(this.drafts)) {
      next[threadId] = draft.unconfirmed ? draft : { ...draft, unconfirmed: true };
    }
    this.replaceDrafts(next);
  }

  private findDraft(threadId: string, executionId: string): AssistantDraft | null {
    const active = this.drafts[threadId];
    if (active?.executionId === executionId) return active;
    return this.handoffs.get(threadId)?.get(executionId) ?? null;
  }

  private preserveCurrentDraftForHandoff(threadId: string, nextExecutionId: string): void {
    const current = this.drafts[threadId];
    if (!current || current.executionId === nextExecutionId) return;
    const byExecution = this.handoffs.get(threadId) ?? new Map<string, AssistantDraft>();
    byExecution.set(current.executionId, { ...current, settled: true });
    this.handoffs.set(threadId, byExecution);
  }

  private toContent(draft: AssistantDraft): AssistantDraftContent {
    return {
      executionId: draft.executionId,
      text: draft.text,
      ...(draft.settled ? { settled: true } : {}),
      ...(draft.committedSeq === undefined ? {} : { committedSeq: draft.committedSeq }),
      ...(draft.unconfirmed ? { unconfirmed: true } : {}),
      ...(draft.previewIncomplete ? { previewIncomplete: true } : {}),
      ...(draft.reasoningSummary === undefined ? {} : { reasoningSummary: draft.reasoningSummary }),
    };
  }

  private allDraftsForThread(threadId: string, active = this.drafts[threadId]): AssistantDraft[] {
    const previous = [...(this.handoffs.get(threadId)?.values() ?? [])];
    return [...previous.filter((draft) => draft.executionId !== active?.executionId), ...(active ? [active] : [])];
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
    const previous = this.drafts;
    this.drafts = next;
    const threadIds = new Set([
      ...Object.keys(previous),
      ...Object.keys(next),
      ...this.handoffs.keys(),
      ...this.contentsSnapshots.keys(),
    ]);

    for (const threadId of threadIds) {
      const before = previous[threadId];
      const after = next[threadId];
      let contentChanged = false;
      const beforeContent = this.contentSnapshots.get(threadId) ?? null;
      const afterContent = after ? this.toContent(after) : null;
      if (
        beforeContent?.executionId !== afterContent?.executionId ||
        beforeContent?.text !== afterContent?.text ||
        beforeContent?.settled !== afterContent?.settled ||
        beforeContent?.committedSeq !== afterContent?.committedSeq ||
        beforeContent?.unconfirmed !== afterContent?.unconfirmed ||
        beforeContent?.previewIncomplete !== afterContent?.previewIncomplete ||
        beforeContent?.reasoningSummary !== afterContent?.reasoningSummary
      ) {
        if (afterContent) this.contentSnapshots.set(threadId, afterContent);
        else this.contentSnapshots.delete(threadId);
        contentChanged = true;
      }

      const allBefore = this.contentsSnapshots.get(threadId) ?? EMPTY_CONTENTS;
      const allAfter = this.allDraftsForThread(threadId, after).map((draft) => this.toContent(draft));
      if (!sameContents(allBefore, allAfter)) {
        if (allAfter.length > 0) this.contentsSnapshots.set(threadId, allAfter);
        else this.contentsSnapshots.delete(threadId);
        contentChanged = true;
      }
      if (contentChanged) this.notifyContent(threadId, deferContent);

      if (before?.executionId !== after?.executionId) this.notify(this.executionListeners, threadId);

      const beforeDrafts = this.allDraftsForThread(threadId, before);
      const afterDrafts = this.allDraftsForThread(threadId, after);
      const executionIds = new Set([...beforeDrafts, ...afterDrafts].map((draft) => draft.executionId));
      for (const executionId of executionIds) {
        const oldDraft = beforeDrafts.find((draft) => draft.executionId === executionId);
        const newDraft = afterDrafts.find((draft) => draft.executionId === executionId);
        const oldSlots = oldDraft?.tools?.map(({ index, name }) => ({ index, ...(name === undefined ? {} : { name }) })) ?? [];
        const newSlots = newDraft?.tools?.map(({ index, name }) => ({ index, ...(name === undefined ? {} : { name }) })) ?? [];
        const listKey = toolListSubscriptionKey(threadId, executionId);
        if (!sameToolSlots(oldSlots, newSlots)) {
          if (newSlots.length > 0) {
            const cached = this.toolSlots.get(listKey)?.slots;
            this.toolSlots.set(listKey, { executionId, slots: cached && sameToolSlots(cached, newSlots) ? cached : newSlots });
          } else this.toolSlots.delete(listKey);
          this.notify(this.toolListListeners, listKey);
        }
        const oldTools = oldDraft?.tools ?? [];
        const newTools = newDraft?.tools ?? [];
        const indices = new Set([...oldTools.map((call) => call.index), ...newTools.map((call) => call.index)]);
        for (const index of indices) {
          if (oldTools.find((call) => call.index === index) !== newTools.find((call) => call.index === index)) {
            this.notify(this.toolListeners, toolSubscriptionKey(threadId, executionId, index));
          }
        }
      }
    }
  }
}

export const assistantDraftStore = new AssistantDraftStore();
