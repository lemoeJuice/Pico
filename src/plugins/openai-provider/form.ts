export function providerInstanceRequest(form: {
  label: string;
  baseUrl: string;
  protocol: string;
  apiKey: string;
  models: string;
}) {
  return {
    label: form.label.trim(),
    baseUrl: form.baseUrl.trim(),
    protocol: form.protocol,
    ...(form.apiKey ? { apiKey: form.apiKey } : {}),
    models: form.models
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean),
  };
}
