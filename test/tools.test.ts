import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinExecutorTools } from '../src/executor/tools.js';

const toolMap = new Map(builtinExecutorTools().map((tool) => [tool.definition.name, tool]));

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
});
