import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Execution, ExecutorBinding } from '../core/types.js';
import { PicoStore } from '../core/store.js';
import { ToolCatalog } from './tools.js';
import type { ExecutionListener, ExecutorAdapter } from './executor.js';

const RUNNER = String.raw`
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const [mode, key, toolName] = process.argv.slice(1);
const folder = '/tmp/pico-executions';
const resultFile = path.join(folder, key + '.json');
const pidFile = path.join(folder, key + '.pid');
const send = value => process.stdout.write(JSON.stringify(value));
function alive() {
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0); return true; }
  catch { return false; }
}
async function readInput() {
  const chunks = [];
  for await (const part of process.stdin) chunks.push(part);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
async function search(root, pattern) {
  const regex = new RegExp(pattern);
  const matches = [];
  const ignored = new Set(['.git', 'node_modules', 'dist', 'target', '.next', '.pico']);
  async function walk(dir, depth) {
    if (depth > 18 || matches.length >= 200) return;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile()) {
        const info = await fsp.stat(file);
        if (info.size > 1000000) continue;
        const text = await fsp.readFile(file, 'utf8').catch(() => null);
        if (text === null || text.includes('\0')) continue;
        text.split(/\r?\n/).forEach((line, index) => {
          regex.lastIndex = 0;
          if (matches.length < 200 && regex.test(line)) matches.push(path.relative(root, file) + ':' + (index + 1) + ':' + line);
        });
      }
    }
  }
  await walk(root, 0);
  return { matches, truncated: matches.length >= 200 };
}
function applyHunks(source, hunks) {
  const finalNewline = source.endsWith('\n');
  const lines = source === '' ? [] : source.replace(/\n$/, '').split('\n');
  const output = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const head = hunk.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!head) throw new Error('Invalid patch hunk');
    const target = Number(head[1]) === 0 ? 0 : Number(head[1]) - 1;
    if (target < cursor || target > lines.length) throw new Error('Patch hunk is outside the file');
    output.push(...lines.slice(cursor, target));
    cursor = target;
    for (const item of hunk.split('\n').slice(1)) {
      if (item.startsWith('\\ No newline')) continue;
      const marker = item[0];
      const value = item.slice(1);
      if (marker === ' ') {
        if (lines[cursor] !== value) throw new Error('Patch context did not match: ' + value);
        output.push(lines[cursor++]);
      } else if (marker === '-') {
        if (lines[cursor] !== value) throw new Error('Patch removal did not match: ' + value);
        cursor++;
      } else if (marker === '+') output.push(value);
    }
  }
  output.push(...lines.slice(cursor));
  const result = output.join('\n');
  return result === '' ? '' : result + (finalNewline ? '\n' : '');
}
function pathInside(value) {
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error('Tool paths must stay inside the selected workspace');
  const target = path.resolve('/workspace', value || '.');
  const relative = path.relative('/workspace', target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Tool path is outside the workspace');
  return target;
}
async function patch(patchText) {
  const text = patchText.replace(/^\*\*\* Begin Patch\n/, '').replace(/\n\*\*\* End Patch\s*$/, '');
  const blocks = text.split(/(?=^diff --git |^\*\*\* (?:Update|Add|Delete) File: )/m).filter(Boolean);
  const changed = [];
  for (const block of blocks) {
    const added = block.match(/^\*\*\* Add File: (.+)$/m)?.[1];
    const deleted = block.match(/^\*\*\* Delete File: (.+)$/m)?.[1];
    const updated = block.match(/^\*\*\* Update File: (.+)$/m)?.[1];
    const oldName = block.match(/^--- (?:a\/)?(.+)$/m)?.[1];
    const newName = block.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1];
    const filename = added || deleted || updated || (newName && newName !== '/dev/null' ? newName : oldName);
    if (!filename || filename === '/dev/null') throw new Error('Patch needs a relative path');
    const target = pathInside(filename);
    if (deleted || newName === '/dev/null') { await fsp.unlink(target); changed.push(filename); continue; }
    const hunks = block.split(/(?=^@@ )/m).filter(part => part.startsWith('@@ '));
    const before = added || oldName === '/dev/null' ? '' : await fsp.readFile(target, 'utf8');
    const after = added && hunks.length === 0
      ? block.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n')
      : applyHunks(before, hunks);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, after, 'utf8');
    changed.push(filename);
  }
  return changed;
}
async function run() {
  await fsp.mkdir(folder, { recursive: true });
  if (mode === 'status') {
    if (fs.existsSync(resultFile)) return send(JSON.parse(await fsp.readFile(resultFile, 'utf8')));
    return send({ status: alive() ? 'running' : 'interrupted' });
  }
  if (mode === 'interrupt') {
    if (alive()) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    }
    return send({ status: alive() ? 'running' : 'interrupted' });
  }
  if (mode !== 'run') throw new Error('Unsupported runner action');
  if (fs.existsSync(resultFile)) return send(JSON.parse(await fsp.readFile(resultFile, 'utf8')));
  if (alive()) return send({ status: 'running' });
  const args = await readInput();
  const toolChild = { pid: null };
  process.on('SIGTERM', () => {
    if (toolChild.pid) { try { process.kill(-toolChild.pid, 'SIGTERM'); } catch {} }
  });
  try {
    let result;
    if (toolName === 'read_file') {
      const file = pathInside(args.path);
      const contents = await fsp.readFile(file, 'utf8');
      result = { path: path.relative('/workspace', file), contents: contents.slice(0, 60000), truncated: contents.length > 60000 };
    } else if (toolName === 'search_files') result = await search('/workspace', args.pattern);
    else if (toolName === 'apply_patch') result = { changed: await patch(args.patch) };
    else if (toolName === 'shell') {
      const command = spawn('/bin/sh', ['-lc', args.command], { cwd: '/workspace', detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      toolChild.pid = command.pid;
      fs.writeFileSync(pidFile, String(command.pid));
      let stdout = ''; let stderr = '';
      command.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-40000); });
      command.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-40000); });
      const timeout = setTimeout(() => { try { process.kill(-command.pid, 'SIGTERM'); } catch {} }, Math.min(Math.max(Number(args.timeout_ms) || 120000, 1000), 600000));
      const exit = await new Promise((resolve, reject) => {
        command.once('error', reject);
        command.once('close', (value, signal) => resolve({ code: value == null ? 1 : value, signal }));
      });
      clearTimeout(timeout);
      if (exit.signal) {
        const interrupted = { status: 'interrupted', error: 'Tool process received an explicit interrupt request.' };
        await fsp.writeFile(resultFile + '.tmp', JSON.stringify(interrupted));
        await fsp.rename(resultFile + '.tmp', resultFile);
        try { await fsp.unlink(pidFile); } catch {}
        return send(interrupted);
      }
      result = { exitCode: exit.code, stdout, stderr };
    } else throw new Error('Unknown executor tool: ' + toolName);
    const completed = { status: 'completed', result };
    await fsp.writeFile(resultFile + '.tmp', JSON.stringify(completed));
    await fsp.rename(resultFile + '.tmp', resultFile);
    try { await fsp.unlink(pidFile); } catch {}
    return send(completed);
  } catch (error) {
    const failed = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    await fsp.writeFile(resultFile + '.tmp', JSON.stringify(failed));
    await fsp.rename(resultFile + '.tmp', resultFile);
    try { await fsp.unlink(pidFile); } catch {}
    return send(failed);
  }
}
run().catch(error => { send({ status: 'failed', error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; });
`;

