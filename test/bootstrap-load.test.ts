import { describe, expect, it, vi } from 'vitest';
import { loadBootstrapResource } from '../src/web/bootstrap-load.js';

describe('independent workspace bootstrap', () => {
  it('applies Projects while another resource is still waiting and isolates permanent failures', async () => {
    let finishOptional!: (value: string) => void;
    const waiting = new Promise<string>((resolve) => {
      finishOptional = resolve;
    });
    const optionalApplied = vi.fn();
    const projectsApplied = vi.fn();
    const failures = vi.fn();
    const optional = loadBootstrapResource(
      () => waiting,
      () => true,
      optionalApplied,
      failures,
    );
    const projects = loadBootstrapResource(
      async () => ['project'],
      () => true,
      projectsApplied,
      failures,
    );
    const failed = loadBootstrapResource(
      async () => {
        throw Object.assign(new Error('not found'), { status: 404 });
      },
      () => true,
      vi.fn(),
      failures,
    );

    await Promise.all([projects, failed]);
    expect(projectsApplied).toHaveBeenCalledWith(['project']);
    expect(optionalApplied).not.toHaveBeenCalled();
    expect(failures).toHaveBeenCalledTimes(1);
    finishOptional('ready');
    await optional;
    expect(optionalApplied).toHaveBeenCalledWith('ready');
  });

  it('ignores a response after its owner is no longer current', async () => {
    let current = true;
    const apply = vi.fn();
    await loadBootstrapResource(
      async () => {
        current = false;
        return 'late';
      },
      () => current,
      apply,
      vi.fn(),
    );
    expect(apply).not.toHaveBeenCalled();
  });
});
