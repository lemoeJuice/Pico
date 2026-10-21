import { spawn, spawnSync } from 'node:child_process';
import { lstat, open, readFile, realpath, writeFile, unlink, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ToolDefinition } from '../core/types.js';
import { BUILTIN_EXECUTOR_TOOL_DEFINITIONS } from '../contracts/executor-tool-definitions.js';
import { MAX_IMAGE_BYTES } from '../contracts/multimodal.js';
import { READ_FILE_LIMITS, SEARCH_FILE_LIMITS } from './tool-limits.js';
import { ToolCatalog, type ExecutorToolContext, type ExecutorToolImplementation } from './tool-catalog.js';

const activeShellExitCleanups = new Set<() => void>();
process.once('exit', () => {
  for (const cleanup of activeShellExitCleanups) cleanup();
});


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
      // Reject entries that exist but cannot be realpathed, such as dangling symlinks.
      let exists = false;
      try {
        await lstat(current);
        exists = true;
      } catch (statError) {
        if (!isNodeError(statError, 'ENOENT')) throw statError;
      }
      if (exists) throw new Error('Tool path resolves outside the selected workspace', { cause: error });
      return resolve(current, ...components.slice(index + 1));
    }
  }
  return current;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function imageMimeType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
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
    const killProcessTree = (signalName: NodeJS.Signals): void => {
      if (process.platform === 'win32' && child.pid) {
        // Windows has no POSIX process groups; taskkill /T ends cmd.exe and its descendants.
        try {
          const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            timeout: 2_000,
            windowsHide: true,
          });
          if (!result.error && result.status === 0) return;
        } catch {
          /* Fall back to stopping the shell itself if taskkill is unavailable. */
        }
        try {
          child.kill(signalName);
        } catch {
          /* The shell may have exited between the tree-kill attempt and fallback. */
        }
        return;
      }
      try {
        if (child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch {
        /* The process may have exited between the request and signal. */
      }
    };
    const killOnRuntimeExit = (): void => killProcessTree('SIGKILL');
    activeShellExitCleanups.add(killOnRuntimeExit);
    const limit = 40_000;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-limit);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-limit);
    });
    const stop = (): void => {
      killProcessTree('SIGTERM');
    };
    const forceStopSoon = (): void => {
      if (killTimer) return;
      killTimer = setTimeout(() => {
        killProcessTree('SIGKILL');
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
      activeShellExitCleanups.delete(killOnRuntimeExit);
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      activeShellExitCleanups.delete(killOnRuntimeExit);
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

const searchWorkerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');

async function search() {
  const expression = new RegExp(workerData.pattern);
  const results = [];
  const ignore = new Set(['.git', 'node_modules', 'dist', 'target', '.next', '.pico']);
  const limits = workerData.limits;
  let truncated = false;
  let outputCharacters = 0;
  let stop = false;
  const appendMatch = (fullPath, lineNumber, line) => {
    const prefix = path.relative(workerData.rootPath, fullPath) + ':' + lineNumber + ':';
    const separatorCharacters = results.length > 0 ? 1 : 0;
    const remaining = limits.maxOutputCharacters - outputCharacters - separatorCharacters;
    if (remaining <= prefix.length) {
      truncated = true;
      stop = true;
      return;
    }
    const lineLimit = Math.min(limits.maxLineCharacters, remaining - prefix.length);
    let excerpt = line;
    if (line.length > lineLimit) {
      const marker = '… [line truncated]';
      excerpt = lineLimit > marker.length ? line.slice(0, lineLimit - marker.length) + marker : line.slice(0, lineLimit);
      truncated = true;
    }
    const match = prefix + excerpt;
    results.push(match);
    outputCharacters += separatorCharacters + match.length;
    if (results.length >= limits.maxMatches || outputCharacters >= limits.maxOutputCharacters) {
      truncated = true;
      stop = true;
    }
  };
  const visit = async (directory, depth) => {
    if (stop) return;
    if (depth > limits.maxDepth) {
      truncated = true;
      return;
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (stop) return;
      if (ignore.has(entry.name)) continue;
      const full = path.resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(full, depth + 1);
      } else if (entry.isFile()) {
        const info = await fs.stat(full);
        if (info.size > limits.maxFileBytes) {
          truncated = true;
          continue;
        }
        const content = await fs.readFile(full, 'utf8').catch(() => null);
        if (content === null || content.includes('\0')) continue;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (stop) break;
          const line = lines[index];
          expression.lastIndex = 0;
          if (line !== undefined && expression.test(line)) {
            appendMatch(full, index + 1, line);
          }
        }
        if (stop) return;
      }
    }
  };
  await visit(workerData.rootPath, 0);
  return { matches: results, truncated };
}

search().then(
  result => parentPort.postMessage({ result }),
  error => parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }),
);
`;

const searchTimeoutMs = 120_000;

async function searchFiles(
  pattern: string,
  rootPath: string,
  signal: AbortSignal,
): Promise<{ matches: string[]; truncated: boolean }> {
  if (signal.aborted) throw new DOMException('Execution interrupted', 'AbortError');
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(searchWorkerSource, {
      eval: true,
      workerData: { pattern, rootPath, limits: SEARCH_FILE_LIMITS },
    });
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = (): void => {
      void worker.terminate();
      finish(() => reject(new DOMException('Execution interrupted', 'AbortError')));
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(() => reject(new Error(`Search timed out after ${searchTimeoutMs}ms`)));
    }, searchTimeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    worker.on('message', (message: { result?: { matches: string[]; truncated: boolean }; error?: string }) => {
      if (message.error !== undefined) {
        finish(() => reject(new Error(message.error)));
      } else if (message.result) {
        finish(() => resolvePromise(message.result!));
      }
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (!settled) finish(() => reject(new Error(`Search worker exited with code ${code}`)));
    });
  });
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

export function builtinExecutorTools(): ExecutorToolImplementation[] {
  return [
    {
      definition: BUILTIN_EXECUTOR_TOOL_DEFINITIONS.read_file!,
      async execute(args, context) {
        const target = await safePath(context.workspacePath, requiredString(args, 'path'));
        const handle = await open(target, 'r');
        let size: number;
        let buffer: Buffer;
        let bytesRead = 0;
        try {
          size = (await handle.stat()).size;
          buffer = Buffer.alloc(Math.min(size, READ_FILE_LIMITS.maxBytes));
          while (bytesRead < buffer.length) {
            const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (read.bytesRead === 0) break;
            bytesRead += read.bytesRead;
          }
        } finally {
          await handle.close();
        }
        const decoded = buffer.subarray(0, bytesRead).toString('utf8');
        if (decoded.includes('\0')) throw new Error('File contains binary data; read_file supports UTF-8 text files.');
        const contents = decoded.slice(0, READ_FILE_LIMITS.maxCharacters);
        return {
          path: relative(context.workspacePath, target),
          contents,
          truncated: size > bytesRead || decoded.length > READ_FILE_LIMITS.maxCharacters,
        };
      },
    },
    {
      definition: BUILTIN_EXECUTOR_TOOL_DEFINITIONS.read_image!,
      async execute(args, context) {
        const requestedPath = requiredString(args, 'path');
        const target = await safePath(context.workspacePath, requestedPath);
        const handle = await open(target, 'r');
        let bytes: Buffer;
        try {
          const size = (await handle.stat()).size;
          if (size > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 4 MiB read_image limit.');
          let buffer = Buffer.alloc(Math.min(size + 1, MAX_IMAGE_BYTES + 1));
          let bytesRead = 0;
          while (true) {
            if (bytesRead === buffer.length) {
              if (buffer.length === MAX_IMAGE_BYTES + 1) break;
              const expanded = Buffer.alloc(Math.min(MAX_IMAGE_BYTES + 1, Math.max(buffer.length + 1, buffer.length * 2)));
              buffer.copy(expanded, 0, 0, bytesRead);
              buffer = expanded;
            }
            const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (read.bytesRead === 0) break;
            bytesRead += read.bytesRead;
          }
          if (bytesRead > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 4 MiB read_image limit.');
          bytes = buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
        const mimeType = imageMimeType(bytes);
        if (!mimeType) throw new Error('File is not a supported PNG, JPEG, or WebP image.');
        const name = requestedPath.split(/[\\/]/).filter(Boolean).at(-1) ?? basename(target);
        return {
          kind: 'pico.multimodal-tool-result',
          version: 1,
          text: `Read image ${name} (${mimeType}, ${bytes.length} bytes).`,
          images: [{ type: 'image', mimeType, data: bytes.toString('base64'), name }],
        };
      },
    },
    {
      definition: BUILTIN_EXECUTOR_TOOL_DEFINITIONS.search_files!,
      async execute(args, context) {
        return searchFiles(requiredString(args, 'pattern'), context.workspacePath, context.signal);
      },
    },
    {
      definition: BUILTIN_EXECUTOR_TOOL_DEFINITIONS.apply_patch!,
      async execute(args, context) {
        return { changed: await applyPatch(requiredString(args, 'patch'), context.workspacePath) };
      },
    },
    {
      definition: BUILTIN_EXECUTOR_TOOL_DEFINITIONS.shell!,
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

export const defaultExecutorPlugin = {
  id: 'pico.executor-tools',
  name: 'Default executor tools',
  version: '0.1.0',
  activateExecutor(context: {
    tools: {
      register(
        definition: ToolDefinition,
        execute: (args: Record<string, unknown>, context: ExecutorToolContext) => Promise<unknown> | unknown,
      ): void;
    };
  }): void {
    for (const tool of builtinExecutorTools()) context.tools.register(tool.definition, tool.execute);
  },
};

export function createToolCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  defaultExecutorPlugin.activateExecutor({
    tools: {
      register(definition, execute) {
        catalog.register({
          owner: defaultExecutorPlugin.id,
          source: 'executor',
          definition,
          execute: async (args, context) => await execute(args, context),
        });
      },
    },
  });
  return catalog;
}
