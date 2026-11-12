/**
 * Web-standard handlers (Request -> Response), so the same code runs in a
 * Next.js route handler, a Vite dev middleware or any fetch-style runtime.
 *
 * They do NOT authenticate or rate-limit: these endpoints spend real money, so
 * wrap them with whatever gate your host uses before exposing them.
 */

import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_VISION_MODEL, streamTurn } from './agent';
import { parseTurnRequest, parseWatchRequest, type TurnEvent } from './protocol';
import { DEFAULT_WATCHER_MODEL, watchFrame } from './watcher';

export interface LiveVisionOptions {
  /** Defaults to `new Anthropic()`, which reads ANTHROPIC_API_KEY. */
  client?: Anthropic;
  /** Defaults to $VISION_MODEL, then claude-opus-5-5. */
  model?: string;
  /** Defaults to $WATCHER_MODEL, then claude-haiku-5-5. */
  watcherModel?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

function hasCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function createLiveVisionHandlers(options: LiveVisionOptions = {}) {
  let cached = options.client;
  const client = () => (cached ??= new Anthropic());
  const offline = () => !options.client && !hasCredentials();

  const model = options.model ?? process.env.VISION_MODEL ?? DEFAULT_VISION_MODEL;
  const watcherModel = options.watcherModel ?? process.env.WATCHER_MODEL ?? DEFAULT_WATCHER_MODEL;

  /** POST { history, text, frames, locale } -> NDJSON stream of TurnEvent. */
  async function turn(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const parsed = parseTurnRequest(body);
    if (!parsed) return json({ error: 'invalid_request' }, 400);
    if (offline()) return json({ error: 'offline' }, 503);

    const encoder = new TextEncoder();
    const abort = new AbortController();
    request.signal.addEventListener('abort', () => abort.abort(), { once: true });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: TurnEvent) =>
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        try {
          for await (const event of streamTurn(parsed, { client: client(), model, signal: abort.signal })) {
            send(event);
          }
        } finally {
          try {
            controller.close();
          } catch {
            // Already cancelled by the reader.
          }
        }
      },
      // The browser went away or the user interrupted: stop paying for tokens.
      cancel() {
        abort.abort();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  }

  /** POST { target, frame } -> { seen, note }. */
  async function watch(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const parsed = parseWatchRequest(body);
    if (!parsed) return json({ error: 'invalid_request' }, 400);
    if (offline()) return json({ error: 'offline' }, 503);

    try {
      return json(await watchFrame(parsed, { client: client(), model: watcherModel, signal: request.signal }));
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) return json({ error: 'busy' }, 429);
      if (error instanceof Anthropic.AuthenticationError) return json({ error: 'offline' }, 503);
      return json({ error: 'upstream' }, 502);
    }
  }

  return { turn, watch };
}
