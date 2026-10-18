import type { ModelParameterProfile, ModelParameterTarget } from '../types.js';

export const openAiCompatibleFallbackProfile: ModelParameterProfile = {
  id: 'pico.openai-compatible.temperature',
  matches(target: ModelParameterTarget) {
    return target.provider === 'openai-compatible';
  },
  controls() {
    return [];
  },
  temperature() {
    return { mode: 'adjustable', min: 0, max: 2, step: 0.1 };
  },
  serialize() {
    return {};
  },
};
