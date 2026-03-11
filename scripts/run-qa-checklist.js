#!/usr/bin/env node
/* eslint-disable no-console */

const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const Module = require('node:module');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outRoot = path.join(projectRoot, 'out');

function runCommand(cmd) {
  execSync(cmd, {
    cwd: projectRoot,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function clearOutCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(outRoot)) {
      delete require.cache[key];
    }
  }
}

function withMockedVscode(vscodeMock, fn) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') {
      return vscodeMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    clearOutCache();
    return fn();
  } finally {
    Module._load = originalLoad;
  }
}

function createMemento(initialValue) {
  const store = new Map();
  if (initialValue !== undefined) {
    store.set('smartRouter.dailyUsage', initialValue);
  }
  return {
    get(key) {
      return store.get(key);
    },
    async update(key, value) {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
    },
  };
}

function createDocument(content, languageId = 'python', fsPath = '/workspace/app.py') {
  const lines = content.split('\n');
  return {
    isClosed: false,
    isUntitled: false,
    uri: { fsPath },
    languageId,
    lineCount: lines.length,
    lineAt(line) {
      return { text: lines[line] ?? '' };
    },
    getText(range) {
      if (!range) {
        return content;
      }

      const startLine = range.start?.line ?? 0;
      const startChar = range.start?.character ?? 0;
      const endLine = range.end?.line ?? (lines.length - 1);
      const endChar = range.end?.character ?? (lines[endLine]?.length ?? 0);

      if (startLine === endLine) {
        return (lines[startLine] ?? '').slice(startChar, endChar);
      }

      const parts = [];
      parts.push((lines[startLine] ?? '').slice(startChar));
      for (let i = startLine + 1; i < endLine; i += 1) {
        parts.push(lines[i] ?? '');
      }
      parts.push((lines[endLine] ?? '').slice(0, endChar));
      return parts.join('\n');
    },
  };
}

function createVscodeMock({
  config = {},
  activeEditor = null,
  textDocuments = [],
} = {}) {
  class Range {
    constructor(startLine, startChar, endLine, endChar) {
      this.start = { line: startLine, character: startChar };
      this.end = { line: endLine, character: endChar };
    }
  }

  return {
    workspace: {
      textDocuments,
      getConfiguration() {
        return {
          get(key, defaultValue) {
            if (Object.prototype.hasOwnProperty.call(config, key)) {
              return config[key];
            }
            return defaultValue;
          },
        };
      },
    },
    window: {
      activeTextEditor: activeEditor,
    },
    Range,
  };
}

function createSseResponse(lines) {
  const text = `${lines.join('\n')}\n`;
  const bytes = Buffer.from(text, 'utf8');
  let done = false;
  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (done) {
              return { done: true, value: undefined };
            }
            done = true;
            return { done: false, value: bytes };
          },
        };
      },
    },
    async text() {
      return text;
    },
    status: 200,
  };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('Compile succeeds', () => {
  runCommand('npm run compile');
});

test('Router falls back to Copilot when keys are missing', () => {
  const mock = createVscodeMock({
    config: {
      taskModelPreferences: {
        explain: ['gpt-4o-mini', 'copilot'],
        general: ['copilot'],
      },
      openaiApiKey: '',
      anthropicApiKey: '',
      googleApiKey: '',
      modelBudgets: {},
      dailyBudgetUSD: 2,
    },
  });

  withMockedVscode(mock, () => {
    const { UsageTracker } = require(path.join(outRoot, 'tracker/usageTracker.js'));
    const { ModelRouter } = require(path.join(outRoot, 'router/modelRouter.js'));
    const tracker = new UsageTracker(createMemento());
    const router = new ModelRouter(tracker);
    const decision = router.resolve('explain', 0, undefined, {
      openai: false,
      anthropic: false,
      google: false,
      copilot: true,
    });
    assert.equal(decision.modelId, 'copilot');
    assert.match(decision.reason, /no API key/i);
  });
});

