export type PromptLoopGroupKey = "standard" | "masterprompt" | "batchprompt" | "rewrite";

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
