import * as vscode from 'vscode';
import { UsageTracker } from '../tracker/usageTracker';
import { MODEL_REGISTRY } from '../types';

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;
  private manualOverrideModelId: string | null = null;

  constructor(
    private readonly tracker: UsageTracker,
    context: vscode.ExtensionContext
  ) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'smartRouter.showDashboard';
    this.item.tooltip = 'Smart Model Router — click for usage dashboard';
    context.subscriptions.push(this.item);

    const config = vscode.workspace.getConfiguration('smartRouter');
    if (config.get<boolean>('enableStatusBar', true)) {
      this.item.show();
    }
  }

  update(modelId: string, isLoading = false): void {
    const model = MODEL_REGISTRY[modelId];
    const usage = this.tracker.getUsage();
    const spent = usage.totalCostUSD;
    const config = vscode.workspace.getConfiguration('smartRouter');
    const cap = config.get<number>('dailyBudgetUSD', 2.0);
    const pct = Math.round((spent / cap) * 100);

    const name = model?.displayName ?? modelId;
    const spinner = isLoading ? '$(loading~spin) ' : '$(rocket) ';
    const overridePrefix = this.manualOverrideModelId
      ? `$(pinned) ${MODEL_REGISTRY[this.manualOverrideModelId]?.displayName ?? this.manualOverrideModelId} (manual) · `
      : '';

    this.item.text = `${spinner}${overridePrefix}${name} | $${spent.toFixed(3)} (${pct}%)`;

    // Colour-code budget usage
    if (pct >= 90) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (pct >= 70) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.backgroundColor = undefined;
    }
  }

  setIdle(): void {
    const usage = this.tracker.getUsage();
    const spent = usage.totalCostUSD;
    const overridePrefix = this.manualOverrideModelId
      ? `$(pinned) ${MODEL_REGISTRY[this.manualOverrideModelId]?.displayName ?? this.manualOverrideModelId} (manual) · `
      : '';
    this.item.text = `$(rocket) ${overridePrefix}Router | $${spent.toFixed(3)} today`;
    this.item.backgroundColor = undefined;
  }

  setManualOverride(modelId: string | null): void {
    this.manualOverrideModelId = modelId;
    this.setIdle();
  }
}