test('Router skips budget-exceeded model and falls back', () => {
  const today = new Date().toISOString().slice(0, 10);
  const mock = createVscodeMock({
    config: {
      taskModelPreferences: {
        codegen: ['gpt-4o-mini', 'copilot'],
        general: ['copilot'],
      },
      openaiApiKey: 'sk-test',
      anthropicApiKey: '',
      googleApiKey: '',
      modelBudgets: { 'gpt-4o-mini': 0.01 },
      dailyBudgetUSD: 2,
    },
  });

  withMockedVscode(mock, () => {
    const { UsageTracker } = require(path.join(outRoot, 'tracker/usageTracker.js'));
    const { ModelRouter } = require(path.join(outRoot, 'router/modelRouter.js'));
    const tracker = new UsageTracker(createMemento({
      date: today,
      totalCostUSD: 0.02,
      byModel: {
        'gpt-4o-mini': {
          modelId: 'gpt-4o-mini',
          inputTokens: 1000,
          outputTokens: 1000,
          estimatedCostUSD: 0.02,
          requestCount: 1,
          lastUsed: Date.now(),
        },
      },
    }));
    const router = new ModelRouter(tracker);
    const decision = router.resolve('codegen', 0, undefined, {
      openai: true,
      anthropic: false,
      google: false,
      copilot: true,
    });
    assert.equal(decision.modelId, 'copilot');
    assert.match(decision.reason, /budget/i);
  });
});

test('Context-window guard skips small-context model when prompt is too large', () => {
  const mock = createVscodeMock({
    config: {
      taskModelPreferences: {
        codegen: ['gpt-4o-mini', 'gemini-2.5-flash', 'copilot'],
        general: ['copilot'],
      },
      openaiApiKey: 'sk-test',
      anthropicApiKey: '',
      googleApiKey: 'g-test',
      modelBudgets: {},
      dailyBudgetUSD: 5,
    },
  });

  withMockedVscode(mock, () => {
    const { UsageTracker } = require(path.join(outRoot, 'tracker/usageTracker.js'));
    const { ModelRouter } = require(path.join(outRoot, 'router/modelRouter.js'));
    const tracker = new UsageTracker(createMemento());
    const router = new ModelRouter(tracker);
    const decision = router.resolve('codegen', 150000, undefined, {
      openai: true,
      anthropic: false,
      google: true,
      copilot: true,
    });
    assert.equal(decision.modelId, 'gemini-2.5-flash');
    assert.match(decision.reason, /context too large/i);
  });
});

test('Editor context includes expected XML fields and stays under token cap', () => {
  const longVisibleBlock = Array.from({ length: 300 }, (_, i) => `line_${i} = ${'x'.repeat(20)}`).join('\n');
  const mainDoc = createDocument(longVisibleBlock, 'python', '/workspace/main.py');
  const secondDoc = createDocument('print("helper")', 'python', '/workspace/helper.py');
  const activeEditor = {
    document: mainDoc,
    selection: {
      isEmpty: false,
      start: { line: 4, character: 0 },
      end: { line: 4, character: 15 },
      active: { line: 120, character: 0 },
    },
  };

  const mock = createVscodeMock({
    activeEditor,
    textDocuments: [mainDoc, secondDoc],
  });

  withMockedVscode(mock, () => {
    const { getEditorContext } = require(path.join(outRoot, 'context/editorContext.js'));
    const { estimateTokens } = require(path.join(outRoot, 'utils/tokenEstimator.js'));
    const xml = getEditorContext();
    assert.match(xml, /<context>/);
    assert.match(xml, /<file>\/workspace\/main\.py<\/file>/);
    assert.match(xml, /<language>python<\/language>/);
    assert.match(xml, /<selection>/);
    assert.match(xml, /<visible_code>/);
    assert.ok(estimateTokens(xml) <= 2000, `Context exceeded 2000 token cap: ${estimateTokens(xml)}`);
  });
});

test('Conversation manager keeps recent history and trims oversized context', () => {
  const { ConversationManager } = require(path.join(outRoot, 'context/conversationManager.js'));
  const manager = new ConversationManager();
  const session = 'session-a';

  for (let i = 0; i < 8; i += 1) {
    manager.appendUserMessage(session, `user_${i} ${'x'.repeat(50000)}`, 'gpt-4o-mini');
    manager.appendAssistantMessage(session, `assistant_${i} ${'y'.repeat(50000)}`, 'gpt-4o-mini');
  }

  const recent = manager.getRecentMessages(session, 6);
  assert.equal(recent.length, 6);
  const guarded = manager.getMessagesForModel(
    session,
    'gpt-4o-mini',
    'system prompt',
    'current user prompt',
    16
  );
  assert.ok(guarded.length < 16);
});

