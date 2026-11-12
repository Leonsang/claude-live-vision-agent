/**
 * The agent that can see.
 *
 * Nothing here is vision-specific. It is a plain Messages API call on a Claude
 * model. Eyes come from *what we put in the user turn* (image blocks), not
 * from the agent definition:
 *
 *     camera -> canvas -> JPEG -> base64 image block -> Claude
 *     mic    -> browser speech recognition -> text block -> Claude
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Locale, TurnEvent, TurnRequest } from './protocol';

export const DEFAULT_VISION_MODEL = 'claude-opus-5-5';

const INSTRUCTION = `
You are a friendly, concise voice assistant with eyes.

The user talks to you out loud; their speech arrives as text and your reply is
read aloud by a speech synthesizer. Camera frames arrive as images in the same
turn as the words. A fresh frame is captured the moment the user starts
speaking, so the LAST image of the newest message is what they are looking at
right now. When the user says things like "this", "that", "what is this",
"read this", answer about that newest frame only. Frames from earlier turns are
not re-sent; never describe an object from an earlier turn as if it were still
in view.

Rules:
- Keep answers short: one or two spoken sentences. Plain prose only — no
  markdown, lists, emoji or headings, because every character is spoken.
- Describe only what you can actually see. If the frame is blurry or the object
  is unclear, say so and ask the user to hold it closer.
- When a message carries several frames (watch mode), they are in time order.
  Comment only on what matters or what changed; do not narrate every frame.
- If a message has frames but no words, the user pressed Look: say in one
  sentence what you see.
- If a message starts with "[watcher]", it is a background vision model
  reporting something it spotted. Briefly tell the user about it.
`.trim();

const LANGUAGE: Record<Locale, string> = {
  en: 'Reply in the language the user speaks. If there are no words to go by, reply in English.',
  es: 'Responde en el idioma en que habla el usuario. Si no hay palabras que te orienten, responde en español.',
};

export function systemPrompt(locale: Locale): string {
  return `${INSTRUCTION}\n\n${LANGUAGE[locale]}`;
}

/** History is text only; the frames ride on the newest user turn. */
export function buildMessages(req: TurnRequest): Anthropic.Beta.BetaMessageParam[] {
  const turns: { role: 'user' | 'assistant'; text: string }[] = [];

  // The API wants the conversation to open with the user and to alternate.
  for (const turn of req.history) {
    const role = turn.role === 'agent' ? 'assistant' : 'user';
    const last = turns[turns.length - 1];
    if (!last && role === 'assistant') continue;
    if (last && last.role === role) last.text = `${last.text}\n${turn.text}`;
    else turns.push({ role, text: turn.text });
  }

  const content: Anthropic.Beta.BetaContentBlockParam[] = req.frames.map((data) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data },
  }));
  if (req.text) content.push({ type: 'text', text: req.text });

  // Two user turns in a row (an interrupted answer): fold them together.
  const dangling = turns[turns.length - 1];
  if (dangling && dangling.role === 'user') {
    turns.pop();
    content.unshift({ type: 'text', text: dangling.text });
  }

  return [
    ...turns.map((turn): Anthropic.Beta.BetaMessageParam => ({ role: turn.role, content: turn.text })),
    { role: 'user', content },
  ];
}

export interface StreamTurnOptions {
  client: Anthropic;
  model?: string;
  signal?: AbortSignal;
}

/**
 * One turn, streamed. Yields text deltas as Claude writes them, then `done`.
 * Never throws for API failures: they come out as an `error` event so the
 * caller can forward them down an already-open response stream.
 */
export async function* streamTurn(
  req: TurnRequest,
  { client, model = DEFAULT_VISION_MODEL, signal }: StreamTurnOptions,
): AsyncGenerator<TurnEvent> {
  try {
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: 4096,
        // A spoken answer is one or two sentences: the lowest effort keeps the
        // time to first word short. Thinking stays adaptive (the default).
        output_config: { effort: 'low' },
        // If a safety classifier declines the turn, the API re-runs it on a
        // fallback model inside the same call instead of just stopping.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: systemPrompt(req.locale),
        messages: buildMessages(req),
      },
      { signal },
    );

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', delta: event.delta.text };
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      yield { type: 'refusal' };
      return;
    }
    yield {
      type: 'done',
      model: final.model,
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
    };
  } catch (error) {
    if (signal?.aborted || error instanceof Anthropic.APIUserAbortError) return;
    if (error instanceof Anthropic.RateLimitError) {
      yield { type: 'error', code: 'busy', message: 'rate limited' };
    } else if (error instanceof Anthropic.AuthenticationError) {
      yield { type: 'error', code: 'offline', message: 'the server has no valid Anthropic credentials' };
    } else if (error instanceof Anthropic.APIError) {
      yield { type: 'error', code: 'upstream', message: `Anthropic API error ${error.status ?? ''}`.trim() };
    } else {
      yield { type: 'error', code: 'upstream', message: 'unexpected server error' };
    }
  }
}
