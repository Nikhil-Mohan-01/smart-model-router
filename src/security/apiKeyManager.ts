import * as vscode from 'vscode';

type ProviderId = 'openai' | 'anthropic' | 'google';

const SECRET_KEYS: Record<ProviderId, string> = {
  openai: 'smartRouter.openaiApiKey',
  anthropic: 'smartRouter.anthropicApiKey',
  google: 'smartRouter.googleApiKey',
};

export class ApiKeyManager {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getKey(provider: ProviderId): Promise<string> {
    const key = await this.secrets.get(SECRET_KEYS[provider]);
    return (key ?? '').trim();
  }

  async hasKey(provider: ProviderId): Promise<boolean> {
    return (await this.getKey(provider)).length > 0;
  }

  async setKey(provider: ProviderId, value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) {
      await this.secrets.delete(SECRET_KEYS[provider]);
      return;
    }
    await this.secrets.store(SECRET_KEYS[provider], trimmed);
  }

  async clearKey(provider: ProviderId): Promise<void> {
    await this.secrets.delete(SECRET_KEYS[provider]);
  }
}
