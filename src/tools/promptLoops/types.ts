export type PromptLoopGroupKey = "prompt" | "goal-prompt" | "batch-prompt" | "rewrite";

export interface PromptLoopItem {
  id: string;
  title: string;
  meta: string;
  prompt: string;
}

export interface PromptLoopGroup {
  group: string;
  key: PromptLoopGroupKey;
  items: PromptLoopItem[];
}
