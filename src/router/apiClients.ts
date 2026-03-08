import { ModelResponse } from '../types';
import { ProviderMessage } from '../context/conversationManager';

// ─── Shared streaming helper ──────────────────────────────────────────────

async function streamText(
  res: Response,
  onChunk: (chunk: string) => void,
  extractChunk: (line: string) => string | null
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) { return; }
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) { break; }

    const text = decoder.decode(value);
    for (const line of text.split('\n')) {
      const chunk = extractChunk(line.trim());
      if (chunk) { onChunk(chunk); }
    }
  }
}

// ─── OpenAI ───────────────────────────────────────────────────────────────

export async function callOpenAI(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  history: ProviderMessage[],
  apiKey: string,
  onChunk: (chunk: string) => void
): Promise<ModelResponse> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.map((message) => ({ role: message.role, content: message.content })),
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${err}`);
  }

  let fullContent = '';
  let inputTokens = 0;
  let outputTokens = 0;

  await streamText(res, (chunk) => {
    fullContent += chunk;
    onChunk(chunk);
  }, (line) => {
    if (!line.startsWith('data: ')) { return null; }
    const json = line.slice(6);
    if (json === '[DONE]') { return null; }

    try {
      const parsed = JSON.parse(json);
      // Capture token usage from the final chunk
      if (parsed.usage) {
        inputTokens = parsed.usage.prompt_tokens ?? 0;
        outputTokens = parsed.usage.completion_tokens ?? 0;
      }
      return parsed.choices?.[0]?.delta?.content ?? null;
    } catch {
      return null;
    }
  });

  return { content: fullContent, inputTokens, outputTokens, modelId };
}

// ─── Anthropic ────────────────────────────────────────────────────────────

export async function callAnthropic(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  history: ProviderMessage[],
  apiKey: string,
  onChunk: (chunk: string) => void
): Promise<ModelResponse> {
  const messagesWithCurrent: ProviderMessage[] = [
    ...history,
    { role: 'user', content: userPrompt },
  ];

  const mergedMessages: ProviderMessage[] = messagesWithCurrent.reduce<ProviderMessage[]>((acc, current) => {
      const previous = acc[acc.length - 1];
      if (previous && previous.role === current.role) {
        previous.content += `\n\n${current.content}`;
        return acc;
      }
      acc.push({ ...current });
      return acc;
    }, []);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4096,
      stream: true,
      system: systemPrompt,
      messages: mergedMessages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic error ${res.status}: ${err}`);
  }

  let fullContent = '';
  let inputTokens = 0;
  let outputTokens = 0;

  await streamText(res, (chunk) => {
    fullContent += chunk;
    onChunk(chunk);
  }, (line) => {
    if (!line.startsWith('data: ')) { return null; }
    const json = line.slice(6);

    try {
      const parsed = JSON.parse(json);
      if (parsed.type === 'message_start') {
        inputTokens = parsed.message?.usage?.input_tokens ?? 0;
      }
      if (parsed.type === 'message_delta') {
        outputTokens = parsed.usage?.output_tokens ?? 0;
      }
      if (parsed.type === 'content_block_delta') {
        return parsed.delta?.text ?? null;
      }
      return null;
    } catch {
      return null;
    }
  });

  return { content: fullContent, inputTokens, outputTokens, modelId };
}

// ─── Google Gemini ────────────────────────────────────────────────────────

export async function callGoogle(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  history: ProviderMessage[],
  apiKey: string,
  onChunk: (chunk: string) => void
): Promise<ModelResponse> {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?key=${apiKey}&alt=sse`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [
        ...history.map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        })),
        { role: 'user', parts: [{ text: userPrompt }] },
      ],
      generationConfig: { maxOutputTokens: 4096 },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google error ${res.status}: ${err}`);
  }

  let fullContent = '';
  let inputTokens = 0;
  let outputTokens = 0;

  await streamText(res, (chunk) => {
    fullContent += chunk;
    onChunk(chunk);
  }, (line) => {
    if (!line.startsWith('data: ')) { return null; }
    try {
      const parsed = JSON.parse(line.slice(6));
      const meta = parsed.usageMetadata;
      if (meta) {
        inputTokens = meta.promptTokenCount ?? 0;
        outputTokens = meta.candidatesTokenCount ?? 0;
      }
      return parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    } catch {
      return null;
    }
  });

  return { content: fullContent, inputTokens, outputTokens, modelId };
}
