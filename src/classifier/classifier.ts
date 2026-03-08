import * as vscode from 'vscode';
import { TaskType, ClassificationResult } from '../types';

// ─── Keyword Heuristics ───────────────────────────────────────────────────

const TASK_KEYWORDS: Record<TaskType, string[]> = {
  debug: [
    'bug', 'error', 'fix', 'broken', 'crash', 'exception', 'undefined',
    'null', 'fails', 'failing', 'wrong output', 'not working', 'issue',
    'trace', 'stack trace', 'debug', 'why is', "why isn't", 'diagnose',
  ],
  codegen: [
    'write', 'create', 'generate', 'implement', 'build', 'make', 'add',
    'new function', 'new class', 'scaffold', 'boilerplate', 'template',
    'code for', 'function that', 'class that',
  ],
  architect: [
    'design', 'architecture', 'structure', 'pattern', 'system', 'scalable',
    'how should', 'best way to', 'approach', 'strategy', 'organize',
    'folder structure', 'schema', 'database design', 'api design',
  ],
  explain: [
    'explain', 'what is', 'how does', 'what does', 'describe', 'clarify',
    'understand', 'meaning of', 'tell me about', 'walk me through',
    'document', 'comment', 'summarize',
  ],
  test: [
    'test', 'tests', 'unit test', 'integration test', 'spec', 'jest',
    'mocha', 'vitest', 'coverage', 'mock', 'stub', 'assert', 'expect',
    'test case', 'test suite',
  ],
  general: [],
};

function heuristicClassify(prompt: string): ClassificationResult {
  const lower = prompt.toLowerCase();
  const scores: Record<TaskType, number> = {
    debug: 0, codegen: 0, architect: 0, explain: 0, test: 0, general: 0,
  };

  for (const [task, keywords] of Object.entries(TASK_KEYWORDS) as [TaskType, string[]][]) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        scores[task] += 1;
      }
    }
  }

  const sorted = (Object.entries(scores) as [TaskType, number][])
    .sort(([, a], [, b]) => b - a);

  const [topTask, topScore] = sorted[0];
  const totalHits = Object.values(scores).reduce((a, b) => a + b, 0);

  if (topScore === 0 || totalHits === 0) {
    return { taskType: 'general', confidence: 0.5, reasoning: 'No strong keyword matches' };
  }

  const confidence = Math.min(0.95, topScore / (totalHits + 1));

  return {
    taskType: topTask,
    confidence,
    reasoning: `Keyword match: "${topTask}" scored ${topScore} hits`,
  };
}

// ─── LLM Classifier ──────────────────────────────────────────────────────

async function llmClassify(
  prompt: string,
  apiKey: string
): Promise<ClassificationResult> {
  const systemPrompt = `You are a task classifier for a VS Code AI routing extension.
Classify the user's prompt into exactly ONE of these categories:
- debug: fixing bugs, errors, crashes, diagnosing issues
- codegen: writing new code, implementing features, creating files
- architect: system design, patterns, structuring projects
- explain: explaining code, concepts, documentation
- test: writing tests, test coverage, mocking
- general: anything that doesn't clearly fit above

Respond ONLY with valid JSON, no markdown:
{"taskType": "<category>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini', // cheap classifier call
      max_tokens: 100,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt.slice(0, 500) }, // cap for cost
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM classify failed: ${res.status}`);
  }

  const data = await res.json() as any;
  const text = data.choices?.[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

  return {
    taskType: parsed.taskType as TaskType,
    confidence: parsed.confidence ?? 0.7,
    reasoning: parsed.reasoning ?? '',
  };
}

// ─── Exported Classifier ─────────────────────────────────────────────────

export async function classifyTask(prompt: string): Promise<ClassificationResult> {
  const config = vscode.workspace.getConfiguration('smartRouter');
  const mode = config.get<string>('classifierMode', 'heuristic');

  if (mode === 'llm') {
    const apiKey = config.get<string>('openaiApiKey', '');
    if (apiKey) {
      try {
        return await llmClassify(prompt, apiKey);
      } catch (err) {
        console.warn('[SmartRouter] LLM classify failed, falling back to heuristic:', err);
      }
    }
  }

  return heuristicClassify(prompt);
}
