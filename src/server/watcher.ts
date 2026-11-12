/**
 * Advanced pattern: a separate vision model as a *watcher*.
 *
 * The talking agent keeps the conversation. The watcher looks at frames for
 * one specific thing (a hazard, a gesture, a state change) and only speaks up
 * when it sees it, so the main agent never has to carry every frame itself.
 *
 * It is a different, cheaper model on purpose, and its answer is constrained
 * to a JSON schema so there is nothing to parse defensively.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { WatchRequest, WatchResult } from './protocol';

export const DEFAULT_WATCHER_MODEL = 'claude-haiku-5-5';

const PROMPT = (target: string) =>
  `You are a silent watcher looking at one camera frame.
Target: "${target}".
"seen" is true only if the target is clearly visible in this frame.
"note" says what you saw in at most 8 words, in the language of the target; leave it empty when nothing was seen.`;

const SCHEMA = {
  type: 'object',
  properties: {
    seen: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['seen', 'note'],
  additionalProperties: false,
};

export interface WatchOptions {
  client: Anthropic;
  model?: string;
  signal?: AbortSignal;
}

export async function watchFrame(
  req: WatchRequest,
  { client, model = DEFAULT_WATCHER_MODEL, signal }: WatchOptions,
): Promise<WatchResult> {
  const message = await client.messages.create(
    {
      model,
      max_tokens: 1024,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: req.frame } },
            { type: 'text', text: PROMPT(req.target) },
          ],
        },
      ],
    },
    { signal },
  );

  if (message.stop_reason === 'refusal') return { seen: false, note: '' };

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  try {
    const data = JSON.parse(text) as { seen?: unknown; note?: unknown };
    return { seen: data.seen === true, note: String(data.note ?? '').slice(0, 60) };
  } catch {
    // Only reachable if the answer was cut off by max_tokens.
    return { seen: false, note: '' };
  }
}
