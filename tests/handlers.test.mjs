// Runs the real handlers against a fake Anthropic client: no key, no network.
//
//   npm test
//
// Covers what the browser depends on: request validation, how frames and
// history become `messages`, the NDJSON stream, and the watcher's JSON.

import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
const { createLiveVisionHandlers, buildMessages } = await vite.ssrLoadModule('/src/server/index.ts');

const JPEG = '/9j/4AAQSkZJRgABAQ';
const post = (body) =>
  new Request('http://test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const calls = [];
function fakeClient({ deltas = ['Es una ', 'manzana roja.'], stop = 'end_turn', watch = '{"seen":true,"note":"mano arriba"}' } = {}) {
  return {
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'content_block_start', content_block: { type: 'thinking' } };
              for (const text of deltas) {
                yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
              }
            },
            finalMessage: async () => ({
              model: params.model,
              stop_reason: stop,
              usage: { input_tokens: 900, output_tokens: 12 },
            }),
          };
        },
      },
    },
    messages: {
      async create(params) {
        calls.push(params);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: watch }] };
      },
    },
  };
}

const events = async (response) =>
  (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

let passed = 0;
async function test(name, fn) {
  calls.length = 0;
  await fn();
  passed += 1;
  console.log(`ok  ${name}`);
}

try {
  await test('turn streams text deltas, then done with usage', async () => {
    const { turn } = createLiveVisionHandlers({ client: fakeClient() });
    const res = await turn(post({ history: [], text: '¿Qué es esto?', frames: [JPEG], locale: 'es' }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /ndjson/);
    assert.deepEqual(await events(res), [
      { type: 'text', delta: 'Es una ' },
      { type: 'text', delta: 'manzana roja.' },
      { type: 'done', model: 'claude-opus-5-5', inputTokens: 900, outputTokens: 12 },
    ]);
  });

  await test('the frame rides on the newest user turn, before the words', async () => {
    const { turn } = createLiveVisionHandlers({ client: fakeClient() });
    await (await turn(post({ history: [], text: 'What is this?', frames: [JPEG], locale: 'en' }))).text();
    const [params] = calls;
    assert.equal(params.output_config.effort, 'low');
    assert.equal(params.fallbacks, 'default');
    assert.equal(params.thinking, undefined);
    assert.deepEqual(params.messages, [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } },
          { type: 'text', text: 'What is this?' },
        ],
      },
    ]);
  });

  await test('history is text only, opens with the user and alternates', () => {
    const messages = buildMessages({
      history: [
        { role: 'agent', text: 'orphan greeting' },
        { role: 'user', text: 'first' },
        { role: 'agent', text: 'answer' },
        { role: 'user', text: 'interrupted question' },
      ],
      text: 'second',
      frames: [],
      locale: 'en',
    });
    assert.deepEqual(messages, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'interrupted question' },
          { type: 'text', text: 'second' },
        ],
      },
    ]);
  });

  await test('a refusal is reported, not passed off as an answer', async () => {
    const { turn } = createLiveVisionHandlers({ client: fakeClient({ deltas: [], stop: 'refusal' }) });
    const res = await turn(post({ text: 'x', frames: [], history: [], locale: 'en' }));
    assert.deepEqual(await events(res), [{ type: 'refusal' }]);
  });

  await test('invalid input is rejected before any model call', async () => {
    const { turn, watch } = createLiveVisionHandlers({ client: fakeClient() });
    assert.equal((await turn(post('{not json'))).status, 400);
    assert.equal((await turn(post({ text: '', frames: [] }))).status, 400);
    assert.equal((await turn(post({ text: '', frames: ['not-a-jpeg'] }))).status, 400);
    assert.equal((await watch(post({ target: '', frame: JPEG }))).status, 400);
    assert.equal((await watch(post({ target: 'a hand', frame: 'PHN2Zz4=' }))).status, 400);
    assert.equal(calls.length, 0);
  });

  await test('at most four frames reach the model, newest kept', async () => {
    const { turn } = createLiveVisionHandlers({ client: fakeClient() });
    const frames = [1, 2, 3, 4, 5, 6].map((n) => `${JPEG}${n}`);
    await (await turn(post({ text: 'what changed?', frames, history: [], locale: 'en' }))).text();
    const images = calls[0].messages[0].content.filter((block) => block.type === 'image');
    assert.deepEqual(images.map((block) => block.source.data.slice(-1)), ['3', '4', '5', '6']);
  });

  await test('watcher uses the cheaper model and a JSON schema', async () => {
    const { watch } = createLiveVisionHandlers({ client: fakeClient() });
    const res = await watch(post({ target: 'una mano levantada', frame: JPEG }));
    assert.deepEqual(await res.json(), { seen: true, note: 'mano arriba' });
    assert.equal(calls[0].model, 'claude-haiku-5-5');
    assert.equal(calls[0].output_config.format.type, 'json_schema');
  });

  await test('without credentials the endpoints say so instead of failing', async () => {
    const saved = [process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN];
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const { turn, watch } = createLiveVisionHandlers();
      assert.equal((await turn(post({ text: 'hi', frames: [], history: [] }))).status, 503);
      assert.equal((await watch(post({ target: 'a hand', frame: JPEG }))).status, 503);
    } finally {
      if (saved[0]) process.env.ANTHROPIC_API_KEY = saved[0];
      if (saved[1]) process.env.ANTHROPIC_AUTH_TOKEN = saved[1];
    }
  });

  console.log(`\n${passed} passed`);
} finally {
  await vite.close();
}