interface ToolRunnerResponse {
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  result?: unknown;
  error?: string;
}

type PodmanRunner = typeof podman;

function podman(args: string[], input?: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new DOMException('Execution interrupted', 'AbortError'));
    const child = spawn('podman', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-100_000);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
    });
    const stop = (): void => {
      child.kill('SIGTERM');
    };
    const onAbort = (): void => {
      stop();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new DOMException('Execution interrupted', 'AbortError'));
      if (code !== 0) return reject(new Error(stderr.trim() || `podman exited with code ${code ?? 1}`));
      resolvePromise({ stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export class ContainerExecutor implements ExecutorAdapter {
  readonly kind = 'container' as const;
  private readonly inFlight = new Map<string, { promise: Promise<Execution>; controller: AbortController }>();
  private readonly containerIds = new Map<string, string>();

  constructor(
    private readonly store: PicoStore,
    private readonly tools: ToolCatalog,
    private readonly onExecution: ExecutionListener = () => undefined,
    private readonly image = 'docker.io/library/node:22-bookworm-slim',
    private readonly runPodman: PodmanRunner = podman,
  ) {}

  async checkConnection(_binding: ExecutorBinding): Promise<void> {
    await this.runPodman(['info', '--format', '{{.Version.Version}}']);
  }

  async execute(executionId: string, binding: ExecutorBinding, externalSignal?: AbortSignal): Promise<Execution> {
    const current = this.store.getExecution(executionId);
    if (!current) throw new Error(`Execution ${executionId} was not durably created`);
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'interrupted')
      return current;
    const active = this.inFlight.get(executionId);
    if (active) return active.promise;
    if (current.status === 'running') return this.resumeExisting(executionId, binding, externalSignal);
    const tool = current.toolName ? this.tools.get(current.toolName) : undefined;
    if (!tool || tool.source !== 'executor') {
      return this.store.transitionExecution(executionId, 'failed', {
        error: `Container tool “${current.toolName ?? 'unknown'}” is not registered.`,
      });
    }
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort();
    externalSignal?.addEventListener('abort', relayAbort, { once: true });
    const promise = (async () => {
      await this.ensureContainer(binding);
      const running = this.store.transitionExecution(executionId, 'running');
      this.onExecution(running);
      return this.runRemote(executionId, current.toolName!, current.arguments ?? {}, binding, controller.signal);
    })()
      .catch((error: unknown) => {
        const latest = this.store.getExecution(executionId);
        if (!latest || latest.status === 'completed' || latest.status === 'failed' || latest.status === 'interrupted')
          return latest!;
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return this.store.transitionExecution(executionId, 'interrupted', { error: 'Execution was interrupted.' });
        }
        // An unreachable Podman service is not evidence that a running execution stopped.
        if (
          (latest.status === 'pending' || latest.status === 'running') &&
          /connection|refused|permission denied|read-only/i.test(error instanceof Error ? error.message : String(error))
        ) {
          return latest;
        }
        return this.store.transitionExecution(executionId, latest.status === 'pending' ? 'failed' : 'interrupted', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        externalSignal?.removeEventListener('abort', relayAbort);
        this.inFlight.delete(executionId);
      });
    this.inFlight.set(executionId, { promise, controller });
    return promise;
  }

  async status(executionId: string, binding: ExecutorBinding): Promise<Execution | null> {
    const current = this.store.getExecution(executionId);
    if (!current) return null;
    if (
      current.status === 'pending' ||
      current.status === 'completed' ||
      current.status === 'failed' ||
      current.status === 'interrupted'
    )
      return current;
    if (this.inFlight.has(executionId)) return current;
    return this.refreshStatus(executionId, binding);
  }

  private async refreshStatus(executionId: string, binding: ExecutorBinding): Promise<Execution | null> {
    const current = this.store.getExecution(executionId);
    if (!current) return null;
    if (current.status !== 'running') return current;
    const name = this.containerName(binding.id);
    const exists = await this.containerExists(name);
    if (!exists)
      return this.store.transitionExecution(executionId, 'interrupted', {
        error: 'The Container Executor confirmed that its previous container no longer exists.',
        detail: { confirmedMissing: true },
      });
    await this.startContainer(name);
    const response = await this.callRunner(name, 'status', this.executionKey(executionId));
    return this.acceptRunnerResponse(executionId, response);
  }

  async interrupt(executionId: string, binding: ExecutorBinding): Promise<Execution | null> {
    const active = this.inFlight.get(executionId);
    if (active) {
      const response = await this.callRunner(
        this.containerName(binding.id),
        'interrupt',
        this.executionKey(executionId),
      );
      const updated = this.acceptRunnerResponse(executionId, response);
      if (updated.status !== 'running') active.controller.abort();
      return updated;
    }
    const current = this.store.getExecution(executionId);
    if (!current || current.status !== 'running') return current;
    const name = this.containerName(binding.id);
    if (!(await this.containerExists(name))) {
      return this.store.transitionExecution(executionId, 'interrupted', {
        error: 'The Container Executor confirmed that its previous container no longer exists.',
        detail: { confirmedMissing: true },
      });
    }
    const response = await this.callRunner(name, 'interrupt', this.executionKey(executionId));
    return this.acceptRunnerResponse(executionId, response);
  }

  private async resumeExisting(
    executionId: string,
    binding: ExecutorBinding,
    signal?: AbortSignal,
  ): Promise<Execution> {
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort();
    signal?.addEventListener('abort', relayAbort, { once: true });
    const promise = (async () => {
      const existing = await this.status(executionId, binding);
      if (!existing || existing.status !== 'running') return existing!;
      return this.poll(executionId, binding, controller.signal);
    })()
      .catch((error: unknown) => this.store.getExecution(executionId) ?? Promise.reject(error))
      .finally(() => {
        signal?.removeEventListener('abort', relayAbort);
        this.inFlight.delete(executionId);
      });
    this.inFlight.set(executionId, { promise, controller });
    return promise;
  }

  private async runRemote(
    executionId: string,
    toolName: string,
    args: Record<string, unknown>,
    binding: ExecutorBinding,
    signal: AbortSignal,
  ): Promise<Execution> {
    const name = this.containerName(binding.id);
    const key = this.executionKey(executionId);
    const response = await this.callRunner(name, 'run', key, toolName, args, signal);
    if (response.status === 'running') return this.poll(executionId, binding, signal);
    return this.acceptRunnerResponse(executionId, response);
  }

  private async poll(executionId: string, binding: ExecutorBinding, signal: AbortSignal): Promise<Execution> {
    while (!signal.aborted) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
      const status = await this.refreshStatus(executionId, binding);
      if (!status || status.status !== 'running') return status!;
    }
    return this.store.getExecution(executionId)!;
  }

  private acceptRunnerResponse(executionId: string, response: ToolRunnerResponse): Execution {
    const current = this.store.getExecution(executionId);
    if (!current) throw new Error(`Execution ${executionId} not found`);
    if (response.status === 'running') return current;
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'interrupted')
      return current;
    const updated = this.store.transitionExecution(executionId, response.status, {
      ...(Object.hasOwn(response, 'result') ? { result: response.result } : {}),
      ...(response.error ? { error: response.error } : {}),
      detail: { source: 'container-runner' },
    });
    this.onExecution(updated);
    return updated;
  }

  private async callRunner(
    name: string,
    mode: 'run' | 'status' | 'interrupt',
    key: string,
    toolName?: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolRunnerResponse> {
    const command = ['exec', '-i', name, 'node', '-e', RUNNER, mode, key, ...(toolName ? [toolName] : [])];
    const { stdout } = await this.runPodman(command, args ? JSON.stringify(args) : undefined, signal);
    try {
      return JSON.parse(stdout) as ToolRunnerResponse;
    } catch {
      throw new Error(`Container Executor returned invalid status: ${stdout.slice(0, 300)}`);
    }
  }

  private async ensureContainer(binding: ExecutorBinding): Promise<void> {
    await this.checkConnection(binding);
    const name = this.containerName(binding.id);
    if (await this.containerExists(name)) {
      await this.startContainer(name);
      return;
    }
    const volume = `${binding.workspacePath}:/workspace:rw`;
    await this.runPodman([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      'io.pico.executor=true',
      '--volume',
      volume,
      '--workdir',
      '/workspace',
      this.image,
      'sleep',
      'infinity',
    ]);
    this.containerIds.set(binding.id, name);
  }

  private async containerExists(name: string): Promise<boolean> {
    try {
      await this.runPodman(['inspect', '--type', 'container', name]);
      return true;
    } catch (error) {
      if (
        /no such container|no such object|not found|does not exist/i.test(
          error instanceof Error ? error.message : String(error),
        )
      ) {
        return false;
      }
      throw error;
    }
  }

  private async startContainer(name: string): Promise<void> {
    await this.runPodman(['start', name]).catch((error: unknown) => {
      if (error instanceof Error && /already running/i.test(error.message)) return;
      throw error;
    });
  }

  private containerName(executorId: string): string {
    const known = this.containerIds.get(executorId);
    if (known) return known;
    const name = `pico-${executorId.replaceAll('-', '').slice(0, 24)}`;
    this.containerIds.set(executorId, name);
    return name;
  }

  private executionKey(executionId: string): string {
    return createHash('sha256').update(executionId).digest('hex');
  }
}
