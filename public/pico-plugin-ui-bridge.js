(() => {
  const reportRuntimeError = (kind) => {
    window.parent.postMessage({ type: 'pico:plugin-ui:runtime-error', kind }, '*');
  };

  window.addEventListener(
    'error',
    (event) => {
      reportRuntimeError(event instanceof ErrorEvent ? 'script-error' : 'resource-error');
    },
    true,
  );
  window.addEventListener('unhandledrejection', () => reportRuntimeError('unhandled-rejection'));
  document.addEventListener('securitypolicyviolation', () => reportRuntimeError('csp-violation'));

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (
      event.source !== window.parent ||
      !message ||
      typeof message !== 'object'
    ) {
      return;
    }
    if (
      message.type === 'pico:plugin-ui:probe' &&
      message.protocolVersion === 1 &&
      typeof message.probeId === 'string'
    ) {
      window.parent.postMessage(
        {
          type: 'pico:plugin-ui:probe-ack',
          protocolVersion: 1,
          probeId: message.probeId,
          capabilities: {
            secureContext: window.isSecureContext,
            randomUUID: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function',
            resizeObserver: typeof ResizeObserver === 'function',
            messageChannel: typeof MessageChannel === 'function',
          },
        },
        '*',
      );
      return;
    }
    if (
      message.type === 'pico:plugin-ui:init' &&
      message.protocolVersion === 1 &&
      typeof message.attemptId === 'string' &&
      event.ports.length === 1
    ) {
      try {
        event.ports[0].postMessage({
          type: 'pico:plugin-ui:bridge-init-ack',
          attemptId: message.attemptId,
        });
      } catch {
        // The host timeout will report that the transferred initialization was not acknowledged.
      }
    }
  });
})();
