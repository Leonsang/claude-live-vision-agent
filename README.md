# Eyes · a Claude agent that can see

A voice agent with eyes, built on the **Anthropic SDK**. You talk, it looks
through your camera, and it answers out loud.

```
camera → canvas → JPEG → base64 image block ┐
mic    → browser speech recognition → text  ┴→ Claude → streamed text → browser speech
```

It is a port of the idea in
[cuppibla/live-vision-agent](https://github.com/cuppibla/live-vision-agent)
(a Google ADK live agent) to Claude. The interaction is the same; the plumbing
is not, because the two APIs are shaped differently.

## ADK → Anthropic SDK

| | ADK original | This repo |
|---|---|---|
| Talking agent | an ADK `Agent` in a `run_live` session | `client.beta.messages.stream()` on `claude-opus-5-5`, one call per turn |
| Transport | one WebSocket, `LiveRequestQueue` | plain HTTP: `POST /turn` returns an NDJSON stream |
| A frame | `types.Blob(data=jpeg, mime_type="image/jpeg")` | `{type: "image", source: {type: "base64", media_type: "image/jpeg", data}}` |
| Voice in | 16 kHz PCM streamed to the model | the browser's `SpeechRecognition` → text |
| Voice out | 24 kHz PCM from the model | the browser's `speechSynthesis`, sentence by sentence as text streams in |
| Session state | in-memory ADK session | none on the server: the browser sends the text history each turn |
| Watcher | a smaller model + regex over the reply | `claude-haiku-5-5` + a JSON-schema structured output |

Two honest differences from the original:

- **Audio never reaches the model.** The Messages API takes text and images, so
  speech-to-text and text-to-speech happen in the browser. Voice input needs
  Chrome, Edge or Safari; everywhere else you type. While the agent is
  speaking the mic is paused (press `Esc`, or ask something new, to cut it off).
- **Watch mode buffers instead of streaming into a session.** Frames are
  captured at ½ / 1 / 2 fps; the watcher sees them as they come, and the
  talking agent receives the newest three with your next question.

In exchange the server is stateless, so it runs on serverless functions
(Vercel, Cloudflare, Lambda) where a long-lived WebSocket does not.

## What the UI shows

| Control | Pattern | When |
|---|---|---|
| **Look** (or `Space`) | snapshot — one deliberate frame | the scene is static: a label, a document, an object |
| **Watch** | stream — frames at ½ / 1 / 2 fps | the world changes on its own |
| **Watcher** | a *separate*, cheaper model scans frames for one thing and only speaks up when it appears | hazards, gestures, state changes |

The moment the mic hears you start talking, the app takes one snapshot on its
own (*heard you → looked*), so “this” always means what is in front of the
camera as you ask. The thumbnail in the viewfinder is the exact JPEG the model
received, and the stat pill counts frames, bytes and tokens. Frames are not free.

## Run it

```bash
cp .env.example .env        # add your ANTHROPIC_API_KEY
npm install
npm run dev
```

Open <http://localhost:8000>, tap the mic, hold something up and ask
*“what is this?”*

`npm test` runs the server handlers against a fake Anthropic client — no key,
no network.

> Camera and mic need a secure context. `localhost` is fine; from a phone, use
> an https tunnel.

## Use it in your own app

The repo is also a package. It ships TypeScript source, so the host bundler
compiles it (in Next.js: `transpilePackages: ['claude-live-vision-agent']`).

```bash
npm install github:Leonsang/claude-live-vision-agent
```

Server — Web-standard `Request → Response` handlers:

```ts
// app/api/vision/turn/route.ts
import { createLiveVisionHandlers } from 'claude-live-vision-agent/server';

const { turn } = createLiveVisionHandlers();
export const POST = (request: Request) => turn(request);
```

Client:

```tsx
'use client';
import { LiveVision } from 'claude-live-vision-agent/react';
import 'claude-live-vision-agent/styles.css';

<LiveVision locale="es" endpoints={{ turn: '/api/vision/turn', watch: '/api/vision/watch' }} />;
```

Every colour, face and radius is a `--lv-*` custom property on `.lv`, so the
host can re-skin it without touching the component.

**The handlers do not authenticate or rate-limit.** They spend real money on
every call: put your own gate in front of them before exposing them.

## Files

```
src/server/agent.ts      the agent (nothing vision-specific here) + streamTurn()
src/server/watcher.ts    advanced pattern: a separate vision model as a watcher
src/server/handlers.ts   Request → Response handlers for /turn and /watch
src/server/protocol.ts   wire types and input validation
src/react/LiveVision.tsx camera → canvas → JPEG → base64, snapshot vs stream, voice
src/react/styles.css     default skin, all tokens overridable
vite.config.ts           standalone demo: page + API in one dev server
tests/handlers.test.mjs  the handlers against a fake client
```

## The one idea

An image is just bytes plus a media type. The user turn that carries the words
carries the frame too:

```ts
content: [
  { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } },
  { type: 'text', text: 'What is this?' },
]
```

Snapshot when the agent needs to **look**. Stream when it needs to **watch**.

## Configuration

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required |
| `VISION_MODEL` | `claude-opus-5-5` | the agent that talks |
| `WATCHER_MODEL` | `claude-haiku-5-5` | the background watcher |

The talking agent runs at `effort: "low"` for a short time-to-first-word and
opts into server-side refusal fallbacks.
