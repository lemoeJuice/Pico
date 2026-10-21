import type { ToolDefinition } from '../core/types.js';

const stringSchema = { type: 'string' } as const;

/** Static Executor schemas are safe for Runtime discovery and never load OS tool implementations. */
export const BUILTIN_EXECUTOR_TOOL_DEFINITIONS: Readonly<Record<string, ToolDefinition>> = {
  read_file: {
    name: 'read_file',
    description:
      'Read a UTF-8 text file inside the selected workspace. Paths are relative to the workspace; output is capped at 60,000 characters and returns truncated when more remains.',
    parameters: {
      type: 'object',
      properties: { path: stringSchema },
      required: ['path'],
      additionalProperties: false,
    },
  },
  read_image: {
    name: 'read_image',
    description:
      'Read a PNG, JPEG, or WebP image file inside the selected workspace for visual inspection. Paths are relative to the workspace; files are limited to 4 MiB.',
    parameters: {
      type: 'object',
      properties: { path: stringSchema },
      required: ['path'],
      additionalProperties: false,
    },
  },
  search_files: {
    name: 'search_files',
    description:
      'Search text files under the workspace using a regular expression. Skips dependency and build folders; output is capped at 200 matches and 30,000 characters, and truncated indicates incomplete coverage.',
    parameters: {
      type: 'object',
      properties: { pattern: stringSchema },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  apply_patch: {
    name: 'apply_patch',
    description:
      'Apply a unified diff patch to files in the selected workspace. Paths must be relative and may not escape the workspace.',
    parameters: {
      type: 'object',
      properties: { patch: stringSchema },
      required: ['patch'],
      additionalProperties: false,
    },
  },
  shell: {
    name: 'shell',
    description: 'Run a shell command in the selected executor workspace and return its output and exit code.',
    parameters: {
      type: 'object',
      properties: { command: stringSchema, timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 } },
      required: ['command'],
      additionalProperties: false,
    },
  },
};

export function builtinExecutorToolDefinitions(): ToolDefinition[] {
  return Object.values(BUILTIN_EXECUTOR_TOOL_DEFINITIONS).map((definition) => structuredClone(definition));
}
