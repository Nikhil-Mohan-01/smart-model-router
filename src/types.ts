// ─── Task Classification ───────────────────────────────────────────────────

export type TaskType =
  | 'debug'
  | 'codegen'
  | 'architect'
  | 'explain'
  | 'test'
  | 'general';

export interface ClassificationResult {
  taskType: TaskType;
  confidence: number; // 0–1
  reasoning: string;
}

// ─── Model Definitions ────────────────────────────────────────────────────

export type ModelProvider = 'copilot' | 'openai' | 'anthropic' | 'google';

export interface ModelDefinition {
  id: string;
  provider: ModelProvider;
  displayName: string;
  /** Cost per 1K input tokens in USD */
  costPer1KInput: number;
  /** Cost per 1K output tokens in USD */
  costPer1KOutput: number;
  /** Rough context window in tokens */
  contextWindow: number;
  /** Best suited task types */
  strengths: TaskType[];
}

export const MODEL_REGISTRY: Record<string, ModelDefinition> = {
  'copilot': {
    id: 'copilot',
    provider: 'copilot',
    displayName: 'GitHub Copilot',
    costPer1KInput: 0,
    costPer1KOutput: 0,
    contextWindow: 128000,
    strengths: ['codegen', 'explain', 'general'],
  },
  'gpt-4o': {
    id: 'gpt-4o',
    provider: 'openai',
    displayName: 'GPT-4o',
    costPer1KInput: 0.005,
    costPer1KOutput: 0.015,
    contextWindow: 128000,
    strengths: ['debug', 'architect', 'test'],
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    provider: 'openai',
    displayName: 'GPT-4o Mini',
    costPer1KInput: 0.00015,
    costPer1KOutput: 0.0006,
    contextWindow: 128000,
    strengths: ['codegen', 'explain', 'general'],
  },
  'claude-sonnet-4-20250514': {
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 4',
    costPer1KInput: 0.003,
    costPer1KOutput: 0.015,
    contextWindow: 200000,
    strengths: ['debug', 'architect', 'test', 'explain'],
  },
  'claude-3-5-haiku-latest': {
    id: 'claude-3-5-haiku-latest',
    provider: 'anthropic',
    displayName: 'Claude 3.5 Haiku',
    costPer1KInput: 0.00025,
    costPer1KOutput: 0.00125,
    contextWindow: 200000,
    strengths: ['codegen', 'explain', 'general'],
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    provider: 'google',
    displayName: 'Gemini 2.5 Flash',
    costPer1KInput: 0.000075,
    costPer1KOutput: 0.0003,
    contextWindow: 1000000,
    strengths: ['codegen', 'explain', 'general'],
  },
};

export const MODEL_ID_ALIASES: Record<string, string> = {
  // Backward compatibility for existing user settings.
  'claude-haiku-4-5': 'claude-3-5-haiku-latest',
  'gemini-1.5-flash': 'gemini-2.5-flash',
  gemini: 'gemini-2.5-flash',
};

// ─── Routing ──────────────────────────────────────────────────────────────

export interface RoutingDecision {
  modelId: string;
  model: ModelDefinition;
  taskType: TaskType;
  reason: string;
  fallbackChain: string[];
}

// ─── Usage Tracking ───────────────────────────────────────────────────────

export interface ModelUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUSD: number;
  requestCount: number;
  lastUsed: number; // timestamp
}

export interface DailyUsage {
  date: string; // YYYY-MM-DD
  totalCostUSD: number;
  byModel: Record<string, ModelUsage>;
}

// ─── API Response ─────────────────────────────────────────────────────────

export interface ModelResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  modelId: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  modelId: string;
  timestamp: number;
}
