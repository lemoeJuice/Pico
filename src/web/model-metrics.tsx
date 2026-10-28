import { useEffect, useState } from 'react';
import type { ModelInputAttempt } from '../contracts/runtime.js';
import { assistantDraftStore } from './assistant-drafts-store.js';

/** The provider's request-wide metric remains available to other callers. */
export function latestOutputTokensPerSecond(attempts: ModelInputAttempt[]): number | null {
  const value = attempts.flatMap((attempt) => attempt.providerRequests ?? []).at(-1)?.outputTokensPerSecond;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// A rough text-only approximation, not a tokenizer or provider usage count.
export function estimateTextTokens(text: string): number {
  let wide = 0;
  let other = 0;
  for (const char of text) {
    if (char.codePointAt(0)! > 127) wide++;
    else other++;
  }
  return wide + other / 4;
}

export class TextSpeedWindow {
  private samples: { time: number; tokens: number }[] = [];
  add(time: number, text: string): number | null {
    if (!text) return null;
    const last = this.samples.at(-1);
    if (last && (time - last.time > 3000 || time < last.time)) this.samples = [];
    this.samples.push({ time, tokens: estimateTextTokens(text) });
    while (this.samples.length > 1 && this.samples[0]!.time < time - 3000) this.samples.shift();
    const first = this.samples[0]!;
    const elapsed = time - first.time;
    if (elapsed < 500) return null;
    return (this.samples.slice(1).reduce((sum, sample) => sum + sample.tokens, 0) * 1000) / elapsed;
  }
}

const storageKey = (threadId: string) => `pico.visible-text-tps.${threadId}`;
function readSpeed(threadId: string): number | null {
  try {
    const raw = localStorage.getItem(storageKey(threadId));
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}
function saveSpeed(threadId: string, value: number): void {
  try {
    localStorage.setItem(storageKey(threadId), String(value));
  } catch {
    /* Storage is optional. */
  }
}

export function ComposerTps({
  threadId,
}: {
  threadId: string;
  executionId: string | null;
  status: string | null;
  request<T>(path: string): Promise<T>;
}) {
  const [value, setValue] = useState<number | null>(() => readSpeed(threadId));
  useEffect(() => {
    setValue(readSpeed(threadId));
    let currentExecution: string | null = null;
    let previousText = '';
    let window = new TextSpeedWindow();
    let pending: number | null = null;
    const flush = () => {
      if (pending === null) return;
      const next = pending;
      pending = null;
      saveSpeed(threadId, next);
      setValue(next);
    };
    const onContent = () => {
      const content = assistantDraftStore.getContent(threadId);
      if (!content) {
        flush();
        currentExecution = null;
        previousText = '';
        window = new TextSpeedWindow();
        return;
      }
      if (content.executionId !== currentExecution || !content.text.startsWith(previousText)) {
        flush();
        currentExecution = content.executionId;
        previousText = '';
        window = new TextSpeedWindow();
      }
      const delta = content.text.slice(previousText.length);
      previousText = content.text;
      if (delta) {
        const next = window.add(performance.now(), delta);
        if (next !== null) pending = next;
      }
    };
    // Existing draft is a baseline, not a newly received delta.
    const existing = assistantDraftStore.getContent(threadId);
    if (existing) {
      currentExecution = existing.executionId;
      previousText = existing.text;
    }
    const unsubscribe = assistantDraftStore.subscribeContent(threadId, onContent);
    const timer = setInterval(flush, 500);
    return () => {
      unsubscribe();
      clearInterval(timer);
      if (pending !== null) saveSpeed(threadId, pending);
    };
  }, [threadId]);
  return (
    <span
      className="composer-tps"
      title="Estimated visible-text tokens per second over approximately the last 3 seconds of text arrival; excludes initial wait, reasoning and tool activity. Network timing and text-to-token estimation affect the result. The last value is retained when text stops."
      aria-label={
        value === null
          ? 'Estimated visible text speed unavailable'
          : `Estimated visible text speed ${Math.round(value)} tokens per second`
      }
    >
      {value === null ? 'TPS —' : `TPS ≈${Math.round(value)}`}
    </span>
  );
}
