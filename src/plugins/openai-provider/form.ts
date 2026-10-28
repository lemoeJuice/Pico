export function providerInstanceRequest(form: { baseUrl: string; protocol: string; apiKey: string; models: string }) {
  return {
    baseUrl: form.baseUrl.trim(),
    protocol: form.protocol,
    ...(form.apiKey ? { apiKey: form.apiKey } : {}),
    models: form.models
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean),
  };
}
