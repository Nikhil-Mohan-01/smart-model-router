import { ConversationMessage, MODEL_REGISTRY } from '../types';
import { estimateTokens } from '../utils/tokenEstimator';

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_STORED_MESSAGES = 100;

export class ConversationManager {
  private readonly sessions = new Map<string, ConversationMessage[]>();

  appendUserMessage(sessionId: string, content: string, modelId: string): void {
    this.append(sessionId, { role: 'user', content, modelId, timestamp: Date.now() });
  }

  appendAssistantMessage(sessionId: string, content: string, modelId: string): void {
    this.append(sessionId, { role: 'assistant', content, modelId, timestamp: Date.now() });
  }

  getRecentMessages(sessionId: string, limit: number): ProviderMessage[] {
    const messages = this.sessions.get(sessionId) ?? [];
    return messages.slice(-Math.max(0, limit)).map((message) => ({
      role: message.role,
      content: message.content,
    }));
  }

  getMessagesForModel(
    sessionId: string,
    modelId: string,
    systemPrompt: string,
    userPrompt: string,
    limit: number
  ): ProviderMessage[] {
    const model = MODEL_REGISTRY[modelId];
    const threshold = Math.floor(model.contextWindow * 0.8);
    const messages = this.getRecentMessages(sessionId, limit);

    while (messages.length > 0) {
      const payload = [
        systemPrompt,
        ...messages.map((message) => message.content),
        userPrompt,
      ].join('\n\n');

      if (estimateTokens(payload, modelId) <= threshold) {
        break;
      }

      messages.shift();
    }

    return messages;
  }

  private append(sessionId: string, message: ConversationMessage): void {
    const existing = this.sessions.get(sessionId) ?? [];
    existing.push(message);

    if (existing.length > MAX_STORED_MESSAGES) {
      existing.splice(0, existing.length - MAX_STORED_MESSAGES);
    }

    this.sessions.set(sessionId, existing);
  }
}
