import { basename, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Response } from 'express';
import { ServiceError } from '../contracts/service-error.js';
import type { PicoRuntime } from '../runtime/runtime.js';

/** Relay the Executor's workspace file without buffering it in Runtime. */
export async function serveWorkspaceFile(
  runtime: PicoRuntime,
  threadId: string,
  path: unknown,
  response: Response,
): Promise<void> {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\0') ||
    isAbsolute(path) ||
    path.split(/[\\/]/).includes('..')
  ) {
    throw new ServiceError(400, 'Expected a path inside the Thread workspace');
  }
  const controller = new AbortController();
  response.once('close', () => controller.abort());
  const upstream = await runtime.readThreadWorkspaceFile(threadId, path, controller.signal);
  if (!upstream.body) throw new ServiceError(502, 'Executor returned no file content.');
  if (response.destroyed) {
    await upstream.body.cancel();
    return;
  }
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  response.setHeader('Cache-Control', 'no-store');
  response.attachment(basename(path));
  response.type('application/octet-stream');
  const stream = Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>);
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}
