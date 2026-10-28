export interface ThreadToolRequestToken {
  threadId: string;
  generation: number;
  selectionGeneration: number;
}

/** Tracks ownership so responses from an old selection cannot update the current tool menu. */
export class ThreadToolRequestGuard {
  private readonly generations = new Map<string, number>();
  private selectionGeneration = 0;

  invalidateAll(): void {
    this.selectionGeneration += 1;
  }

  begin(threadId: string): ThreadToolRequestToken {
    const generation = (this.generations.get(threadId) ?? 0) + 1;
    this.generations.set(threadId, generation);
    return { threadId, generation, selectionGeneration: this.selectionGeneration };
  }

  isCurrent(token: ThreadToolRequestToken, activeThreadId: string | null): boolean {
    return (
      token.threadId === activeThreadId &&
      token.generation === this.generations.get(token.threadId) &&
      token.selectionGeneration === this.selectionGeneration
    );
  }
}
