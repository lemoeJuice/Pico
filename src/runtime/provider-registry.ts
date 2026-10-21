import type { ModelProviderContribution, ModelSettings } from '../core/types.js';
import type { ModelResponse } from '../contracts/model.js';
import type { ModelStageInput } from './stages.js';

export type RegisteredModelHandler = (input: ModelStageInput, settings: ModelSettings) => Promise<ModelResponse>;
export interface ModelSelectionTarget { provider: string; connectionId: string; model: string; baseUrl: string }
export type ModelSelectionOptions = Record<string, string | number | boolean>;
export type ModelSelectionNormalizer = (target: ModelSelectionTarget, options: ModelSelectionOptions) => ModelSelectionOptions;
export type InitialModelSelection = (target: ModelSelectionTarget) => ModelSelectionOptions;

interface RegisteredProvider extends ModelProviderContribution {
  owner: string;
  handle: RegisteredModelHandler;
}

/** The terminal model-stage dispatcher. A provider's metadata and executable adapter share one registration. */
export class ModelProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();
  private readonly selectionNormalizers = new Map<string, { owner: string; normalize: ModelSelectionNormalizer; initial?: InitialModelSelection }>();

  registerSelectionNormalizer(owner: string, provider: string, normalize: ModelSelectionNormalizer, initial?: InitialModelSelection): void {
    if (this.selectionNormalizers.has(provider)) throw new Error(`Model selection normalizer for ${provider} is already registered`);
    this.selectionNormalizers.set(provider, { owner, normalize, ...(initial ? { initial } : {}) });
  }

  initialSelection(target: ModelSelectionTarget): ModelSelectionOptions {
    return this.selectionNormalizers.get(target.provider)?.initial?.(target) ?? {};
  }

  normalizeSelection(target: ModelSelectionTarget, options: ModelSelectionOptions): ModelSelectionOptions {
    const normalizer = this.selectionNormalizers.get(target.provider)?.normalize;
    if (!normalizer) {
      if (Object.keys(options).length) throw new Error(`Model parameters are not supported for provider "${target.provider}".`);
      return {};
    }
    return normalizer(target, options);
  }

  register(owner: string, contribution: ModelProviderContribution, handle: RegisteredModelHandler): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(contribution.id)) throw new Error(`Invalid model provider ID: ${contribution.id}`);
    if (!contribution.label.trim()) throw new Error('Model provider label is required.');
    if (this.providers.has(contribution.id)) throw new Error(`Model provider ${contribution.id} is already registered`);
    this.providers.set(contribution.id, { ...contribution, owner, handle });
  }

  removeOwner(owner: string): void {
    for (const [id, provider] of this.providers) if (provider.owner === owner) this.providers.delete(id);
    for (const [id, contribution] of this.selectionNormalizers) if (contribution.owner === owner) this.selectionNormalizers.delete(id);
  }

  list(): ModelProviderContribution[] {
    return [...this.providers.values()].map(({ owner: _owner, handle: _handle, ...provider }) => ({ ...provider }));
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  async dispatch(input: ModelStageInput, settings: ModelSettings): Promise<ModelResponse> {
    const provider = this.providers.get(input.modelTarget?.provider ?? input.provider);
    if (!provider) throw new Error(`Model provider "${input.modelTarget?.provider ?? input.provider}" is unavailable.`);
    if (input.modelTarget && input.provider !== input.modelTarget.provider) {
      throw new Error('Model pipeline provider and target identity do not match.');
    }
    return provider.handle(input, settings);
  }
}
