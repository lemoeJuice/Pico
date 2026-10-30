import { openAiCompatibleFallbackProfile } from './openai-compatible.js';
import { coreVendorProfiles } from './core-vendors.js';
import { asiaCoreParameterProfiles } from './asia-core.js';
import { asiaNewParameterProfile } from './asia-new.js';
import { asiaParameterProfiles } from './asia-parameters.js';
import { nvidiaMetaParameterProfile } from './nvidia-meta.js';
import type { ModelParameterProfile } from '../types.js';

/** Keep exact, provider-owned profiles before the generic compatibility fallback. */
export const profiles: ModelParameterProfile[] = [
  ...coreVendorProfiles,
  ...asiaCoreParameterProfiles,
  asiaNewParameterProfile,
  ...asiaParameterProfiles,
  nvidiaMetaParameterProfile,
  openAiCompatibleFallbackProfile,
];
