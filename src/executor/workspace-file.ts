import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Response } from 'express';

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

class WorkspaceFileNotFound extends Error {}

export async function serveRemoteWorkspaceFile(
  workspacePath: unknown,
  requestedPath: unknown,
  validateWorkspace: (path: unknown) => Promise<string>,
  response: Response,
): Promise<void> {
  if (
    typeof requestedPath !== 'string' ||
    !requestedPath ||
    requestedPath.includes('\0') ||
    isAbsolute(requestedPath) ||
    requestedPath.split(/[\\/]/).includes('..')
  ) {
    response.status(400).json({ error: 'Expected a relative path inside the workspace.' });
    return;
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const root = await validateWorkspace(workspacePath);
    const target = await realpath(resolve(root, requestedPath));
    if (!inside(root, target)) throw new WorkspaceFileNotFound();
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) throw new WorkspaceFileNotFound();
    if (process.platform === 'linux' && !inside(root, await realpath(`/proc/self/fd/${handle.fd}`))) {
      throw new WorkspaceFileNotFound();
    }

    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.attachment(target.split(/[\\/]/).at(-1) || 'download');
    response.type('application/octet-stream');
    const stream = handle.createReadStream();
    handle = undefined;
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof WorkspaceFileNotFound || code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
      response.status(404).json({ error: 'Workspace file not found.' });
      return;
    }
    response.status(400).json({ error: 'Workspace file could not be accessed.' });
  }
}
