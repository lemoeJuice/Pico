import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  localStartRequestBody,
  McpPrivateNetworkAccessControl,
  McpPrivateNetworkAccessStatus,
  McpSettings,
  McpStartConfirmation,
  updateMcpHttpUrlDraft,
} from '../src/web/mcp-settings.js';

describe('MCP settings page', () => {
  it('explains local process permissions and clarifies that Pico does not expose an MCP endpoint', () => {
    const request = async <T,>(): Promise<T> => {
      throw new Error('The server list request is made after mounting.');
    };
    const markup = renderToStaticMarkup(<McpSettings request={request} />);

    expect(markup).toContain('Local server processes run with the same operating-system permissions as Pico.');
    expect(markup).toContain('This setting does not expose an MCP endpoint from Pico.');
    expect(markup).toContain('Add server');
  });

  it('shows the full local command, arguments, working directory, environment names, and permission warning', () => {
    const localSecret = 'never-render-this-environment-secret';
    const server = {
      id: 'local-test',
      name: 'Local server',
      transport: 'stdio' as const,
      status: 'stopped',
      autoStart: false,
      visibleByDefault: false,
      hasToken: false,
      privateNetworkConfirmed: false,
      executionFingerprint: 'current-fingerprint',
      lastError: null,
      tools: [],
      command: '/usr/local/bin/example-mcp',
      args: ['--config', '/tmp/my config.json'],
      cwd: '/tmp/workspace',
      envKeys: ['MCP_API_KEY'],
      env: { MCP_API_KEY: localSecret },
    } as Parameters<typeof McpStartConfirmation>[0]['server'];
    const markup = renderToStaticMarkup(
      <McpStartConfirmation
        server={server}
        busy={false}
        action="start"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain('/usr/local/bin/example-mcp');
    expect(markup).toContain('--config');
    expect(markup).toContain('/tmp/my config.json');
    expect(markup).toContain('/tmp/workspace');
    expect(markup).toContain('MCP_API_KEY');
    expect(markup).not.toContain(localSecret);
    expect(markup).toContain('Environment variable values are hidden and may contain credentials');
    expect(markup).toContain('same operating-system permissions as Pico');
  });

  it('binds local start confirmation to the loaded execution fingerprint', () => {
    expect(localStartRequestBody({ executionFingerprint: 'loaded-config-fingerprint' })).toEqual({
      confirmLocalExecution: true,
      executionFingerprint: 'loaded-config-fingerprint',
    });
    expect(() => localStartRequestBody({})).toThrow('fingerprint is missing');
  });

  it('explains the default private-network block and explicit authorization risk', () => {
    const markup = renderToStaticMarkup(<McpPrivateNetworkAccessControl checked onChange={() => undefined} />);

    expect(markup).toContain('blocks loopback, private and link-local network destinations by default');
    expect(markup).toContain('Allow this server to connect to loopback, private and link-local addresses');
    expect(markup).toContain('Only enable it if you trust the target.');
    expect(markup).toContain('checked=""');
  });

  it('shows private-network authorization on the server status card', () => {
    const markup = renderToStaticMarkup(<McpPrivateNetworkAccessStatus authorized />);

    expect(markup).toContain('is-authorized');
    expect(markup).toContain('Loopback, private and link-local network access authorized');
  });

  it('clears private-network consent when the HTTP origin changes without overriding a later recheck', () => {
    const firstOrigin = {
      url: 'https://first.example/mcp',
      lastKnownUrlOrigin: 'https://first.example',
      confirmPrivateNetworkAccess: true,
    };
    const changedOrigin = updateMcpHttpUrlDraft(firstOrigin, 'https://127.0.0.1:8080/mcp');
    expect(changedOrigin).toMatchObject({
      lastKnownUrlOrigin: 'https://127.0.0.1:8080',
      confirmPrivateNetworkAccess: false,
    });

    const rechecked = { ...changedOrigin, confirmPrivateNetworkAccess: true };
    const sameOriginPathEdit = updateMcpHttpUrlDraft(rechecked, 'https://127.0.0.1:8080/other-path');
    expect(sameOriginPathEdit.confirmPrivateNetworkAccess).toBe(true);

    const invalidIntermediate = updateMcpHttpUrlDraft(sameOriginPathEdit, 'https://');
    const nextOrigin = updateMcpHttpUrlDraft(invalidIntermediate, 'https://second.example/mcp');
    expect(nextOrigin).toMatchObject({
      lastKnownUrlOrigin: 'https://second.example',
      confirmPrivateNetworkAccess: false,
    });
  });

  it('labels the confirmation accurately when restarting a local process', () => {
    const markup = renderToStaticMarkup(
      <McpStartConfirmation
        server={{
          id: 'local-test',
          name: 'Local server',
          transport: 'stdio',
          status: 'ready',
          autoStart: false,
          visibleByDefault: false,
          hasToken: false,
          privateNetworkConfirmed: false,
          executionFingerprint: 'current-fingerprint',
          lastError: null,
          tools: [],
          command: 'example-mcp',
        }}
        busy={false}
        action="restart"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(markup).toContain('Restart this local MCP process?');
    expect(markup).toContain('Restart local process');
  });
});
