import { createHash, randomUUID } from 'node:crypto';
import { ServiceError } from '../contracts/service-error.js';
import type {
  AdapterContribution,
  AdapterMatch,
  CatalogModel,
  CatalogSelection,
  InstanceSecrets,
  ProviderInstance,
  ProviderModel,
  ProviderTypeContribution,
  ProviderTypeDriver,
  ResolvedCatalogSelection,
} from '../contracts/model-catalog.js';
import type { PicoStore } from '../core/store.js';

const namespace = 'pico.model-catalog';
const stateKey = 'instances-v1';
const cacheKey = 'models-v1';
const secretKey = (id: string) => `model-catalog-instance:${id}`;
const clone = <T>(value: T): T => structuredClone(value);
const bad = (message: string): never => {
  throw new ServiceError(400, message);
};
function validId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id);
}
function publicConfig(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(publicConfig);
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      !/(secret|password|credential|api.?key|access.?token|refresh.?token|authorization|cookie|^token$|^key$|^headers$)/i.test(
        key,
      ) && publicConfig(entry),
  );
}
function safeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return bad('Invalid model endpoint.');
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return bad('Invalid model endpoint.');
  }
}
function matches(adapter: AdapterContribution, model: CatalogModel): boolean {
  let endpoint: URL;
  try {
    endpoint = new URL(model.endpoint);
  } catch {
    return false;
  }
  const match = (m: AdapterMatch): boolean => {
    const hostname = endpoint.hostname.toLowerCase();
    const path = endpoint.pathname.replace(/\/+$/, '').toLowerCase();
    const patternMatches = m.endpointHostPatterns?.some(({ prefix, suffix, singleLabel }) => {
      if (
        !hostname.startsWith(prefix) ||
        !hostname.endsWith(suffix) ||
        hostname.length <= prefix.length + suffix.length
      )
        return false;
      const middle = hostname.slice(prefix.length, hostname.length - suffix.length);
      return singleLabel ? /^[a-z0-9-]+$/i.test(middle) : true;
    });
    return (
      ((!m.names?.length && !m.familyPrefixes?.length) ||
        Boolean(m.names?.includes(model.name)) ||
        Boolean(m.familyPrefixes?.some((prefix) => model.name.startsWith(prefix)))) &&
      (!m.protocols?.length || m.protocols.includes(model.protocol)) &&
      (!m.providerTypeIds?.length || m.providerTypeIds.includes(model.providerTypeId)) &&
      (!m.endpointOrigins?.length || m.endpointOrigins.includes(endpoint.origin)) &&
      (!m.endpointPaths?.length ||
        m.endpointPaths.some(
          (path) => path.toLowerCase() === (endpoint.pathname.replace(/\/+$/, '') || '/').toLowerCase(),
        )) &&
      (!m.endpointSchemes?.length || m.endpointSchemes.includes(endpoint.protocol)) &&
      !m.endpointPathExcludedSuffixes?.some((suffix) => path.endsWith(suffix)) &&
      !m.endpointPathExcludes?.some((part) => path.includes(part)) &&
      (!m.endpointVersionedApiPath || /^\/v\d+(?:beta)?(?:\/openai)?(?:\/chat\/completions)?$/i.test(path)) &&
      ((!m.endpointHosts?.length && !m.endpointHostPatterns?.length) ||
        Boolean(m.endpointHosts?.includes(hostname)) ||
        Boolean(patternMatches))
    );
  };
  return match(adapter.match) && (!adapter.matchAny?.length || adapter.matchAny.some(match));
}
export class ModelCatalog {
  private readonly types = new Map<
    string,
    { owner: string; type: ProviderTypeContribution; driver: ProviderTypeDriver }
  >();
  private readonly adapters = new Map<string, { owner: string; adapter: AdapterContribution }>();
  private readonly refreshing = new Map<string, number>();
  constructor(
    private readonly store: PicoStore,
    private readonly onChange?: () => void,
  ) {}
  registerProviderType(owner: string, type: ProviderTypeContribution, driver: ProviderTypeDriver): void {
    if (
      !validId(owner) ||
      !validId(type.id) ||
      !type.label.trim() ||
      type.addPage.pluginId !== owner ||
      !validId(type.addPage.pageId)
    )
      bad('Invalid provider type.');
    if (this.types.has(type.id)) throw new ServiceError(409, 'Provider type already registered.');
    this.types.set(type.id, { owner, type: clone(type), driver });
    this.onChange?.();
  }
  registerAdapter(owner: string, adapter: AdapterContribution): void {
    if (
      !validId(owner) ||
      !validId(adapter.id) ||
      !adapter.label.trim() ||
      !adapter.match ||
      !adapter.controls ||
      !adapter.temperature
    )
      bad('Invalid adapter.');
    if (this.adapters.has(adapter.id)) throw new ServiceError(409, 'Adapter already registered.');
    if (new Set(adapter.controls.map((control) => control.id)).size !== adapter.controls.length)
      bad('Duplicate adapter control.');
    this.adapters.set(adapter.id, {
      owner,
      adapter: {
        ...adapter,
        match: clone(adapter.match),
        controls: clone(adapter.controls),
        temperature: clone(adapter.temperature),
      },
    });
    this.onChange?.();
  }
  listProviderTypes(): ProviderTypeContribution[] {
    return [...this.types.values()].map(({ type }) => clone(type));
  }
  listInstances(): ProviderInstance[] {
    return clone(this.store.getPluginState<ProviderInstance[]>(namespace, stateKey, []));
  }
  addInstance(
    owner: string,
    typeId: string,
    input: { label: string; config: Record<string, unknown> },
  ): ProviderInstance {
    const type = this.types.get(typeId);
    if (!type || type.owner !== owner) throw new ServiceError(404, 'Provider type unavailable.');
    if (!input.label.trim() || !publicConfig(input.config)) bad('Invalid provider instance configuration.');
    const instance: ProviderInstance = {
      id: randomUUID(),
      typeId,
      owner,
      label: input.label.trim(),
      config: clone(input.config),
      createdAt: new Date().toISOString(),
    };
    this.store.transaction(() => this.store.setPluginState(namespace, stateKey, [...this.listInstances(), instance]));
    this.onChange?.();
    return clone(instance);
  }
  private instance(owner: string, id: string): ProviderInstance {
    const instance = this.listInstances().find((entry) => entry.id === id && entry.owner === owner);
    if (!instance) throw new ServiceError(404, 'Provider instance unavailable.');
    return instance;
  }
  getInstanceSecrets(owner: string, id: string): InstanceSecrets {
    this.instance(owner, id);
    const read = (): Record<string, unknown> => {
      this.instance(owner, id);
      return this.store.getPrivateSecret(owner, secretKey(id), {});
    };
    return {
      get: <T>(key: string, fallback: T): T => {
        const values = read();
        return Object.hasOwn(values, key) ? clone(values[key] as T) : fallback;
      },
      set: <T>(key: string, value: T): void => {
        const values = read();
        values[key] = value;
        this.store.setPrivateSecret(owner, secretKey(id), values);
      },
      delete: (key: string): void => {
        const values = read();
        delete values[key];
        this.store.setPrivateSecret(owner, secretKey(id), values);
      },
    };
  }
  async removeInstance(owner: string, id: string): Promise<void> {
    const instance = this.instance(owner, id);
    const driver = this.types.get(instance.typeId)?.driver;
    this.refreshing.set(id, (this.refreshing.get(id) ?? 0) + 1);
    this.store.transaction(() => {
      this.store.setPluginState(
        namespace,
        stateKey,
        this.listInstances().filter((entry) => entry.id !== id),
      );
      this.store.setPluginCache(
        namespace,
        cacheKey,
        this.cached().filter((entry) => entry.instanceId !== id),
      );
      this.store.deletePrivateSecret(owner, secretKey(id));
    });
    this.onChange?.();
    await driver?.disposeInstance?.(clone(instance));
  }
  private cached(): CatalogModel[] {
    return this.store.getPluginCache<CatalogModel[]>(namespace, cacheKey, []);
  }
  listModels(): CatalogModel[] {
    return clone(
      this.cached().map((model) => {
        const instance = this.listInstances().find((entry) => entry.id === model.instanceId);
        const type = instance && this.types.get(instance.typeId);
        return type && type.owner === instance?.owner ? model : { ...model, availability: 'unknown' as const };
      }),
    );
  }
  async refreshInstance(id: string, signal?: AbortSignal): Promise<CatalogModel[]> {
    const instance = this.listInstances().find((entry) => entry.id === id);
    if (!instance) throw new ServiceError(404, 'Provider instance unavailable.');
    const type = this.types.get(instance.typeId);
    if (!type || type.owner !== instance.owner) throw new ServiceError(404, 'Provider type unavailable.');
    const generation = (this.refreshing.get(id) ?? 0) + 1;
    this.refreshing.set(id, generation);
    try {
      const raw = await type.driver.listModels(clone(instance), signal);
      if (!Array.isArray(raw)) throw new Error('Invalid model list');
      const ids = new Set<string>();
      const models: CatalogModel[] = raw.map((item: ProviderModel) => {
        if (
          !item.id ||
          !item.name ||
          !item.label ||
          !item.protocol ||
          typeof item.supportsImages !== 'boolean' ||
          ids.has(item.id)
        )
          throw new Error('Invalid model');
        ids.add(item.id);
        return {
          id: item.id,
          name: item.name,
          label: item.label,
          protocol: item.protocol,
          supportsImages: item.supportsImages,
          endpoint: safeEndpoint(item.endpoint),
          instanceId: id,
          providerTypeId: instance.typeId,
          modelId: createHash('sha256')
            .update(JSON.stringify([id, item.id]))
            .digest('hex'),
          availability: 'available',
        };
      });
      if (
        this.refreshing.get(id) !== generation ||
        this.types.get(instance.typeId) !== type ||
        !this.listInstances().some((entry) => entry.id === id)
      )
        return this.listModels().filter((entry) => entry.instanceId === id);
      const existing = this.cached();
      const removed = existing
        .filter((entry) => entry.instanceId === id && !ids.has(entry.id))
        .map((entry) => ({ ...entry, availability: 'unavailable' as const }));
      this.store.setPluginCache(namespace, cacheKey, [
        ...existing.filter((entry) => entry.instanceId !== id),
        ...models,
        ...removed,
      ]);
      this.onChange?.();
      return this.listModels().filter((entry) => entry.instanceId === id);
    } catch {
      if (this.refreshing.get(id) === generation && this.listInstances().some((entry) => entry.id === id)) {
        this.store.setPluginCache(
          namespace,
          cacheKey,
          this.cached().map((entry) =>
            entry.instanceId === id && entry.availability !== 'unavailable'
              ? { ...entry, availability: 'unknown' }
              : entry,
          ),
        );
        this.onChange?.();
      }
      throw new ServiceError(409, 'Unable to refresh provider models.');
    }
  }
  matchingAdapters(modelId: string): AdapterContribution[] {
    const model = this.listModels().find((entry) => entry.modelId === modelId);
    return model
      ? [...this.adapters.values()]
          .map(({ adapter }) => adapter)
          .filter((adapter) => matches(adapter, model))
          .map((adapter) => ({
            ...adapter,
            match: clone(adapter.match),
            controls: clone(adapter.controlsForModel?.(clone(model)) ?? adapter.controls),
            temperature: clone(adapter.temperatureForModel?.(clone(model)) ?? adapter.temperature),
          }))
      : [];
  }
  validateSelection(selection: CatalogSelection): CatalogSelection {
    if (
      !selection ||
      typeof selection.modelId !== 'string' ||
      typeof selection.adapterId !== 'string' ||
      !selection.parameters ||
      !selection.parameters.options ||
      typeof selection.parameters.options !== 'object' ||
      Array.isArray(selection.parameters.options)
    )
      bad('Invalid model selection.');
    if (!selection.modelId && !selection.adapterId) {
      if (Object.keys(selection.parameters.options).length || selection.parameters.temperature != null)
        bad('Unselected model cannot have parameters.');
      return clone(selection);
    }
    const model = this.listModels().find((entry) => entry.modelId === selection.modelId);
    const adapter = this.adapters.get(selection.adapterId)?.adapter;
    if (!model || model.availability === 'unavailable' || !adapter || !matches(adapter, model))
      throw new ServiceError(409, 'Selected model or adapter is unavailable.');
    const instance = this.listInstances().find((entry) => entry.id === model.instanceId);
    if (!instance || this.types.get(instance.typeId)?.owner !== instance.owner)
      throw new ServiceError(409, 'Selected provider is unavailable.');
    const controls = adapter.controlsForModel?.(clone(model)) ?? adapter.controls;
    const temperature = adapter.temperatureForModel?.(clone(model)) ?? adapter.temperature;
    const validate = (parameters: CatalogSelection['parameters']): void => {
      const temp = parameters.temperature;
      if (
        temp !== undefined &&
        temp !== null &&
        (!temperature.supported ||
          typeof temp !== 'number' ||
          !Number.isFinite(temp) ||
          temp < (temperature.min ?? -Infinity) ||
          temp > (temperature.max ?? Infinity))
      )
        bad('Invalid temperature.');
      if (!parameters.options || typeof parameters.options !== 'object' || Array.isArray(parameters.options))
        bad('Invalid model options.');
      for (const [key, value] of Object.entries(parameters.options)) {
        if (
          /^(?:api.?key|authorization|access.?token|refresh.?token|secret|password|token|key|headers|cookie)$/i.test(
            key,
          )
        )
          bad('Model parameters cannot contain credentials.');
        const control = controls.find((item) => item.id === key);
        if (
          !control ||
          typeof value !== control.type ||
          (typeof value === 'number' &&
            (!Number.isFinite(value) || value < (control.min ?? -Infinity) || value > (control.max ?? Infinity))) ||
          (control.choices && !control.choices.includes(value))
        )
          bad('Invalid model option.');
      }
    };
    validate(selection.parameters);
    let parameters = clone(selection.parameters);
    try {
      if (adapter.normalize) parameters = adapter.normalize(clone(model), parameters);
      validate(parameters);
    } catch {
      return bad('Invalid model parameters.');
    }
    return { modelId: selection.modelId, adapterId: selection.adapterId, parameters };
  }
  resolveSelection(selection: CatalogSelection): ResolvedCatalogSelection {
    const normalized = this.validateSelection(selection);
    if (!normalized.modelId || !normalized.adapterId) throw new ServiceError(409, 'Select a model and adapter.');
    const model = this.listModels().find((entry) => entry.modelId === normalized.modelId)!;
    const instance = this.listInstances().find((entry) => entry.id === model.instanceId)!;
    const adapter = this.adapters.get(normalized.adapterId)!.adapter;
    try {
      return {
        model,
        instance,
        adapter,
        requestParameters: adapter.serialize?.(clone(model), clone(normalized.parameters)) ?? {
          fields: clone(normalized.parameters.options),
          ...(normalized.parameters.temperature !== undefined
            ? { temperature: normalized.parameters.temperature }
            : {}),
        },
      };
    } catch {
      throw new ServiceError(400, 'Unable to serialize model parameters.');
    }
  }
  async authorizeInstance(id: string, forceRefresh: boolean, signal?: AbortSignal): Promise<Record<string, string>> {
    const instance = this.listInstances().find((entry) => entry.id === id);
    const type = instance && this.types.get(instance.typeId);
    if (!instance || !type || type.owner !== instance.owner)
      throw new ServiceError(409, 'Selected provider is unavailable.');
    return type.driver.authorize(clone(instance), forceRefresh, signal);
  }
  removeOwner(owner: string): void {
    for (const [id, type] of this.types) if (type.owner === owner) this.types.delete(id);
    for (const [id, adapter] of this.adapters) if (adapter.owner === owner) this.adapters.delete(id);
    this.onChange?.();
  }
}
