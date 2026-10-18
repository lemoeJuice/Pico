import type {
  ModelParameterControl,
  ModelParameterProfile,
  ModelParameterSelection,
  ModelParameterTarget,
  ModelParameterValue,
  TemperatureCapability,
} from './types.js';
import { profiles } from './providers/index.js';
import { normalizeModelEndpoint } from './target.js';

export function profileForTarget(target: ModelParameterTarget): ModelParameterProfile | undefined {
  const normalized = { ...target, endpoint: normalizeModelEndpoint(target.endpoint) };
  return profiles.find((profile) => profile.matches(normalized));
}

export function controlsForTarget(target: ModelParameterTarget): ModelParameterControl[] {
  return profileForTarget(target)?.controls(target) ?? [];
}

export function temperatureForTarget(target: ModelParameterTarget): TemperatureCapability {
  return profileForTarget(target)?.temperature(target) ?? {
    mode: 'adjustable',
    min: 0,
    max: 2,
    step: 0.1,
    description: 'The provider may apply its own model-specific limits.',
  };
}

function isValidValue(control: ModelParameterControl, value: unknown): value is ModelParameterValue {
  if (control.kind === 'toggle') return typeof value === 'boolean';
  if (control.kind === 'select') {
    return typeof value === 'string' && Boolean(control.options?.some((option) => option.value === value));
  }
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    typeof control.min === 'number' &&
    typeof control.max === 'number' &&
    value >= control.min &&
    value <= control.max
  );
}

export function sanitizeSelection(
  target: ModelParameterTarget,
  selection: unknown,
  includeDefaults = true,
): ModelParameterSelection {
  const profile = profileForTarget(target);
  if (!profile || !selection || typeof selection !== 'object' || Array.isArray(selection)) return {};
  const source = selection as Record<string, unknown>;
  const controls = profile.controls(target);
  const result: ModelParameterSelection = {};
  for (const control of controls) {
    const value = source[control.id];
    if (isValidValue(control, value)) result[control.id] = value;
    else if (includeDefaults && control.defaultValue !== undefined) result[control.id] = control.defaultValue;
  }
  return result;
}

export function validateSelection(
  target: ModelParameterTarget,
  selection: unknown,
): ModelParameterSelection | null {
  const profile = profileForTarget(target);
  if (!profile || !selection || typeof selection !== 'object' || Array.isArray(selection)) return null;
  const source = selection as Record<string, unknown>;
  const controls = profile.controls(target);
  if (Object.keys(source).some((key) => !controls.some((control) => control.id === key))) return null;
  if (controls.some((control) => source[control.id] !== undefined && !isValidValue(control, source[control.id]))) {
    return null;
  }
  return sanitizeSelection(target, source);
}

export function serializeSelection(
  target: ModelParameterTarget,
  selection: ModelParameterSelection,
  temperature: number,
): Record<string, unknown> | undefined {
  const profile = profileForTarget(target);
  if (!profile) return undefined;
  return profile.serialize(target, sanitizeSelection(target, selection), temperature);
}
