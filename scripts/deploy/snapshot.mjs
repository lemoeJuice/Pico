import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sourceRoots = new Set([
  'src',
  'plugins',
  'public',
  'scripts',
  'test',
  'docs',
  'design-docs',
  'config',
  'migrations',
]);
const sourceFiles = new Set([
  'package.json',
  'package-lock.json',
  'index.html',
  'vite.config.ts',
  'eslint.config.js',
  'README.md',
]);

// Copy the working tree, including uncommitted and untracked files, without
// copying Git metadata, ignored local data or the production build output.
export async function createSourceSnapshot(projectRoot) {
  const { stdout: output } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const snapshotRoot = await mkdtemp(path.join(tmpdir(), 'pico-deploy-source-'));
  try {
    for (const relativePath of new Set(output.split('\0').filter(Boolean))) {
      const parts = relativePath.split('/');
      if (parts.some((part) => part === '..' || part === '.git' || part === 'node_modules')) {
        throw new Error(`Unsafe source path: ${relativePath}`);
      }
      if (
        parts.some((part) => part.startsWith('.') || ['data', 'dist'].includes(part)) ||
        /\.sqlite(?:-shm|-wal)?$/i.test(relativePath)
      )
        continue;
      if (
        !sourceRoots.has(parts[0]) &&
        !sourceFiles.has(relativePath) &&
        !/^tsconfig(?:\.[^.]+)?\.json$/.test(relativePath) &&
        !/^vitest\.config\.[^/]+$/.test(relativePath)
      )
        continue;
      if (/^plugins\/[^/]+\/(?:runtime\.mjs(?:\.map)?|webui\/build\/)/.test(relativePath)) continue;
      const source = path.join(projectRoot, relativePath);
      let entry;
      try {
        entry = await lstat(source);
      } catch (error) {
        // Deleted tracked files must remain deleted in the snapshot.
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (!entry.isFile()) throw new Error(`Cannot snapshot non-regular source file: ${relativePath}`);
      const resolved = await realpath(source);
      const relativeResolved = path.relative(projectRoot, resolved);
      if (
        relativeResolved === '..' ||
        relativeResolved.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeResolved)
      ) {
        throw new Error(`Source path resolves outside the project: ${relativePath}`);
      }
      const destination = path.join(snapshotRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination);
    }
    // Builds use the already-installed dependencies without touching them.
    await symlink(path.join(projectRoot, 'node_modules'), path.join(snapshotRoot, 'node_modules'), 'dir');
    return snapshotRoot;
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function removeSourceSnapshot(snapshotRoot) {
  const expectedParent = await realpath(tmpdir());
  const resolvedParent = await realpath(path.dirname(snapshotRoot));
  if (resolvedParent !== expectedParent || !path.basename(snapshotRoot).startsWith('pico-deploy-source-')) {
    throw new Error('Refusing to remove a path outside the deployment snapshot directory.');
  }
  await rm(snapshotRoot, { recursive: true, force: true });
}
