import * as vscode from 'vscode';
import { classifyTask } from './classifier/classifier';
import { ModelRouter } from './router/modelRouter';
import { callOpenAI, callAnthropic, callGoogle } from './router/apiClients';
import { UsageTracker } from './tracker/usageTracker';
import { StatusBarManager } from './ui/statusBar';
import { showDashboard } from './ui/dashboard';
import { ModelResponse, MODEL_REGISTRY } from './types';
import { getEditorContext } from './context/editorContext';
import { ConversationManager, ProviderMessage } from './context/conversationManager';
import { estimateTokens } from './utils/tokenEstimator';
import { ApiKeyManager } from './security/apiKeyManager';

let manualOverrideModelId: string | null = null;

function getSessionId(request: vscode.ChatRequest, chatContext: vscode.ChatContext): string {
  const requestAsAny = request as unknown as Record<string, unknown>;
  const chatContextAsAny = chatContext as unknown as Record<string, unknown>;

  const fromRequest = requestAsAny.sessionId;
  if (typeof fromRequest === 'string' && fromRequest.length > 0) {
    return fromRequest;
  }

  const fromContext = chatContextAsAny.sessionId;
  if (typeof fromContext === 'string' && fromContext.length > 0) {
    return fromContext;
  }

  const token = requestAsAny.toolInvocationToken;
  if (token && typeof token === 'object') {
    const maybeToken = token as Record<string, unknown>;
    const tokenSessionId = maybeToken.sessionId;
    if (typeof tokenSessionId === 'string' && tokenSessionId.length > 0) {
      return tokenSessionId;
    }
  }

  const firstTurn = chatContext.history.find(
    (turn) => turn instanceof vscode.ChatRequestTurn
  ) as vscode.ChatRequestTurn | undefined;

  if (firstTurn?.prompt) {
    return `${firstTurn.participant}:${firstTurn.prompt}`;
  }

  return `prompt:${request.prompt}`;
}

