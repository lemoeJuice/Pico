export type ModelParameterValue = string | number | boolean;
export type ModelParameterSelection = Record<string, ModelParameterValue>;

export interface ModelParameterOption {
  value: string;
  label: string;
}

export interface ModelParameterControl {
  id: string;
  label: string;
  kind: 'select' | 'toggle' | 'range';
  group: 'primary' | 'others';
  defaultValue?: ModelParameterValue;
  options?: ModelParameterOption[];
  min?: number;
  max?: number;
  step?: number;
  description?: string;
}

export type TemperatureCapability =
  | { mode: 'adjustable'; min: number; max: number; step: number; description?: string }
  | { mode: 'fixed'; value: number; description?: string }
  | { mode: 'unsupported'; description?: string };

export interface ModelParameterTarget {
  provider: string;
  endpoint: string;
  protocol: 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages' | 'provider-native';
  model: string;
}

export interface ModelParameterProfile {
  id: string;
  matches(target: ModelParameterTarget): boolean;
  controls(target: ModelParameterTarget): ModelParameterControl[];
  temperature(target: ModelParameterTarget): TemperatureCapability;
  serialize(
    target: ModelParameterTarget,
    selection: ModelParameterSelection,
    temperature: number,
  ): Record<string, unknown>;
}

export interface ModelParameterProfileView {
  profileId: string | null;
  controls: ModelParameterControl[];
  temperature: TemperatureCapability;
  values: ModelParameterSelection;
}

export interface ModelRequestParameters {
  /** Validated, provider-specific optional request fields produced by a trusted profile. */
  fields: Record<string, unknown>;
}
