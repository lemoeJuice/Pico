/** Model-family compatibility that applies across OpenAI-compatible endpoints. */
export function isDeepSeekModelId(model: string): boolean {
  return model.toLowerCase().includes('deepseek');
}
