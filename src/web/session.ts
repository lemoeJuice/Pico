export async function isSessionExpired(fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher('/api/auth/status', { cache: 'no-store' });
    if (!response.ok) return false;
    const status = (await response.json()) as { authRequired?: boolean; authenticated?: boolean };
    return status.authRequired === true && status.authenticated === false;
  } catch {
    // A network failure is not evidence that the browser session expired.
    return false;
  }
}
