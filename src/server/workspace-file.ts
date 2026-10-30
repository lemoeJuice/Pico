import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Response } from 'express';
import type { Thread } from '../core/types.js';

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Serve only local Thread workspace files; never execute their contents in Pico's origin. */
export async function serveWorkspaceFile(thread: Thread | null, path: unknown, response: Response): Promise<void> {
  if (!thread || thread.deletedAt) {
    response.status(404).json({ error: 'Thread not found' });
    return;
  }
  if (thread.executorKind === 'runtime' || thread.executorRemote) {
    response.status(409).json({ error: 'File access is unavailable for this Thread executor' });
    return;
  }
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\0') ||
    isAbsolute(path) ||
    path.split(/[\\/]/).includes('..')
  ) {
    response.status(400).json({ error: 'Expected a path inside the Thread workspace' });
    return;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const root = await realpath(thread.workspacePath);
    const target = await realpath(resolve(root, path));
    if (!inside(root, target)) throw new Error('Outside workspace');
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) throw new Error('Not a regular file');
    // Validate the opened file itself on Linux, including against parent-directory symlink races.
    if (process.platform === 'linux' && !inside(root, await realpath(`/proc/self/fd/${handle.fd}`))) {
      throw new Error('Outside workspace');
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    response.setHeader('Cache-Control', 'no-store');
    response.attachment(target);
    response.type('application/octet-stream');
    const stream = handle.createReadStream();
    handle = undefined;
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch {
    await handle?.close().catch(() => undefined);
    if (!response.headersSent) response.status(404).json({ error: 'Workspace file not found' });
    else response.destroy();
  }
}
