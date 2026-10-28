import {
  MAX_IMAGE_BYTES,
  MAX_MULTIMODAL_TOOL_RESULT_BYTES,
  isMultimodalToolResult,
  type ImageInput,
} from '../contracts/multimodal.js';
import type { PicoPlugin } from './host.js';

function resultKey(batchId: unknown, callId: unknown): string | null {
  return typeof batchId === 'string' && typeof callId === 'string' ? `${batchId}:${callId}` : null;
}

const MAX_PROMPT_IMAGES = 8;

function decodedBytes(image: ImageInput): number {
  return Math.floor((image.data.length * 3) / 4) - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0);
}

export const visionPlugin: PicoPlugin = {
  id: 'pico.vision',
  name: 'Vision input',
  version: '0.1.0',
  // Run after Rolling Context and enrich only its final, retained tool results.
  pipelinePriority: { projection: 90 },
  activate({ pipelines }) {
    pipelines.use('projection', async (input, next) => {
      const projected = await next(input);
      const results = new Map<string, ImageInput[]>();
      for (const record of input.records) {
        if (record.kind !== 'tool_result') continue;
        const payload = record.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
        if (payload.status !== 'completed' || !isMultimodalToolResult(payload.result)) continue;
        const key = resultKey(payload.batchId, payload.toolCallId);
        if (key) results.set(key, payload.result.images);
      }
      const toolTurns = projected.turns.flatMap((turn, turnIndex) =>
        turn.kind === 'tool_result'
          ? [{ turnIndex, turn, images: results.get(resultKey(turn.batchId, turn.callId) ?? '') ?? [] }]
          : [],
      );
      const retained = new Set<string>();
      let retainedCount = 0;
      let retainedBytes = 0;
      for (const item of [...toolTurns].reverse()) {
        for (let imageIndex = item.images.length - 1; imageIndex >= 0; imageIndex -= 1) {
          const image = item.images[imageIndex]!;
          const bytes = decodedBytes(image);
          if (
            bytes > MAX_IMAGE_BYTES ||
            retainedCount >= MAX_PROMPT_IMAGES ||
            retainedBytes + bytes > MAX_MULTIMODAL_TOOL_RESULT_BYTES
          ) continue;
          retained.add(`${item.turnIndex}:${imageIndex}`);
          retainedCount += 1;
          retainedBytes += bytes;
        }
      }
      return {
        ...projected,
        turns: projected.turns.map((turn, turnIndex) => {
          if (turn.kind !== 'tool_result') return turn;
          const allImages = results.get(resultKey(turn.batchId, turn.callId) ?? '') ?? [];
          if (!allImages.length) return turn;
          const images = allImages.filter((_image, imageIndex) => retained.has(`${turnIndex}:${imageIndex}`));
          if (images.length === allImages.length) return { ...turn, images };
          const { images: _priorImages, ...textTurn } = turn;
          return {
            ...textTurn,
            ...(images.length ? { images } : {}),
            content: `${turn.content}\n图片因本轮输入预算未发送，请缩小/减少图片。`,
          };
        }),
      };
    });
  },
};
