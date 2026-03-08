type OpenAiEncoder = {
  encode: (text: string) => unknown[] | Uint32Array;
};

let cachedEncoder: OpenAiEncoder | null | undefined;

function getOpenAiEncoder(): OpenAiEncoder | null {
  if (cachedEncoder !== undefined) {
    return cachedEncoder;
  }

  try {
    // Optional dependency: only used when available.
    const maybeModule = require('tiktoken-lite') as {
      encodingForModel?: (modelId: string) => OpenAiEncoder;
      getEncoding?: (name: string) => OpenAiEncoder;
    };

    if (typeof maybeModule.encodingForModel === 'function') {
      cachedEncoder = maybeModule.encodingForModel('gpt-4o-mini');
      return cachedEncoder;
    }

    if (typeof maybeModule.getEncoding === 'function') {
      cachedEncoder = maybeModule.getEncoding('cl100k_base');
      return cachedEncoder;
    }
  } catch {
    // Fall back to heuristic below.
  }

  cachedEncoder = null;
  return cachedEncoder;
}

export function estimateTokens(text: string, modelId?: string): number {
  if (!text) {
    return 0;
  }

  const useOpenAiEstimate = !!modelId && modelId.startsWith('gpt-');
  if (useOpenAiEstimate) {
    const encoder = getOpenAiEncoder();
    if (encoder) {
      try {
        return encoder.encode(text).length;
      } catch {
        // Fall back to heuristic below.
      }
    }
  }

  return Math.ceil(text.length / 4);
}
