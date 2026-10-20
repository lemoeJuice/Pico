/** The image formats emitted by Executor tools and accepted by Pico model adapters. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

/**
 * Provider-neutral image input. `data` is standard base64 without a data-URL prefix;
 * only the model adapter turns it into the provider's wire representation.
 */
export interface ImageInput {
  type: 'image';
  mimeType: ImageMediaType;
  data: string;
  /** A display hint such as a basename; never a path the Runtime should open. */
  name?: string;
}

/**
 * Standard JSON result emitted by an Executor tool that has read image bytes.
 * Keeping bytes inline lets the existing local, container, and remote result
 * protocols carry images without adding a Runtime filesystem or blob service.
 */
export interface MultimodalToolResult {
  kind: 'pico.multimodal-tool-result';
  version: 1;
  text: string;
  images: ImageInput[];
}

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_MULTIMODAL_TOOL_RESULT_BYTES = 12 * 1024 * 1024;
export const MAX_MULTIMODAL_TOOL_RESULT_TEXT_LENGTH = 64 * 1024;
export const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export function isImageInput(value: unknown): value is ImageInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const image = value as Record<string, unknown>;
  if (!Object.keys(image).every((key) => key === 'type' || key === 'mimeType' || key === 'data' || key === 'name'))
    return false;
  const bytes = byteLength(image.data);
  return (
    image.type === 'image' &&
    (image.mimeType === 'image/png' || image.mimeType === 'image/jpeg' || image.mimeType === 'image/webp') &&
    typeof image.data === 'string' &&
    image.data.length > 0 &&
    image.data.length <= MAX_IMAGE_BASE64_LENGTH &&
    bytes !== null &&
    bytes <= MAX_IMAGE_BYTES &&
    (image.name === undefined || (typeof image.name === 'string' && image.name.length <= 200))
  );
}

export function isMultimodalToolResultEnvelope(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.kind === 'pico.multimodal-tool-result';
}

export function isMultimodalToolResult(value: unknown): value is MultimodalToolResult {
  if (!isMultimodalToolResultEnvelope(value)) return false;
  return (
    Object.keys(value).every((key) => key === 'kind' || key === 'version' || key === 'text' || key === 'images') &&
    value.version === 1 &&
    typeof value.text === 'string' &&
    value.text.length <= MAX_MULTIMODAL_TOOL_RESULT_TEXT_LENGTH &&
    Array.isArray(value.images) &&
    value.images.length > 0 &&
    value.images.length <= 8 &&
    value.images.every(isImageInput) &&
    value.images.reduce(
      (total, image) => total + (isImageInput(image) ? (byteLength(image.data) ?? MAX_IMAGE_BYTES + 1) : MAX_IMAGE_BYTES + 1),
      0,
    ) <=
      MAX_MULTIMODAL_TOOL_RESULT_BYTES
  );
}

function byteLength(data: unknown): number | null {
  if (
    typeof data !== 'string' ||
    data.length > MAX_IMAGE_BASE64_LENGTH ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  )
    return null;
  return Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

/** Human/model-readable representation that never includes encoded image bytes. */
export function multimodalToolResultText(value: unknown): string {
  if (!isMultimodalToolResultEnvelope(value)) return '';
  const rawText = typeof value.text === 'string' ? value.text : '';
  const text = rawText.slice(0, MAX_MULTIMODAL_TOOL_RESULT_TEXT_LENGTH);
  const images = Array.isArray(value.images) ? value.images : [];
  const payloadValid = isMultimodalToolResult(value);
  const imageLabels = images.map((rawImage) => {
    if (!payloadValid || !isImageInput(rawImage)) return '[图像数据无效/超限，未发送]';
    return `[image ${rawImage.mimeType}${rawImage.name ? `: ${rawImage.name}` : ''}]`;
  });
  if (images.length === 0) imageLabels.push('[图像数据无效/超限，未发送]');
  return [text, ...imageLabels].filter(Boolean).join('\n');
}

/** Redacted representation for public views, summaries, and diagnostics. */
export function redactMultimodalToolResult(value: unknown): Record<string, unknown> {
  const envelope = isMultimodalToolResultEnvelope(value) ? value : {};
  const allImages = Array.isArray(envelope.images) ? envelope.images : [];
  const rawImages = allImages.slice(0, 8);
  return {
    kind: envelope.kind ?? 'pico.multimodal-tool-result',
    version: typeof envelope.version === 'number' && Number.isSafeInteger(envelope.version) ? envelope.version : 1,
    text:
      typeof envelope.text === 'string'
        ? envelope.text.slice(0, MAX_MULTIMODAL_TOOL_RESULT_TEXT_LENGTH)
        : '',
    images: rawImages.map((rawImage) => {
      const image = rawImage && typeof rawImage === 'object' && !Array.isArray(rawImage)
        ? rawImage as Record<string, unknown>
        : {};
      const size = byteLength(image.data);
      return {
        type: image.type === 'image' ? 'image' : undefined,
        mimeType: typeof image.mimeType === 'string' && image.mimeType.length <= 100 ? image.mimeType : 'unknown',
        ...(typeof image.name === 'string' && image.name.length <= 200 ? { name: image.name } : {}),
        ...(size === null ? {} : { byteLength: size }),
        ...(!isImageInput(rawImage) ? { invalid: true } : {}),
      };
    }),
    ...(
      envelope.version !== 1 ||
      typeof envelope.text !== 'string' ||
      envelope.text.length > MAX_MULTIMODAL_TOOL_RESULT_TEXT_LENGTH ||
      !Array.isArray(envelope.images) ||
      allImages.length === 0 ||
      allImages.length > 8 ||
      rawImages.some((image) => !isImageInput(image)) ||
      rawImages.reduce((total, image) => {
        const item = image && typeof image === 'object' && !Array.isArray(image) ? image as Record<string, unknown> : {};
        return total + (byteLength(item.data) ?? 0);
      }, 0) > MAX_MULTIMODAL_TOOL_RESULT_BYTES
      ? { invalid: true }
      : {}),
  };
}

/** Strip image data from any malformed or over-budget marker before it is persisted. */
export function sanitizeMultimodalResultValue(value: unknown): unknown {
  if (isMultimodalToolResultEnvelope(value)) {
    return isMultimodalToolResult(value) ? value : redactMultimodalToolResult(value);
  }
  return sanitizeNestedMultimodalMarkers(value);
}

function sanitizeNestedMultimodalMarkers(value: unknown): unknown {
  if (isMultimodalToolResultEnvelope(value)) return { ...redactMultimodalToolResult(value), invalid: true };
  if (Array.isArray(value)) return value.map(sanitizeNestedMultimodalMarkers);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeNestedMultimodalMarkers(child)]));
  }
  return value;
}
