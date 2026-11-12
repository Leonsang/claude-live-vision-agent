/**
 * The wire protocol between the browser and the server.
 *
 * The server is stateless: every turn carries the (text-only) history plus the
 * frames for *this* turn. That is what lets it run on serverless functions,
 * where a long-lived WebSocket session is not available.
 */

export type Locale = 'en' | 'es';

export interface Turn {
  role: 'user' | 'agent';
  text: string;
}

export interface TurnRequest {
  /** Earlier turns, text only. Old frames are history and are not re-sent. */
  history: Turn[];
  /** What the user said or typed. Empty when they only pressed Look. */
  text: string;
  /** Base64 JPEG frames, oldest first. The last one is "now". */
  frames: string[];
  locale: Locale;
}

export type TurnEvent =
  | { type: 'text'; delta: string }
  | { type: 'done'; model: string; inputTokens: number; outputTokens: number }
  | { type: 'refusal' }
  | { type: 'error'; code: 'busy' | 'offline' | 'upstream'; message: string };

export interface WatchRequest {
  target: string;
  /** One base64 JPEG frame. */
  frame: string;
}

export interface WatchResult {
  seen: boolean;
  note: string;
}

export const LIMITS = {
  frames: 4,
  /** ~1.1 MB of JPEG. A 768px frame at q0.7 is usually 40–120 KB. */
  frameChars: 1_500_000,
  historyTurns: 16,
  textChars: 800,
  targetChars: 80,
} as const;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isFrame(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= LIMITS.frameChars &&
    // A JPEG always starts FF D8 FF, which is "/9j/" in base64.
    value.startsWith('/9j/') &&
    BASE64.test(value)
  );
}

export function parseTurnRequest(body: unknown): TurnRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  const text = typeof b.text === 'string' ? b.text.trim().slice(0, LIMITS.textChars) : '';
  const frames = Array.isArray(b.frames) ? b.frames.filter(isFrame).slice(-LIMITS.frames) : [];
  if (!text && frames.length === 0) return null;

  const history: Turn[] = Array.isArray(b.history)
    ? b.history
        .filter(
          (t): t is Turn =>
            !!t &&
            typeof t === 'object' &&
            ((t as Turn).role === 'user' || (t as Turn).role === 'agent') &&
            typeof (t as Turn).text === 'string' &&
            (t as Turn).text.trim().length > 0,
        )
        .slice(-LIMITS.historyTurns)
        .map((t) => ({ role: t.role, text: t.text.trim().slice(0, LIMITS.textChars) }))
    : [];

  return { history, text, frames, locale: b.locale === 'es' ? 'es' : 'en' };
}

export function parseWatchRequest(body: unknown): WatchRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const target = typeof b.target === 'string' ? b.target.trim().slice(0, LIMITS.targetChars) : '';
  if (!target || !isFrame(b.frame)) return null;
  return { target, frame: b.frame };
}