// --- Activation ----------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  console.log('[SmartRouter] Activating...');

  // Core services
  const tracker = new UsageTracker(context.globalState);
  const router = new ModelRouter(tracker);
  const conversation = new ConversationManager();
  const apiKeyManager = new ApiKeyManager(context.secrets);
  const statusBar = new StatusBarManager(tracker, context);
  statusBar.setIdle();

  // -- Chat Participant ----------------------------------------------------------

  const participant = vscode.chat.createChatParticipant(
    'smart-model-router.router',
    async (
      request: vscode.ChatRequest,
      chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ) => {
      const userPrompt = request.prompt.trim();
      if (!userPrompt) {
        stream.markdown('Please enter a prompt for me to route.');
        return;
      }

      const config = vscode.workspace.getConfiguration('smartRouter');
      const sessionId = getSessionId(request, chatContext);
      const historyLength = Math.max(0, config.get<number>('conversationHistoryLength', 6));
      const injectEditorContext = config.get<boolean>('injectEditorContext', true);
      const classifierMode = config.get<'heuristic' | 'llm'>('classifierMode', 'heuristic');
      const openaiApiKey = await apiKeyManager.getKey('openai');
      const anthropicApiKey = await apiKeyManager.getKey('anthropic');
      const googleApiKey = await apiKeyManager.getKey('google');

      const editorContext = injectEditorContext ? getEditorContext() : '';
      const enrichedPrompt = injectEditorContext
        ? `${editorContext}\n\n${userPrompt}`
        : userPrompt;

      // 1. Classify the task
      const classification = await classifyTask(userPrompt, {
        mode: classifierMode,
        openaiApiKey,
      });
      const systemPrompt = router.buildSystemPrompt(classification.taskType);

      // 2. Resolve the best model with token preflight checks
      const preflightHistory = conversation.getRecentMessages(sessionId, historyLength);
      const preflightPayload = [
        systemPrompt,
        ...preflightHistory.map((message) => message.content),
        enrichedPrompt,
      ].join('\n\n');
      const estimatedPromptTokens = estimateTokens(preflightPayload);

      const overrideAtRequestStart = manualOverrideModelId;
      const decision = router.resolve(
        classification.taskType,
        estimatedPromptTokens,
        overrideAtRequestStart ?? undefined,
        {
          openai: !!openaiApiKey,
          anthropic: !!anthropicApiKey,
          google: !!googleApiKey,
          copilot: true,
        }
      );

      const history = conversation.getMessagesForModel(
        sessionId,
        decision.modelId,
        systemPrompt,
        enrichedPrompt,
        historyLength
      );

      // 3. Show routing info
      stream.markdown(
        `> 🔀 **${decision.model.displayName}** selected for \`${decision.taskType}\` task\n` +
        `> _(${decision.reason} · ${classification.reasoning} · confidence: ${Math.round(classification.confidence * 100)}%)_\n\n`
      );

      statusBar.update(decision.modelId, true);

      // 4. Handle cancellation
      if (token.isCancellationRequested) {
        return;
      }

      try {
        let response: ModelResponse;

        // 5. Dispatch to the right API
        if (decision.model.provider === 'copilot') {
          response = await handleCopilot(decision.modelId, systemPrompt, enrichedPrompt, history, stream, token);
        } else {
          response = await handleExternalAPI(
            decision,
            systemPrompt,
            enrichedPrompt,
            history,
            stream,
            token,
            { openaiApiKey, anthropicApiKey, googleApiKey }
          );
        }

        // 6. Record usage
        await tracker.record(decision.modelId, response.inputTokens, response.outputTokens);

        // 7. Keep per-session conversation history
        conversation.appendUserMessage(sessionId, userPrompt, decision.modelId);
        conversation.appendAssistantMessage(sessionId, response.content, decision.modelId);

        // 8. Show cost footnote for paid models
        if (decision.model.provider !== 'copilot') {
          const cost =
            (response.inputTokens / 1000) * decision.model.costPer1KInput +
            (response.outputTokens / 1000) * decision.model.costPer1KOutput;
          stream.markdown(
            `\n\n---\n*${response.inputTokens} in / ${response.outputTokens} out tokens · ` +
            `est. $${cost.toFixed(5)} · daily total: $${tracker.getUsage().totalCostUSD.toFixed(4)}*`
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        stream.markdown(`\n\n❌ **Error:** ${message}`);
        vscode.window.showErrorMessage(`Smart Router: ${message}`);
      } finally {
        // Manual override only applies to the next request.
        if (overrideAtRequestStart) {
          manualOverrideModelId = null;
          statusBar.setManualOverride(null);
        }

        statusBar.update(decision.modelId, false);
      }
    }
  );

  // Set participant icon
  participant.iconPath = new vscode.ThemeIcon('rocket');
  context.subscriptions.push(participant);

  // -- Commands -----------------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand('smartRouter.showDashboard', () => {
      showDashboard(context, tracker);
    }),

    vscode.commands.registerCommand('smartRouter.resetUsage', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Reset all Smart Router usage stats?',
        { modal: true },
        'Reset'
      );
      if (confirm === 'Reset') {
        await tracker.reset();
        statusBar.setIdle();
        vscode.window.showInformationMessage('Smart Router: Usage stats reset.');
      }
    }),

    vscode.commands.registerCommand('smartRouter.configureModels', () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'smartRouter'
      );
    }),

    vscode.commands.registerCommand('smartRouter.configureApiKeys', async () => {
      const provider = await vscode.window.showQuickPick(
        [
          { label: 'OpenAI', value: 'openai' as const },
          { label: 'Anthropic', value: 'anthropic' as const },
          { label: 'Google AI', value: 'google' as const },
        ],
        { placeHolder: 'Choose provider key to set in VS Code Secret Storage' }
      );

      if (!provider) {
        return;
      }

      const current = await apiKeyManager.getKey(provider.value);
      const value = await vscode.window.showInputBox({
        prompt: `Enter ${provider.label} API key`,
        password: true,
        ignoreFocusOut: true,
        value: current,
      });

      if (value === undefined) {
        return;
      }

      await apiKeyManager.setKey(provider.value, value);
      vscode.window.showInformationMessage(
        `Smart Router: ${provider.label} API key ${value.trim() ? 'saved' : 'cleared'} securely.`
      );
    }),

    vscode.commands.registerCommand('smartRouter.overrideModel', async () => {
      const models = Object.values(MODEL_REGISTRY);
      const quickPickItems: vscode.QuickPickItem[] = models.map((model) => {
        const remaining = tracker.getRemainingBudget(model.id);
        const budgetText = Number.isFinite(remaining)
          ? `$${remaining.toFixed(3)} remaining`
          : 'no cap';
        const costText = model.provider === 'copilot'
          ? 'free'
          : `$${model.costPer1KInput.toFixed(6)}/1K in · $${model.costPer1KOutput.toFixed(6)}/1K out`;

        return {
          label: model.displayName,
          description: `${model.provider}`,
          detail: `${costText} · ${budgetText}`,
        };
      });

      const picked = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: 'Choose a model to use for the next @router request',
      });

      if (!picked) {
        return;
      }

      const selectedModel = models.find((model) => model.displayName === picked.label);
      if (!selectedModel) {
        return;
      }

      manualOverrideModelId = selectedModel.id;
      statusBar.setManualOverride(manualOverrideModelId);
      vscode.window.showInformationMessage(
        `Smart Router: next request will use ${selectedModel.displayName}.`
      );
    })
  );

  console.log('[SmartRouter] Ready.');
}

