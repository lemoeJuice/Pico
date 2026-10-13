export type ChatGptReasoningEffort = 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ChatGptModelChoice {
  slug: string;
  displayName: string;
}

export interface ChatGptPlanPreferences {
  reasoningEffort: ChatGptReasoningEffort;
  fastMode: boolean;
}

export const defaultChatGptPlanPreferences: ChatGptPlanPreferences = {
  reasoningEffort: 'auto',
  fastMode: false,
};
