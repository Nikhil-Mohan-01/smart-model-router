import * as vscode from 'vscode';
import { TaskType, RoutingDecision, MODEL_REGISTRY, MODEL_ID_ALIASES } from '../types';
import { UsageTracker } from '../tracker/usageTracker';

function normalizeModelId(modelId: string): string {
  return MODEL_ID_ALIASES[modelId] ?? modelId;
}

export class ModelRouter {
  constructor(private readonly tracker: UsageTracker) {}

  /**
   * Pick the best available model for a given task.
   * Works down the user's preference list, skipping models that are:
   *  - over budget
   *  - missing API keys
   */
  resolve(
    taskType: TaskType,
    estimatedTokens = 0,
    preferredModelId?: string,
    providerAvailability?: Partial<Record<'openai' | 'anthropic' | 'google' | 'copilot', boolean>>
  ): RoutingDecision {
    const config = vscode.workspace.getConfiguration('smartRouter');
    const preferences = config.get<Partial<Record<TaskType, string[]>>>('taskModelPreferences', {});
    const configuredChain = preferences[taskType] ?? preferences['general'] ?? ['copilot'];
    const chain = preferredModelId
      ? [preferredModelId, ...configuredChain.filter((modelId) => modelId !== preferredModelId)]
      : configuredChain;
    const normalizedChain = chain.map(normalizeModelId);

    const hasKey: Record<string, boolean> = {
      openai: providerAvailability?.openai ?? false,
      anthropic: providerAvailability?.anthropic ?? false,
      google: providerAvailability?.google ?? false,
      copilot: true, // always available if Copilot is installed
    };

    let chosenId: string | null = null;
    const skipped: string[] = [];

    for (const modelId of normalizedChain) {
      const model = MODEL_REGISTRY[modelId];
      if (!model) { skipped.push(`${modelId} (unknown)`); continue; }

      if (!hasKey[model.provider]) {
        skipped.push(`${model.displayName} (no API key)`);
        continue;
      }

      if (!this.tracker.isWithinBudget(modelId)) {
        const remaining = this.tracker.getRemainingBudget(modelId);
        skipped.push(`${model.displayName} (budget $${remaining.toFixed(4)} remaining)`);
        continue;
      }

      const threshold = Math.floor(model.contextWindow * 0.8);
      if (estimatedTokens > 0 && estimatedTokens > threshold) {
        skipped.push(
          `${model.displayName} (context too large: ${estimatedTokens} > ${threshold} tokens)`
        );
        continue;
      }

      chosenId = modelId;
      break;
    }

    // Hard fallback: always use Copilot
    if (!chosenId) {
      chosenId = 'copilot';
    }

    const model = MODEL_REGISTRY[chosenId];
    const skipReason = skipped.length
      ? `Skipped: ${skipped.join(', ')}. `
      : '';

    return {
      modelId: chosenId,
      model,
      taskType,
      reason: `${skipReason}Selected ${model.displayName} for task "${taskType}"`,
      fallbackChain: normalizedChain,
    };
  }

  /** Build the system prompt for a given task type */
  buildSystemPrompt(taskType: TaskType): string {
    const prompts: Record<TaskType, string> = {
      debug:
        'You are an expert debugger. Analyze the issue methodically: identify root cause, ' +
        'explain why it happens, then provide a fix with explanation. Show before/after code if relevant.',
      codegen:
        'You are an expert software engineer. Write clean, production-ready code. ' +
        'Follow best practices, add brief comments for non-obvious logic, handle edge cases.',
      architect:
        'You are a senior software architect. Provide thoughtful design recommendations. ' +
        'Consider scalability, maintainability, and tradeoffs. Use diagrams (ASCII) where helpful.',
      explain:
        'You are a patient technical educator. Explain clearly and concisely. ' +
        'Use analogies where helpful. Structure your explanation from simple to complex.',
      test:
        'You are a testing expert. Write comprehensive, maintainable tests. ' +
        'Cover happy paths, edge cases, and error cases. Follow the testing framework conventions.',
      general:
        'You are a helpful programming assistant. Be concise, accurate, and practical.',
    };

    return prompts[taskType] ?? prompts.general;
  }
}
