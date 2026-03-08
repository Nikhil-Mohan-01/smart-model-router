import * as vscode from 'vscode';
import { UsageTracker } from '../tracker/usageTracker';
import { MODEL_REGISTRY } from '../types';

export function showDashboard(
  context: vscode.ExtensionContext,
  tracker: UsageTracker
): void {
  const panel = vscode.window.createWebviewPanel(
    'smartRouterDashboard',
    'Smart Router — Usage Dashboard',
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );

  panel.webview.html = buildHtml(tracker);

  // Handle reset button message
  panel.webview.onDidReceiveMessage(
    async (msg) => {
      if (msg.command === 'reset') {
        await tracker.reset();
        panel.webview.html = buildHtml(tracker);
        vscode.window.showInformationMessage('Smart Router: Usage stats reset.');
      }
    },
    undefined,
    context.subscriptions
  );
}

function buildHtml(tracker: UsageTracker): string {
  const usage = tracker.getUsage();
  const config = vscode.workspace.getConfiguration('smartRouter');
  const cap = config.get<number>('dailyBudgetUSD', 2.0);
  const budgets = config.get<Record<string, number>>('modelBudgets', {});

  const rows = Object.entries(usage.byModel).map(([modelId, mu]) => {
    const model = MODEL_REGISTRY[modelId];
    const name = model?.displayName ?? modelId;
    const modelCap = budgets[modelId] ?? cap;
    const pct = Math.min(100, Math.round((mu.estimatedCostUSD / modelCap) * 100));
    const barColor = pct >= 90 ? '#f44747' : pct >= 70 ? '#cca700' : '#4ec9b0';

    return `
      <tr>
        <td>${name}</td>
        <td>${mu.requestCount}</td>
        <td>${(mu.inputTokens + mu.outputTokens).toLocaleString()}</td>
        <td>$${mu.estimatedCostUSD.toFixed(5)}</td>
        <td>
          <div class="bar-bg">
            <div class="bar-fill" style="width:${pct}%;background:${barColor}"></div>
          </div>
          <span class="pct">${pct}%</span>
        </td>
      </tr>`;
  }).join('');

  const globalPct = Math.min(100, Math.round((usage.totalCostUSD / cap) * 100));

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); }
  h1 { font-size: 1.2em; margin-bottom: 4px; }
  .subtitle { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 20px; }
  .summary-card {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-radius: 6px; padding: 14px 18px; margin-bottom: 20px;
    display: flex; gap: 40px; align-items: center;
  }
  .big-num { font-size: 2em; font-weight: 700; }
  .label { font-size: 0.78em; color: var(--vscode-descriptionForeground); }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border);
       font-size: 0.82em; color: var(--vscode-descriptionForeground); }
  td { padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.9em; }
  .bar-bg { background: var(--vscode-scrollbarSlider-background); border-radius: 4px;
             height: 8px; width: 120px; display: inline-block; vertical-align: middle; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .pct { font-size: 0.78em; color: var(--vscode-descriptionForeground); margin-left: 6px; }
  button { margin-top: 24px; padding: 6px 16px; background: var(--vscode-button-background);
           color: var(--vscode-button-foreground); border: none; border-radius: 4px;
           cursor: pointer; font-size: 0.9em; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 20px 0; }
</style>
</head>
<body>
<h1>⚡ Smart Model Router</h1>
<p class="subtitle">Usage for ${usage.date}</p>

<div class="summary-card">
  <div>
    <div class="big-num">$${usage.totalCostUSD.toFixed(4)}</div>
    <div class="label">Total spent today</div>
  </div>
  <div>
    <div class="big-num">${globalPct}%</div>
    <div class="label">of $${cap.toFixed(2)} daily budget</div>
  </div>
  <div>
    <div class="big-num">${Object.values(usage.byModel).reduce((a, m) => a + m.requestCount, 0)}</div>
    <div class="label">Total requests</div>
  </div>
</div>

<table>
  <thead>
    <tr>
      <th>Model</th><th>Requests</th><th>Tokens</th><th>Cost</th><th>Budget Used</th>
    </tr>
  </thead>
  <tbody>
    ${rows || '<tr><td colspan="5" class="empty">No usage recorded yet today.</td></tr>'}
  </tbody>
</table>

<button onclick="resetStats()">Reset Today's Stats</button>

<script>
  const vscode = acquireVsCodeApi();
  function resetStats() {
    if (confirm('Reset all usage stats for today?')) {
      vscode.postMessage({ command: 'reset' });
    }
  }
</script>
</body>
</html>`;
}
