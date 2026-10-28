import type { ModelRequestParameters } from './model.js';

export type ModelOptionValue = string | number | boolean;
export interface CatalogSelection {
  modelId: string;
  adapterId: string;
  parameters: { temperature?: number | null; options: Record<string, ModelOptionValue> };
}
export interface ProviderTypeContribution {
  id: string;
  label: string;
  description?: string;
  addPage: { pluginId: string; pageId: string };
}
export interface ProviderInstance {
  id: string;
  typeId: string;
  owner: string;
  label: string;
  config: Record<string, unknown>;
  createdAt: string;
}
export interface ProviderModel {
  id: string;
  name: string;
  label: string;
  protocol: string;
  supportsImages: boolean;
  endpoint: string;
}
export interface CatalogModel extends ProviderModel {
  modelId: string;
  instanceId: string;
  providerTypeId: string;
  availability: 'available' | 'unknown' | 'unavailable';
}
export interface ProviderTypeDriver {
  /** Release external instance-owned resources after its local registration is revoked. */
  disposeInstance?(instance: ProviderInstance): Promise<void> | void;
  listModels(instance: ProviderInstance, signal?: AbortSignal): Promise<ProviderModel[]>;
  authorize(instance: ProviderInstance, forceRefresh: boolean, signal?: AbortSignal): Promise<Record<string, string>>;
}
export interface AdapterControl {
  id: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  choices?: ModelOptionValue[];
  min?: number;
  max?: number;
  step?: number;
  group?: 'primary' | 'others';
  description?: string;
  defaultValue?: ModelOptionValue;
  choiceLabels?: Record<string, string>;
}
export interface AdapterTemperature {
  supported: boolean;
  min?: number;
  max?: number;
  step?: number;
  fixedValue?: number;
  description?: string;
}
export interface AdapterMatch {
  names?: string[];
  familyPrefixes?: string[];
  protocols?: string[];
  providerTypeIds?: string[];
  endpointOrigins?: string[];
  endpointPaths?: string[];
  endpointHosts?: string[];
  endpointSchemes?: string[];
  endpointHostPatterns?: { prefix: string; suffix: string; singleLabel?: boolean }[];
  endpointPathExcludedSuffixes?: string[];
  endpointPathExcludes?: string[];
  endpointVersionedApiPath?: boolean;
}
export interface AdapterContribution {
  id: string;
  label: string;
  description?: string;
  match: AdapterMatch;
  matchAny?: AdapterMatch[];
  controls: AdapterControl[];
  temperature: AdapterTemperature;
  controlsForModel?: (model: CatalogModel) => AdapterControl[];
  temperatureForModel?: (model: CatalogModel) => AdapterTemperature;
  protocolTraits?: { reasoningContent?: boolean; cacheHitMissUsage?: boolean };
  replayFormat?: string;
  transformPrompt?: (prompt: import('./model.js').ModelPrompt) => import('./model.js').ModelPrompt;
  transformResponse?: (response: import('./model.js').ModelResponse) => import('./model.js').ModelResponse;
  normalize?: (model: CatalogModel, parameters: CatalogSelection['parameters']) => CatalogSelection['parameters'];
  serialize?: (model: CatalogModel, parameters: CatalogSelection['parameters']) => ModelRequestParameters;
  replayCompatible?: (model: CatalogModel, replay: unknown) => boolean;
}
export interface ResolvedCatalogSelection {
  model: CatalogModel;
  instance: ProviderInstance;
  adapter: AdapterContribution;
  requestParameters: ModelRequestParameters;
}
export interface InstanceSecrets {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}