test('OpenAI client includes history and parses usage', async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return createSseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":11,"completion_tokens":7}}',
      'data: [DONE]',
    ]);
  };

  try {
    const { callOpenAI } = require(path.join(outRoot, 'router/apiClients.js'));
    const chunks = [];
    const response = await callOpenAI(
      'gpt-4o-mini',
      'sys',
      'latest',
      [{ role: 'assistant', content: 'prev' }],
      'sk-test',
      (chunk) => chunks.push(chunk)
    );

    assert.equal(capturedBody.messages.length, 3);
    assert.equal(capturedBody.messages[1].content, 'prev');
    assert.equal(response.inputTokens, 11);
    assert.equal(response.outputTokens, 7);
    assert.equal(chunks.join(''), 'Hello world');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Anthropic client enforces alternating message roles', async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return createSseResponse([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":22}}}',
      'data: {"type":"content_block_delta","delta":{"text":"Done"}}',
      'data: {"type":"message_delta","usage":{"output_tokens":5}}',
    ]);
  };

  try {
    const { callAnthropic } = require(path.join(outRoot, 'router/apiClients.js'));
    const response = await callAnthropic(
      'claude-sonnet-4-20250514',
      'sys',
      'current',
      [
        { role: 'user', content: 'u1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a1' },
      ],
      'ak-test',
      () => {}
    );

    assert.equal(capturedBody.messages[0].role, 'user');
    assert.equal(capturedBody.messages[0].content, 'u1\n\nu2');
    assert.equal(capturedBody.messages[1].role, 'assistant');
    assert.equal(capturedBody.messages[2].role, 'user');
    assert.equal(response.inputTokens, 22);
    assert.equal(response.outputTokens, 5);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Google client maps assistant history role to model role', async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return createSseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":4}}',
    ]);
  };

  try {
    const { callGoogle } = require(path.join(outRoot, 'router/apiClients.js'));
    const response = await callGoogle(
      'gemini-2.5-flash',
      'sys',
      'now',
      [{ role: 'assistant', content: 'previous answer' }],
      'gk-test',
      () => {}
    );

    assert.equal(capturedBody.contents[0].role, 'model');
    assert.equal(capturedBody.contents[1].role, 'user');
    assert.equal(response.inputTokens, 10);
    assert.equal(response.outputTokens, 4);
  } finally {
    global.fetch = originalFetch;
  }
});

test('VSIX packaging succeeds', () => {
  runCommand('npx @vscode/vsce package');
  const pkg = require(path.join(projectRoot, 'package.json'));
  const vsixPath = path.join(projectRoot, `smart-model-router-${pkg.version}.vsix`);
  assert.ok(require('node:fs').existsSync(vsixPath), 'Expected VSIX file to exist after packaging');
});

test('Model ID aliases normalize legacy settings IDs', () => {
  const mock = createVscodeMock({
    config: {
      taskModelPreferences: {
        explain: ['gemini', 'gemini-1.5-flash', 'claude-haiku-4-5', 'copilot'],
        general: ['copilot'],
      },
      modelBudgets: {},
      dailyBudgetUSD: 2,
    },
  });

  withMockedVscode(mock, () => {
    const { UsageTracker } = require(path.join(outRoot, 'tracker/usageTracker.js'));
    const { ModelRouter } = require(path.join(outRoot, 'router/modelRouter.js'));
    const tracker = new UsageTracker(createMemento());
    const router = new ModelRouter(tracker);
    const decision = router.resolve('explain', 0, undefined, {
      openai: false,
      anthropic: true,
      google: true,
      copilot: true,
    });
    assert.equal(decision.modelId, 'gemini-2.5-flash');
    assert.ok(decision.fallbackChain.includes('gemini-2.5-flash'));
  });
});

test('API key manager stores keys in secret storage', async () => {
  const memory = new Map();
  const secretStorage = {
    async get(key) {
      return memory.get(key);
    },
    async store(key, value) {
      memory.set(key, value);
    },
    async delete(key) {
      memory.delete(key);
    },
    onDidChange() {
      return { dispose() {} };
    },
  };

  const { ApiKeyManager } = require(path.join(outRoot, 'security/apiKeyManager.js'));
  const manager = new ApiKeyManager(secretStorage);
  await manager.setKey('openai', 'sk-secret');
  assert.equal(await manager.hasKey('openai'), true);
  assert.equal(await manager.getKey('openai'), 'sk-secret');
  await manager.clearKey('openai');
  assert.equal(await manager.getKey('openai'), '');
});

async function main() {
  let failures = 0;
  const startedAt = Date.now();
  console.log('Running Smart Model Router QA checklist...');

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`PASS ${t.name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${t.name}`);
      console.error(error && error.stack ? error.stack : String(error));
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`\nCompleted ${tests.length} checks in ${(elapsedMs / 1000).toFixed(1)}s`);

  if (failures > 0) {
    console.error(`QA checklist failed: ${failures} check(s) failed.`);
    process.exit(1);
  }

  console.log('QA checklist passed.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