// --- Copilot Handler -------------------------------------------------------------

async function handleCopilot(
  _modelId: string,
  systemPrompt: string,
  userPrompt: string,
  history: ProviderMessage[],
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<ModelResponse> {
  // Use VS Code's native Language Model API
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (!models.length) {
    throw new Error('No Copilot model available. Make sure GitHub Copilot is installed and signed in.');
  }

  const model = models[0];
  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(`System instructions:\n${systemPrompt}`),
    ...history.map((message) =>
      message.role === 'assistant'
        ? vscode.LanguageModelChatMessage.Assistant(message.content)
        : vscode.LanguageModelChatMessage.User(message.content)
    ),
    vscode.LanguageModelChatMessage.User(userPrompt),
  ];

  const chatResponse = await model.sendRequest(messages, {}, token);
  let fullText = '';
  let outputTokens = 0;

  for await (const chunk of chatResponse.text as AsyncIterable<string>) {
    if (token.isCancellationRequested) {
      break;
    }

    stream.markdown(chunk);
    fullText += chunk;
    outputTokens += Math.ceil(chunk.length / 4); // rough estimate
  }

  return {
    content: fullText,
    inputTokens: estimateTokens(
      [systemPrompt, ...history.map((message) => message.content), userPrompt].join('\n\n')
    ),
    outputTokens,
    modelId: 'copilot',
  };
}

// --- External API Handler --------------------------------------------------------

async function handleExternalAPI(
  decision: Awaited<ReturnType<ModelRouter['resolve']>>,
  systemPrompt: string,
  userPrompt: string,
  history: ProviderMessage[],
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  keys: {
    openaiApiKey: string;
    anthropicApiKey: string;
    googleApiKey: string;
  }
): Promise<ModelResponse> {
  const onChunk = (chunk: string) => {
    if (!token.isCancellationRequested) {
      stream.markdown(chunk);
    }
  };

  switch (decision.model.provider) {
    case 'openai': {
      return callOpenAI(decision.modelId, systemPrompt, userPrompt, history, keys.openaiApiKey, onChunk);
    }
    case 'anthropic': {
      return callAnthropic(
        decision.modelId,
        systemPrompt,
        userPrompt,
        history,
        keys.anthropicApiKey,
        onChunk
      );
    }
    case 'google': {
      return callGoogle(decision.modelId, systemPrompt, userPrompt, history, keys.googleApiKey, onChunk);
    }
    default:
      throw new Error(`Unknown provider: ${decision.model.provider}`);
  }
}

export function deactivate() {}
