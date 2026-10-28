export type ModelDraftReadResult =
  | {
      status: 'available';
      text: string;
      fromOffset: number;
      nextOffset: number;
      latestOffset: number;
    }
  | {
      status: 'gap';
      requestedOffset: number;
      availableFromOffset: number | null;
      availableThroughOffset: number | null;
    }
  | { status: 'unavailable' };

interface DraftStream {
  threadId: string;
  executionId: string;
  startOffset: number;
  endOffset: number;
  text: string;
}

export interface ModelDraftBufferLimits {
  maxStreamCodeUnits?: number;
  maxTotalCodeUnits?: number;
  maxStreams?: number;
}

/** Bounded, process-local suffixes for active model drafts. Offsets use JS UTF-16 units. */
export class ModelDraftBuffer {
  private readonly streams = new Map<string, DraftStream>();
  private totalCodeUnits = 0;
  private readonly maxStreamCodeUnits: number;
  private readonly maxTotalCodeUnits: number;
  private readonly maxStreams: number;

  constructor(limits: ModelDraftBufferLimits = {}) {
    this.maxStreamCodeUnits = Math.max(1, limits.maxStreamCodeUnits ?? 128 * 1024);
    this.maxTotalCodeUnits = Math.max(this.maxStreamCodeUnits, limits.maxTotalCodeUnits ?? 2 * 1024 * 1024);
    this.maxStreams = Math.max(1, Math.floor(limits.maxStreams ?? 128));
  }

  begin(threadId: string, executionId: string): void {
    const key = this.key(threadId, executionId);
    this.remove(key);
    this.streams.set(key, { threadId, executionId, startOffset: 0, endOffset: 0, text: '' });
    while (this.streams.size > this.maxStreams) {
      const oldest = this.streams.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  append(threadId: string, executionId: string, offset: number, delta: string): void {
    const key = this.key(threadId, executionId);
    const stream = this.streams.get(key);
    if (!stream || !Number.isSafeInteger(offset) || offset !== stream.endOffset || delta.length === 0) return;

    const previousLength = stream.text.length;
    stream.endOffset += delta.length;
    if (delta.length >= this.maxStreamCodeUnits) {
      stream.text = delta.slice(delta.length - this.maxStreamCodeUnits);
      stream.startOffset = stream.endOffset - stream.text.length;
      this.totalCodeUnits += stream.text.length - previousLength;
    } else {
      stream.text += delta;
      this.totalCodeUnits += delta.length;
      if (stream.text.length > this.maxStreamCodeUnits) {
        const trim = stream.text.length - this.maxStreamCodeUnits;
        stream.text = stream.text.slice(trim);
        stream.startOffset += trim;
        this.totalCodeUnits -= trim;
      }
    }
    this.touch(key, stream);

    while (this.totalCodeUnits > this.maxTotalCodeUnits) {
      const oldest = this.streams.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  read(threadId: string, executionId: string, offset: number): ModelDraftReadResult {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Model draft offset must be a non-negative safe integer.');
    const key = this.key(threadId, executionId);
    const stream = this.streams.get(key);
    if (!stream) {
      return {
        status: 'gap',
        requestedOffset: offset,
        availableFromOffset: null,
        availableThroughOffset: null,
      };
    }
    if (offset < stream.startOffset || offset > stream.endOffset) {
      this.touch(key, stream);
      return {
        status: 'gap',
        requestedOffset: offset,
        availableFromOffset: stream.startOffset,
        availableThroughOffset: stream.endOffset,
      };
    }
    this.touch(key, stream);
    const fromOffset = offset;
    return {
      status: 'available',
      text: stream.text.slice(offset - stream.startOffset),
      fromOffset,
      nextOffset: stream.endOffset,
      latestOffset: stream.endOffset,
    };
  }

  end(threadId: string, executionId: string): void {
    this.remove(this.key(threadId, executionId));
  }

  endThread(threadId: string): void {
    for (const [key, stream] of this.streams) if (stream.threadId === threadId) this.remove(key);
  }

  clear(): void {
    this.streams.clear();
    this.totalCodeUnits = 0;
  }

  private key(threadId: string, executionId: string): string {
    return `${threadId}\0${executionId}`;
  }

  private touch(key: string, stream: DraftStream): void {
    this.streams.delete(key);
    this.streams.set(key, stream);
  }

  private remove(key: string): void {
    const stream = this.streams.get(key);
    if (!stream) return;
    this.totalCodeUnits -= stream.text.length;
    this.streams.delete(key);
  }
}
