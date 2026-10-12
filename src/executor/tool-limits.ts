export const READ_FILE_LIMITS = {
  maxCharacters: 60_000,
  maxBytes: 240_004,
} as const;

export const SEARCH_FILE_LIMITS = {
  maxDepth: 18,
  maxFileBytes: 1_000_000,
  maxMatches: 200,
  maxLineCharacters: 2_000,
  maxOutputCharacters: 30_000,
} as const;
