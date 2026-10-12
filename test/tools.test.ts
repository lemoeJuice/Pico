import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinExecutorTools } from '../src/executor/tools.js';

const toolMap = new Map(builtinExecutorTools().map((tool) => [tool.definition.name, tool]));

async function processStopped(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
      if (state === 'Z' || state === 'X') return true;
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe('workspace tools', () => {
  it('reads, searches, and patches files within the selected workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-tools-'));
    const workspacePath = join(directory, 'workspace');
    await mkdir(workspacePath);
    await writeFile(join(workspacePath, 'note.txt'), 'keep\nold\n', 'utf8');
    const context = { workspacePath, executionId: 'test', signal: new AbortController().signal };
    try {
      const read = (await toolMap.get('read_file')!.execute({ path: 'note.txt' }, context)) as { contents: string };
      expect(read.contents).toBe('keep\nold\n');

      const search = (await toolMap.get('search_files')!.execute({ pattern: 'old' }, context)) as { matches: string[] };
      expect(search.matches).toEqual(['note.txt:2:old']);

      const patch = [
        '*** Begin Patch',
        '*** Update File: note.txt',
        '@@ -1,2 +1,2 @@',
        ' keep',
        '-old',
        '+new',
        '*** End Patch',
      ].join('\n');
      await toolMap.get('apply_patch')!.execute({ patch }, context);
      expect(await readFile(join(workspacePath, 'note.txt'), 'utf8')).toBe('keep\nnew\n');

      const addPatch = [
        '*** Begin Patch',
        '*** Add File: created.txt',
        '+created with a final newline',
        '*** End Patch',
      ].join('\n');
      await toolMap.get('apply_patch')!.execute({ patch: addPatch }, context);
      expect(await readFile(join(workspacePath, 'created.txt'), 'utf8')).toBe('created with a final newline\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a patch that would create a file through an external symlink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-path-guard-'));
    const workspacePath = join(directory, 'workspace');
    const outside = join(directory, 'outside');
    await mkdir(workspacePath);
    await mkdir(outside);
    await symlink(outside, join(workspacePath, 'escape'));
    const context = { workspacePath, executionId: 'test', signal: new AbortController().signal };
    const patch = ['*** Begin Patch', '*** Add File: escape/new.txt', '+must not escape', '*** End Patch'].join('\n');
    try {
      await expect(toolMap.get('apply_patch')!.execute({ patch }, context)).rejects.toThrow(
        /outside the selected workspace/,
      );
      await expect(readFile(join(outside, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a patch through a dangling symlink to a missing external directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-dangling-path-guard-'));
    const workspacePath = join(directory, 'workspace');
    const outside = join(directory, 'outside');
    const missingOutside = join(outside, 'not-created');
    await mkdir(workspacePath);
    await mkdir(outside);
    await symlink(missingOutside, join(workspacePath, 'dangling'));
    const context = { workspacePath, executionId: 'test', signal: new AbortController().signal };
    const patch = ['*** Begin Patch', '*** Add File: dangling/new.txt', '+must not escape', '*** End Patch'].join('\n');
    try {
      await expect(toolMap.get('apply_patch')!.execute({ patch }, context)).rejects.toThrow(
        /outside the selected workspace/,
      );
      await expect(readFile(join(missingOutside, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a pathological regular expression interruptible without blocking the Runtime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-search-cancel-'));
    const workspacePath = join(directory, 'workspace');
    await mkdir(workspacePath);
    await writeFile(join(workspacePath, 'input.txt'), `${'a'.repeat(28)}!`, 'utf8');
    const controller = new AbortController();
    const context = { workspacePath, executionId: 'test', signal: controller.signal };
    const search = toolMap.get('search_files')!.execute({ pattern: '^(a+)+$' }, context);
    const interrupt = setTimeout(() => controller.abort(), 200);
    try {
      await expect(search).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      clearTimeout(interrupt);
      controller.abort();
      await rm(directory, { recursive: true, force: true });
    }
  }, 5000);

  it.skipIf(process.platform !== 'linux')(
    'stops an active Host shell when its Runtime process exits',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pico-host-exit-'));
      const workspacePath = join(directory, 'workspace');
      const pidFile = join(directory, 'shell.pid');
      await mkdir(workspacePath);
      const toolsModule = new URL('../src/executor/tools.ts', import.meta.url).href;
      const childSource = `
      import { builtinExecutorTools } from ${JSON.stringify(toolsModule)};
      import { readFile } from 'node:fs/promises';
      const [workspacePath, pidFile] = process.argv.slice(1);
      const shell = builtinExecutorTools().find((tool) => tool.definition.name === 'shell');
      if (!shell) process.exit(4);
      void shell.execute(
        { command: \`printf '%s' "$$" > "\${pidFile}"; trap '' TERM; while :; do sleep 0.05; done\`, timeout_ms: 600000 },
        { workspacePath, executionId: 'runtime-exit-test', signal: new AbortController().signal },
      );
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          await readFile(pidFile, 'utf8');
          process.exit(0);
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      process.exit(5);
    `;
      const runtimeProcess = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', childSource, workspacePath, pidFile],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      runtimeProcess.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        runtimeProcess.once('close', (code, signal) => resolve({ code, signal }));
      });
      const timeout = setTimeout(() => runtimeProcess.kill('SIGKILL'), 5000);
      let shellPid: number | null = null;
      let shellStopped = false;
      try {
        const result = await exit;
        expect(result, stderr).toMatchObject({ code: 0 });
        shellPid = Number(await readFile(pidFile, 'utf8'));
        expect(Number.isSafeInteger(shellPid)).toBe(true);
        expect(shellPid).toBeGreaterThan(0);

        shellStopped = await processStopped(shellPid);
        expect(shellStopped).toBe(true);
      } finally {
        clearTimeout(timeout);
        if (shellPid === null) {
          try {
            shellPid = Number(await readFile(pidFile, 'utf8'));
          } catch {
            shellPid = null;
          }
        }
        if (shellPid !== null && Number.isSafeInteger(shellPid) && shellPid > 0 && !shellStopped) {
          try {
            process.kill(-shellPid, 'SIGKILL');
          } catch {
            /* The Host shell group may already be gone. */
          }
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it.skipIf(process.platform !== 'linux')(
    'uses Windows taskkill tree semantics for Host shell shutdown',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pico-windows-tree-'));
      const workspacePath = join(directory, 'workspace');
      const binPath = join(directory, 'bin');
      const rootPidFile = join(directory, 'shell.pid');
      const childPidFile = join(directory, 'child.pid');
      const taskkillLog = join(directory, 'taskkill-args.txt');
      const commandInterpreter = join(binPath, 'cmd.exe');
      const taskkill = join(binPath, 'taskkill.exe');
      await mkdir(workspacePath);
      await mkdir(binPath);
      await writeFile(commandInterpreter, '#!/bin/sh\nexec /bin/sh -c "$4"\n', { mode: 0o755 });
      await writeFile(
        taskkill,
        [
          '#!/bin/sh',
          'printf "%s\\n" "$*" > "$PICO_TASKKILL_LOG"',
          '[ "$1" = "/PID" ] && [ "$3" = "/T" ] && [ "$4" = "/F" ] || exit 2',
          'terminate_tree() { for child in $(ps -o pid= --ppid "$1" 2>/dev/null); do terminate_tree "$child"; done; kill -KILL "$1" 2>/dev/null || true; }',
          'terminate_tree "$2"',
        ].join('\n'),
        { mode: 0o755 },
      );
      await chmod(commandInterpreter, 0o755);
      await chmod(taskkill, 0o755);

      const toolsModule = new URL('../src/executor/tools.ts', import.meta.url).href;
      const childSource = `
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env.ComSpec = ${JSON.stringify(commandInterpreter)};
      import { builtinExecutorTools } from ${JSON.stringify(toolsModule)};
      import { readFile } from 'node:fs/promises';
      const [workspacePath, rootPidFile, childPidFile] = process.argv.slice(1);
      const shell = builtinExecutorTools().find((tool) => tool.definition.name === 'shell');
      if (!shell) process.exit(4);
      void shell.execute(
        {
          command: \`printf '%s' "$$" > "\${rootPidFile}"; sleep 60 & echo $! > "\${childPidFile}"; wait\`,
          timeout_ms: 600000,
        },
        { workspacePath, executionId: 'windows-tree-test', signal: new AbortController().signal },
      );
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          await readFile(childPidFile, 'utf8');
          process.exit(0);
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      process.exit(5);
    `;
      const runtimeProcess = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', childSource, workspacePath, rootPidFile, childPidFile],
        {
          env: {
            ...process.env,
            PATH: `${binPath}:${process.env.PATH ?? ''}`,
            PICO_TASKKILL_LOG: taskkillLog,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      runtimeProcess.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      const exit = new Promise<{ code: number | null }>((resolve) => {
        runtimeProcess.once('close', (code) => resolve({ code }));
      });
      const timeout = setTimeout(() => runtimeProcess.kill('SIGKILL'), 5000);
      let rootPid: number | null = null;
      let childPid: number | null = null;
      let childStopped = false;
      try {
        const result = await exit;
        expect(result, stderr).toMatchObject({ code: 0 });
        rootPid = Number(await readFile(rootPidFile, 'utf8'));
        childPid = Number(await readFile(childPidFile, 'utf8'));
        expect(rootPid).toBeGreaterThan(0);
        expect(childPid).toBeGreaterThan(0);
        expect(await readFile(taskkillLog, 'utf8')).toBe(`/PID ${rootPid} /T /F\n`);
        expect(await processStopped(rootPid)).toBe(true);
        childStopped = await processStopped(childPid);
        expect(childStopped).toBe(true);
      } finally {
        clearTimeout(timeout);
        if (rootPid !== null && Number.isSafeInteger(rootPid) && rootPid > 0) {
          try {
            process.kill(rootPid, 'SIGKILL');
          } catch {
            /* The simulated Windows shell may already be gone. */
          }
        }
        if (childPid !== null && Number.isSafeInteger(childPid) && childPid > 0 && !childStopped) {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            /* The simulated Windows child may already be gone. */
          }
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
