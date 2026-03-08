# Smart Model Router — VS Code Extension

Automatically routes your AI queries to the **best model** based on task type,
cost, and daily budget limits. Works natively inside GitHub Copilot Chat.

---

## Features

-  **Auto-routing** — classifies your prompt and picks the right model
-  **Budget tracking** — tracks spend per model per day, falls back when limits hit
-  **Status bar** — shows current model + daily spend at a glance
-  **Dashboard** — visual usage breakdown by model
-  **Multi-provider** — Copilot (free), OpenAI, Anthropic, Google

---

## Usage

Open Copilot Chat and prefix your message with `@router`:

```
@router fix the null pointer in AuthService.ts
@router write a React hook for infinite scroll
@router design a caching layer for our API
@router explain what this regex does
@router write unit tests for UserRepository
```

The extension will:
1. Classify your task type
2. Pick the best available model within budget
3. Show which model was selected and why
4. Stream the response
5. Show token count + cost estimate

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Add API keys (secure storage)

Run command palette action `Smart Router: Configure API Keys (Secure)` and save keys in VS Code Secret Storage.

If a provider key is not set, that provider is automatically skipped during routing.

### 3. Configure budgets (optional)

```json
"smartRouter.dailyBudgetUSD": 2.0,
"smartRouter.modelBudgets": {
  "gpt-4o": 0.80,
  "claude-sonnet-4-20250514": 0.80,
  "gpt-4o-mini": 0.20,
  "claude-haiku-4-5": 0.20,
  "gemini-1.5-flash": 0.20
}
```

### 4. Customize model preferences per task (optional)

```json
"smartRouter.taskModelPreferences": {
  "debug":     ["claude-sonnet-4-20250514", "gpt-4o", "copilot"],
  "codegen":   ["gpt-4o-mini", "gemini-1.5-flash", "copilot"],
  "architect": ["claude-sonnet-4-20250514", "gpt-4o", "copilot"],
  "explain":   ["gpt-4o-mini", "copilot"],
  "test":      ["claude-sonnet-4-20250514", "gpt-4o", "copilot"],
  "general":   ["copilot", "gpt-4o-mini"]
}
```

The router works down this list and picks the first model that:
- Has an API key configured
- Is within its daily budget cap

---

## Commands

| Command | Description |
|---|---|
| `Smart Router: Show Usage Dashboard` | Open the visual usage dashboard |
| `Smart Router: Reset Usage Stats` | Reset today's spend counters |
| `Smart Router: Configure Models & Budgets` | Open settings |
| `Smart Router: Configure API Keys (Secure)` | Store provider keys in VS Code Secret Storage |

---

## Development

```bash
# Compile
npm run compile

# Watch mode
npm run watch

# Press F5 in VS Code to launch Extension Development Host
```

## Security Notes

- Provider API keys are read from VS Code Secret Storage at runtime.
- Usage data contains token/cost totals only; prompt text and API keys are not persisted by this extension.

---

## Project Structure

```
src/
  extension.ts          # Entry point, chat participant, command registration
  types.ts              # Shared types and model registry
  classifier/
    classifier.ts       # Task classification (heuristic + LLM modes)
  router/
    modelRouter.ts      # Model selection logic
    apiClients.ts       # OpenAI / Anthropic / Google streaming clients
  tracker/
    usageTracker.ts     # Daily usage and budget tracking
  ui/
    statusBar.ts        # Status bar item
    dashboard.ts        # Webview usage dashboard
```

---

## Routing Logic

```
User prompt
    │
    ▼
Classifier (heuristic keywords OR cheap gpt-4o-mini call)
    │
    ▼
TaskType: debug | codegen | architect | explain | test | general
    │
    ▼
For each model in preference list:
  ✓ API key present?
  ✓ Within daily budget?
  → First passing model wins
    │
    ▼
Stream response → record tokens → update status bar
```
