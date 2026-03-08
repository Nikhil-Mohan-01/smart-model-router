import * as vscode from 'vscode';
import { DailyUsage, ModelUsage, MODEL_REGISTRY } from '../types';

const STORAGE_KEY = 'smartRouter.dailyUsage';

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export class UsageTracker {
  constructor(private readonly storage: vscode.Memento) {}

  private load(): DailyUsage {
    const today = todayKey();
    const stored = this.storage.get<DailyUsage>(STORAGE_KEY);

    // Reset if it's a new day
    if (!stored || stored.date !== today) {
      return { date: today, totalCostUSD: 0, byModel: {} };
    }
    return stored;
  }

  private async save(usage: DailyUsage): Promise<void> {
    await this.storage.update(STORAGE_KEY, usage);
  }

  /** Record a completed model call */
  async record(modelId: string, inputTokens: number, outputTokens: number): Promise<void> {
    const usage = this.load();
    const model = MODEL_REGISTRY[modelId];

    if (!model || model.provider === 'copilot') {
      return; // Don't track free Copilot usage
    }

    const cost =
      (inputTokens / 1000) * model.costPer1KInput +
      (outputTokens / 1000) * model.costPer1KOutput;

    const existing: ModelUsage = usage.byModel[modelId] ?? {
      modelId,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUSD: 0,
      requestCount: 0,
      lastUsed: 0,
    };

    usage.byModel[modelId] = {
      ...existing,
      inputTokens: existing.inputTokens + inputTokens,
      outputTokens: existing.outputTokens + outputTokens,
      estimatedCostUSD: existing.estimatedCostUSD + cost,
      requestCount: existing.requestCount + 1,
      lastUsed: Date.now(),
    };

    usage.totalCostUSD += cost;
    await this.save(usage);
  }

  /** Check if a model is within its budget */
  isWithinBudget(modelId: string): boolean {
    const config = vscode.workspace.getConfiguration('smartRouter');
    const budgets = config.get<Record<string, number>>('modelBudgets', {});
    const dailyCap = config.get<number>('dailyBudgetUSD', 2.0);

    const usage = this.load();

    // Check global daily cap
    if (usage.totalCostUSD >= dailyCap) {
      return false;
    }

    // Check per-model cap
    const modelCap = budgets[modelId];
    if (modelCap !== undefined) {
      const modelUsage = usage.byModel[modelId]?.estimatedCostUSD ?? 0;
      if (modelUsage >= modelCap) {
        return false;
      }
    }

    return true;
  }

  /** Get current usage snapshot */
  getUsage(): DailyUsage {
    return this.load();
  }

  /** Get remaining budget for a model (USD) */
  getRemainingBudget(modelId: string): number {
    const config = vscode.workspace.getConfiguration('smartRouter');
    const budgets = config.get<Record<string, number>>('modelBudgets', {});
    const usage = this.load();

    const modelCap = budgets[modelId] ?? Infinity;
    const modelSpent = usage.byModel[modelId]?.estimatedCostUSD ?? 0;

    return Math.max(0, modelCap - modelSpent);
  }

  /** Reset all usage stats */
  async reset(): Promise<void> {
    await this.storage.update(STORAGE_KEY, undefined);
  }

  /** Format usage for display */
  getSummaryText(): string {
    const usage = this.load();
    const lines: string[] = [
      `📅 ${usage.date}  |  Total: $${usage.totalCostUSD.toFixed(4)}`,
      '',
    ];

    for (const [modelId, mu] of Object.entries(usage.byModel)) {
      const model = MODEL_REGISTRY[modelId];
      const name = model?.displayName ?? modelId;
      lines.push(
        `  ${name}: $${mu.estimatedCostUSD.toFixed(4)}  (${mu.requestCount} reqs, ` +
        `${mu.inputTokens + mu.outputTokens} tokens)`
      );
    }

    return lines.join('\n');
  }
}
