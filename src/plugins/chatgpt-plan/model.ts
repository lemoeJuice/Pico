import { ResponsesModelAdapter } from '../../runtime/responses-model.js';
import type { ChatGptPlanAuth } from './auth.js';

/** Compatibility bridge while plugin callers migrate to the framework adapter. */
export class ChatGptResponsesAdapter extends ResponsesModelAdapter {
  constructor(auth: ChatGptPlanAuth, fetcher: typeof fetch = fetch) {
    super({
      endpoint: 'https://api.openai.com/v1/responses',
      provider: 'chatgpt-plan',
      chatgpt: true,
      authorization: {
        accessToken: (_signal, forceRefresh, trace) => auth.accessToken(forceRefresh, trace),
        refreshOnUnauthorized: true,
      },
      fetcher,
      fetchRetries: 5,
      retryDelayMs: 2000,
    });
  }
}
