export interface PluginAuthPopupLease {
  pluginId: string;
  entry: string;
  viewId: string;
  actionId: string;
  port: object;
  popup: { closed: boolean };
  expiresAt: number;
  operationId?: string;
  callbackOrigin?: string;
  callbackConsumed?: boolean;
}

export interface PluginAuthPopupNavigation {
  pluginId: string;
  entry: string;
  viewId: string;
  leaseId: string;
  authorizationUrl: string;
  callbackOrigin: string;
  operationId: string;
}

export function validatePluginAuthPopupNavigation(
  lease: PluginAuthPopupLease | undefined,
  request: PluginAuthPopupNavigation,
  port: object,
  allowedOrigins: readonly string[],
  now = Date.now(),
): { authorizationUrl: URL; callbackOrigin: URL } | null {
  if (
    !lease ||
    lease.port !== port ||
    lease.pluginId !== request.pluginId ||
    lease.entry !== request.entry ||
    lease.viewId !== request.viewId ||
    lease.expiresAt <= now ||
    lease.popup.closed ||
    lease.operationId !== undefined ||
    lease.callbackOrigin !== undefined ||
    lease.callbackConsumed
  )
    return null;
  let authorizationUrl: URL;
  let callbackOrigin: URL;
  try {
    authorizationUrl = new URL(request.authorizationUrl);
    callbackOrigin = new URL(request.callbackOrigin);
  } catch {
    return null;
  }
  if (
    authorizationUrl.protocol !== 'https:' ||
    authorizationUrl.username !== '' ||
    authorizationUrl.password !== '' ||
    !allowedOrigins.includes(authorizationUrl.origin) ||
    typeof request.operationId !== 'string' ||
    request.operationId.length === 0 ||
    request.operationId.length > 200 ||
    !isLocalAuthCallbackOrigin(callbackOrigin)
  )
    return null;
  return { authorizationUrl, callbackOrigin };
}

export function validatePluginAuthPopupCallback(
  lease: PluginAuthPopupLease,
  source: object | null,
  origin: string,
  operationId: string | undefined,
  port: object,
  now = Date.now(),
): boolean {
  return Boolean(
    source &&
    source === lease.popup &&
    port === lease.port &&
    typeof lease.operationId === 'string' &&
    operationId === lease.operationId &&
    lease.callbackOrigin === origin &&
    lease.callbackConsumed !== true &&
    lease.expiresAt > now,
  );
}

function isLocalAuthCallbackOrigin(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
    url.port !== '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === ''
  );
}
