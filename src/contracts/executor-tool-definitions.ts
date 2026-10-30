import type { ToolDefinition } from '../core/types.js';

const stringSchema = { type: 'string' } as const;

/** Static Executor schemas are safe for Runtime discovery and never load OS tool implementations. */
export const BUILTIN_EXECUTOR_TOOL_DEFINITIONS: Readonly<Record<string, ToolDefinition>> = {
  read_file: {
    name: 'read_file',
    description:
      'Read a UTF-8 text file. Relative paths use the execution working directory; path access depends on the Executor. Output is capped at 60,000 characters and returns truncated when more remains.',
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
      'Read a PNG, JPEG, or WebP image for visual inspection. Relative paths use the execution working directory; path access depends on the Executor. Files are limited to 4 MiB.',
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
      'Search text files under the requested path or execution working directory using a regular expression. Path access depends on the Executor. Skips dependency and build folders; output is capped at 200 matches and 30,000 characters, and truncated indicates incomplete coverage.',
    parameters: {
      type: 'object',
      properties: { pattern: stringSchema, path: stringSchema },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  apply_patch: {
    name: 'apply_patch',
    description:
      'Apply a unified diff patch to files. Relative paths use the execution working directory; path access depends on the Executor.',
    parameters: {
      type: 'object',
      properties: { patch: stringSchema },
      required: ['patch'],
      additionalProperties: false,
    },
  },
  shell: {
    name: 'shell',
    description: 'Run a shell command in the Executor working directory and return its output and exit code.',
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
