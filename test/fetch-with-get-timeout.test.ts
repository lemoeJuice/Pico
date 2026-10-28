import { describe, expect, it } from 'vitest';
import { fetchWithGetTimeout } from '../src/web/fetch-with-get-timeout.js';

describe('fetchWithGetTimeout', () => {
  it('combines the GET timeout with a caller signal', async () => {
    let captured: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      captured = init;
      return new Response('ok');
    };
    const caller = new AbortController();

    await fetchWithGetTimeout('/snapshot', { signal: caller.signal }, 100, fetcher);

    expect(captured?.signal).not.toBe(caller.signal);
    caller.abort();
    expect(captured?.signal?.aborted).toBe(true);
  });

  it('aborts an in-flight GET when the default timeout expires', async () => {
    const fetcher: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });

    await expect(fetchWithGetTimeout('/slow-read', {}, 5, fetcher)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('leaves %s requests and their signal untouched', async (method) => {
    let captured: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      captured = init;
      return new Response('ok');
    };
    const controller = new AbortController();
    const request: RequestInit = { method, signal: controller.signal, body: '{}' };

    await fetchWithGetTimeout('/write', request, 1, fetcher);

    expect(captured).toBe(request);
    expect(captured?.signal).toBe(controller.signal);
    expect(captured?.signal?.aborted).toBe(false);
  });

  it('uses GET semantics when the caller omits a method', async () => {
    let captured: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      captured = init;
      return new Response('ok');
    };

    await fetchWithGetTimeout('/read', {}, 100, fetcher);

    expect(captured?.signal).toBeInstanceOf(AbortSignal);
  });
});
