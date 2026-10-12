import { spawn } from 'node:child_process';
import { lstat, readFile, readdir, realpath, stat, writeFile, unlink, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolDefinition } from '../core/types.js';
import type { Thread } from '../core/types.js';

export interface ToolContext {
  workspacePath: string;
  executionId: string;
  signal: AbortSignal;
  thread?: Thread;
}

export interface ToolImplementation {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}

export type ToolSource = 'executor' | 'runtime';

export interface RegisteredTool extends ToolImplementation {
  owner: string;
  source: ToolSource;
}

const schemas = {
  string: { type: 'string' },
};

export class ToolCatalog {
  private readonly items = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.items.has(tool.definition.name)) {
      throw new Error(`Tool ${tool.definition.name} is already registered`);
    }
    this.items.set(tool.definition.name, tool);
  }

  replace(tool: RegisteredTool): void {
    this.items.set(tool.definition.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.items.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.items.values()].map(({ definition }) => definition);
  }

  listBySource(source: ToolSource): RegisteredTool[] {
    return [...this.items.values()].filter((tool) => tool.source === source);
  }

  removeOwner(owner: string): void {
    for (const [name, tool] of this.items) {
      if (tool.owner === owner) this.items.delete(name);
    }
  }
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string`);
  return value;
}

async function safePath(workspacePath: string, requestedPath: string, allowMissing = false): Promise<string> {
  if (isAbsolute(requestedPath) || requestedPath.split(/[\\/]/).includes('..')) {
    throw new Error('Tool paths must stay inside the selected workspace');
  }
  const root = await realpath(workspacePath);
  const candidate = resolve(root, requestedPath || '.');
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Tool path is outside the selected workspace');
  }
  const components = rel ? rel.split(sep) : [];
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = resolve(current, components[index]!);
    try {
      const resolved = await realpath(current);
      const resolvedRel = relative(root, resolved);
      if (resolvedRel === '..' || resolvedRel.startsWith(`..${sep}`) || isAbsolute(resolvedRel)) {
        throw new Error('Tool path resolves outside the selected workspace');
      }
      current = resolved;
    } catch (error) {
      if (!allowMissing || !isNodeError(error, 'ENOENT')) throw error;
      // A missing suffix is safe only after resolving every existing path component.
      // In particular, do not follow an existing symlink to a missing external target.
      try {
        await lstat(current);
        throw error;
      } catch (statError) {
        if (!isNodeError(statError, 'ENOENT')) throw statError;
      }
      return resolve(current, ...components.slice(index + 1));
    }
  }
  return current;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) return reject(new DOMException('Execution interrupted', 'AbortError'));
    const child = spawn(executable, args, {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let terminationReason: 'interrupted' | 'timeout' | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const limit = 40_000;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-limit);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-limit);
    });
    const stop = (): void => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        /* The process may have exited between the request and signal. */
      }
    };
    const forceStopSoon = (): void => {
      if (killTimer) return;
      killTimer = setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* The process may have exited before escalation. */
        }
      }, 1_500);
    };
    const onAbort = (): void => {
      if (terminationReason) return;
      terminationReason = 'interrupted';
      stop();
      forceStopSoon();
    };
    const timer = setTimeout(() => {
      if (terminationReason) return;
      terminationReason = 'timeout';
      stop();
      forceStopSoon();
    }, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.once('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      if (terminationReason === 'interrupted') return reject(new DOMException('Execution interrupted', 'AbortError'));
      if (terminationReason === 'timeout') return reject(new Error(`Command timed out after ${timeoutMs}ms`));
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function shellCommand(command: string): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    return { executable: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { executable: '/bin/sh', args: ['-lc', command] };
}

async function searchFiles(
  pattern: string,
  rootPath: string,
  signal: AbortSignal,
): Promise<{ matches: string[]; truncated: boolean }> {
  const expression = new RegExp(pattern);
  const results: string[] = [];
  const ignore = new Set(['.git', 'node_modules', 'dist', 'target', '.next', '.pico']);
  let truncated = false;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (signal.aborted) throw new DOMException('Execution interrupted', 'AbortError');
    if (depth > 18 || results.length >= 200) {
      truncated = true;
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(full, depth + 1);
      } else if (entry.isFile()) {
        const info = await stat(full);
        if (info.size > 1_000_000) continue;
        const content = await readFile(full, 'utf8').catch(() => null);
        if (content === null || content.includes('\0')) continue;
        const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => {
          if (results.length < 200 && expression.test(line)) {
            results.push(`${relative(rootPath, full)}:${index + 1}:${line}`);
            expression.lastIndex = 0;
          }
        });
        if (results.length >= 200) {
          truncated = true;
          return;
        }
      }
    }
  };
  await visit(rootPath, 0);
  return { matches: results, truncated };
}

function applyHunks(source: string, hunks: string[]): string {
  const hadFinalNewline = source.endsWith('\n');
  const lines = source === '' ? [] : source.replace(/\n$/, '').split('\n');
  let cursor = 0;
  const output: string[] = [];
  for (const hunk of hunks) {
    const header = hunk.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!header) throw new Error(`Invalid patch hunk: ${hunk.split('\n')[0]}`);
    const oldStart = Number(header[1]);
    const target = oldStart === 0 ? 0 : oldStart - 1;
    if (target < cursor || target > lines.length) throw new Error('Patch hunk is out of order or outside the file');
    output.push(...lines.slice(cursor, target));
    cursor = target;
    for (const item of hunk.split('\n').slice(1)) {
      if (item.startsWith('\\ No newline at end of file')) continue;
      const marker = item[0];
      const text = item.slice(1);
      if (marker === ' ') {
        if (lines[cursor] !== text) throw new Error(`Patch context did not match: ${text}`);
        output.push(lines[cursor]!);
        cursor += 1;
      } else if (marker === '-') {
        if (lines[cursor] !== text) throw new Error(`Patch removal did not match: ${text}`);
        cursor += 1;
      } else if (marker === '+') {
        output.push(text);
      } else if (item !== '') {
        throw new Error(`Unsupported patch line: ${item}`);
      }
    }
  }
  output.push(...lines.slice(cursor));
  const result = output.join('\n');
  return result === '' ? '' : `${result}${hadFinalNewline ? '\n' : ''}`;
}

async function applyPatch(patchText: string, workspacePath: string): Promise<string[]> {
  const patch = patchText.replace(/^\*\*\* Begin Patch\n/, '').replace(/\n\*\*\* End Patch\s*$/, '\n');
  const blocks = patch.split(/(?=^diff --git |^\*\*\* (?:Update|Add|Delete) File: )/m).filter(Boolean);
  if (!blocks.length) throw new Error('Patch is empty or unsupported');
  const changed: string[] = [];
  for (const block of blocks) {
    const newFile = block.match(/^\*\*\* Add File: (.+)$/m)?.[1];
    const deletedFile = block.match(/^\*\*\* Delete File: (.+)$/m)?.[1];
    const updatedFile = block.match(/^\*\*\* Update File: (.+)$/m)?.[1];
    const oldHeader = block.match(/^--- (?:a\/)?(.+)$/m)?.[1];
    const newHeader = block.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1];
    const filePath =
      newFile ??
      deletedFile ??
      updatedFile ??
      (newHeader && newHeader !== '/dev/null' ? newHeader : oldHeader && oldHeader !== '/dev/null' ? oldHeader : null);
    if (!filePath || filePath === '/dev/null') throw new Error('Patch needs a relative file path');
    const target = await safePath(workspacePath, filePath, true);
    if (deletedFile || newHeader === '/dev/null') {
      await unlink(target);
      changed.push(filePath);
      continue;
    }
    const hunks = block.split(/(?=^@@ )/m).filter((part) => part.startsWith('@@ '));
    const before = newFile || oldHeader === '/dev/null' ? '' : await readFile(target, 'utf8');
    const additions = block
      .split('\n')
      .filter((line) => line.startsWith('+'))
      .map((line) => line.slice(1));
    const after =
      newFile && hunks.length === 0
        ? `${additions.join('\n')}${additions.length > 0 && block.endsWith('\n') ? '\n' : ''}`
        : applyHunks(before, hunks);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, after, 'utf8');
    changed.push(filePath);
  }
  return changed;
}

export function builtinExecutorTools(): ToolImplementation[] {
  return [
    {
      definition: {
        name: 'read_file',
        description: 'Read a UTF-8 text file inside the selected workspace. Paths are relative to the workspace.',
        parameters: {
          type: 'object',
          properties: { path: schemas.string },
          required: ['path'],
          additionalProperties: false,
        },
      },
      async execute(args, context) {
        const target = await safePath(context.workspacePath, requiredString(args, 'path'));
        const contents = await readFile(target, 'utf8');
        return {
          path: relative(context.workspacePath, target),
          contents: contents.slice(0, 60_000),
          truncated: contents.length > 60_000,
        };
      },
    },
    {
      definition: {
        name: 'search_files',
        description:
          'Search text files under the workspace using a regular expression. Skips dependency and build folders.',
        parameters: {
          type: 'object',
          properties: { pattern: schemas.string },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
      async execute(args, context) {
        return searchFiles(requiredString(args, 'pattern'), context.workspacePath, context.signal);
      },
    },
    {
      definition: {
        name: 'apply_patch',
        description:
          'Apply a unified diff patch to files in the selected workspace. Paths must be relative and may not escape the workspace.',
        parameters: {
          type: 'object',
          properties: { patch: schemas.string },
          required: ['patch'],
          additionalProperties: false,
        },
      },
      async execute(args, context) {
        return { changed: await applyPatch(requiredString(args, 'patch'), context.workspacePath) };
      },
    },
    {
      definition: {
        name: 'shell',
        description: 'Run a shell command in the selected executor workspace and return its output and exit code.',
        parameters: {
          type: 'object',
          properties: { command: schemas.string, timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 } },
          required: ['command'],
          additionalProperties: false,
        },
      },
      async execute(args, context) {
        const timeoutMs =
          typeof args.timeout_ms === 'number' ? Math.min(Math.max(args.timeout_ms, 1000), 600_000) : 120_000;
        const { executable, args: shellArgs } = shellCommand(requiredString(args, 'command'));
        const { exitCode, stdout, stderr } = await runProcess(
          executable,
          shellArgs,
          context.workspacePath,
          context.signal,
          timeoutMs,
        );
        return { exitCode, stdout, stderr };
      },
    },
  ];
}

export function createToolCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  for (const tool of builtinExecutorTools()) catalog.register({ ...tool, owner: 'pico.core', source: 'executor' });
  return catalog;
}
