'use client';

/**
 * Give your agent eyes.
 *
 *   camera -> canvas -> JPEG -> base64 -> Claude
 *
 * "Look"  = one deliberate frame (snapshot)
 * "Watch" = frames over time (stream)
 *
 * Voice is the browser's: SpeechRecognition turns the mic into text and
 * speechSynthesis reads the answer as it streams in. The Anthropic API takes
 * text and images, so audio never leaves the browser.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Locale, Turn, TurnEvent, WatchResult } from '../server/protocol';
import { STRINGS } from './strings';

export interface LiveVisionEndpoints {
  turn: string;
  watch: string;
}

export interface LiveVisionProps {
  endpoints?: LiveVisionEndpoints;
  locale?: Locale;
  className?: string;
}

interface Frame {
  b64: string;
  bytes: number;
  url: string;
}

type PipelineNode = 'camera' | 'canvas' | 'jpeg' | 'base64' | 'model';
const NODES: PipelineNode[] = ['camera', 'canvas', 'jpeg', 'base64', 'model'];
const FPS = [0.5, 1, 2] as const;

/** How many of the newest stream frames ride along with a question. */
const STREAM_FRAMES = 3;
const HISTORY_TURNS = 16;
const DEFAULT_ENDPOINTS: LiveVisionEndpoints = { turn: '/api/turn', watch: '/api/watch' };

/* SpeechRecognition is not in lib.dom; this is the slice of it used here. */
interface SpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const SENTENCE_END = /[.!?…]["')\]]?\s/g;

export function LiveVision({ endpoints = DEFAULT_ENDPOINTS, locale = 'en', className }: LiveVisionProps) {
  const t = STRINGS[locale];
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [hasCam, setHasCam] = useState(false);
  const [live, setLive] = useState(false);
  const [streaming, setStreamingState] = useState(false);
  const [fps, setFps] = useState<number>(1);
  const [mode, setMode] = useState<'idle' | 'snapshot' | 'stream'>('idle');
  const [lit, setLit] = useState<Partial<Record<PipelineNode, boolean>>>({});
  const [stats, setStats] = useState({ frames: 0, kb: 0, tokens: 0 });
  const [you, setYou] = useState('');
  const [agent, setAgent] = useState('');
  const [thinking, setThinking] = useState(false);
  const [hint, setHintState] = useState({ text: t.tapToLive, err: false });
  const [thumb, setThumb] = useState({ url: '', show: false });
  const [target, setTarget] = useState('');
  const [badge, setBadge] = useState<{ text: string; cls: '' | 'watching' | 'seen' | 'error' }>({
    text: t.off,
    cls: '',
  });
  const [flash, setFlash] = useState(0);
  const [draft, setDraft] = useState('');

  // Everything timers and browser callbacks read lives here, so a callback
  // created on an earlier render never acts on stale state.
  const R = useRef({
    cam: null as MediaStream | null,
    facing: 'environment' as 'user' | 'environment',
    live: false,
    streaming: false,
    fps: 1,
    target: '',
    history: [] as Turn[],
    buffer: [] as Frame[],
    voiceFrame: null as Promise<Frame | null> | null,
    utterance: false,
    abort: null as AbortController | null,
    recog: null as SpeechRecognitionLike | null,
    recogActive: false,
    speaking: 0,
    speechGen: 0,
    watcherBusy: false,
    lastSeen: false,
    timer: 0,
    thumbTimer: 0,
    hintTimer: 0,
    urls: [] as string[],
    t,
    locale,
    endpoints,
  }).current;
  R.t = t;
  R.locale = locale;
  R.endpoints = endpoints;

  const setHint = (text: string, err = false) => setHintState({ text, err });

  /* ───────────────── pipeline strip ───────────────── */
  function light(node: PipelineNode, delay = 0) {
    window.setTimeout(() => {
      setLit((s) => ({ ...s, [node]: true }));
      window.setTimeout(() => setLit((s) => ({ ...s, [node]: false })), 520);
    }, delay);
  }

  /** Count a frame only when it actually reaches a model. */
  function sent(frame: Frame) {
    light('model');
    setStats((s) => ({ ...s, frames: s.frames + 1, kb: Math.round(frame.bytes / 1024) }));
  }

  /* ───────────────── camera ───────────────── */
  async function startCamera(flip = false) {
    if (flip) R.facing = R.facing === 'user' ? 'environment' : 'user';
    R.cam?.getTracks().forEach((track) => track.stop());
    try {
      R.cam = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: R.facing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (videoRef.current) videoRef.current.srcObject = R.cam;
      setHasCam(true);
    } catch {
      R.cam = null;
      setHasCam(false);
      setHint(window.isSecureContext ? R.t.camBlocked : R.t.camInsecure, true);
    }
  }

  // One frame, end to end: video -> canvas -> JPEG bytes -> base64.
  async function captureFrame(): Promise<Frame | null> {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return null;
    light('camera');
    const scale = Math.min(1, 768 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    light('canvas', 90);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.7));
    if (!blob) return null;
    light('jpeg', 180);
    const buf = await blob.arrayBuffer();
    light('base64', 270);
    const url = URL.createObjectURL(blob);
    R.urls.push(url);
    while (R.urls.length > 12) URL.revokeObjectURL(R.urls.shift()!);
    return { b64: toBase64(buf), bytes: buf.byteLength, url };
  }

  // The thumbnail is the exact JPEG the model received. It stays up until the
  // answer lands, so you can compare what the model saw with what it said.
  function showThumb(url: string) {
    window.clearTimeout(R.thumbTimer);
    setThumb({ url, show: true });
  }
  function hideThumb(delay = 1500) {
    window.clearTimeout(R.thumbTimer);
    R.thumbTimer = window.setTimeout(() => setThumb((s) => ({ ...s, show: false })), delay);
  }

  /* ───────────────── voice out ───────────────── */
  function speak(text: string) {
    const clean = text.trim();
    if (!clean || !('speechSynthesis' in window)) return;
    const gen = R.speechGen;
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = R.locale === 'es' ? 'es-ES' : 'en-US';
    utterance.rate = 1.05;
    R.speaking += 1;
    // The mic would hear the speaker and answer itself: listen again after.
    pauseRecognition();
    const finished = () => {
      if (gen !== R.speechGen) return;
      R.speaking = Math.max(0, R.speaking - 1);
      if (R.speaking === 0) resumeRecognition();
    };
    utterance.onend = finished;
    utterance.onerror = finished;
    window.speechSynthesis.speak(utterance);
  }

  /** Stop the answer in flight: the request, and the voice reading it. */
  function interrupt() {
    R.abort?.abort();
    R.abort = null;
    R.speechGen += 1;
    R.speaking = 0;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setThinking(false);
    resumeRecognition();
  }

  /* ───────────────── the turn ───────────────── */
  async function runTurn(text: string, frames: Frame[], shown = text) {
    interrupt();
    const ctrl = new AbortController();
    R.abort = ctrl;
    setYou(shown);
    setAgent('');
    setThinking(true);
    if (frames.length) {
      showThumb(frames[frames.length - 1].url);
      frames.forEach(sent);
    }

    let full = '';
    let spoken = 0;
    const speakReady = (flush: boolean) => {
      let end = -1;
      if (flush) {
        end = full.length;
      } else {
        SENTENCE_END.lastIndex = spoken;
        for (let m = SENTENCE_END.exec(full); m; m = SENTENCE_END.exec(full)) end = m.index + m[0].length;
      }
      if (end > spoken) {
        speak(full.slice(spoken, end));
        spoken = end;
      }
    };

    try {
      const res = await fetch(R.endpoints.turn, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          history: R.history,
          text,
          frames: frames.map((f) => f.b64),
          locale: R.locale,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        setHint(statusMessage(res.status), true);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as TurnEvent;
          if (event.type === 'text') {
            full += event.delta;
            setAgent(full);
            speakReady(false);
          } else if (event.type === 'done') {
            setStats((s) => ({ ...s, tokens: s.tokens + event.inputTokens + event.outputTokens }));
          } else if (event.type === 'refusal') {
            full = R.t.refusal;
            spoken = 0;
            setAgent(full);
          } else {
            setHint(event.code === 'busy' ? R.t.busy : event.code === 'offline' ? R.t.offline : R.t.failed, true);
          }
        }
      }
      speakReady(true);

      if (full) {
        R.history.push({ role: 'user', text: text || R.t.lookMarker }, { role: 'agent', text: full });
        R.history.splice(0, Math.max(0, R.history.length - HISTORY_TURNS));
      }
    } catch {
      if (!ctrl.signal.aborted) setHint(R.t.failed, true);
    } finally {
      if (R.abort === ctrl) {
        R.abort = null;
        setThinking(false);
        if (!R.streaming) hideThumb();
      }
    }
  }

  function statusMessage(status: number): string {
    if (status === 401 || status === 403) return R.t.locked;
    if (status === 429) return R.t.busy;
    if (status === 503) return R.t.offline;
    return R.t.failed;
  }

  /** Stream mode already holds recent frames; otherwise use the one taken as you spoke. */
  async function framesForTurn(): Promise<Frame[]> {
    if (R.streaming) return R.buffer.slice(-STREAM_FRAMES);
    const frame = await (R.voiceFrame ?? captureFrame());
    R.voiceFrame = null;
    return frame ? [frame] : [];
  }

  /* ───────────────── modes ───────────────── */
  function look(why: 'button' | 'voice') {
    if (R.streaming) return;
    setFlash((n) => n + 1);
    setMode('snapshot');
    const shot = captureFrame();
    if (why === 'voice') R.voiceFrame = shot;
    void shot.then((frame) => {
      if (!frame) {
        if (why === 'button') setHint(R.t.needCam, true);
        return;
      }
      showThumb(frame.url);
      offerToWatcher(frame);
      if (why === 'button') void runTurn('', [frame], '');
    });
    if (why === 'voice') {
      setHint(R.t.heardLooked);
      window.clearTimeout(R.hintTimer);
      R.hintTimer = window.setTimeout(() => R.live && setHint(R.t.listening), 1400);
    }
    window.setTimeout(() => !R.streaming && setMode('idle'), 500);
  }

  async function tick() {
    const frame = await captureFrame();
    if (!frame || !R.streaming) return;
    R.buffer.push(frame);
    if (R.buffer.length > STREAM_FRAMES) R.buffer.shift();
    showThumb(frame.url);
    offerToWatcher(frame);
  }

  function setStreaming(on: boolean) {
    R.streaming = on;
    window.clearInterval(R.timer);
    setStreamingState(on);
    setMode(on ? 'stream' : 'idle');
    if (on) {
      void tick();
      R.timer = window.setInterval(() => void tick(), 1000 / R.fps);
    } else {
      R.buffer = [];
      hideThumb(600);
    }
  }

  /* ───────────────── watcher ───────────────── */
  // A separate, cheaper model looks at frames for one thing. Frames that
  // arrive while a call is in flight are dropped. When the target appears
  // (rising edge), the finding is handed to the talking agent as plain text.
  function offerToWatcher(frame: Frame) {
    if (!R.target || R.watcherBusy) return;
    R.watcherBusy = true;
    const target = R.target;
    sent(frame);
    void fetch(R.endpoints.watch, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target, frame: frame.b64 }),
    })
      .then(async (res) => {
        if (R.target !== target) return;
        if (!res.ok) {
          setBadge({ text: res.status === 401 || res.status === 403 ? R.t.locked : R.t.error, cls: 'error' });
          return;
        }
        const result = (await res.json()) as WatchResult;
        const rising = result.seen && !R.lastSeen;
        R.lastSeen = result.seen;
        setBadge(
          result.seen
            ? { text: result.note || R.t.seen, cls: 'seen' }
            : { text: R.t.watching, cls: 'watching' },
        );
        if (rising) {
          const note = result.note || target;
          void runTurn(`[watcher] I just spotted: ${note}.`, [frame], `${R.t.watcher} · ${note}`);
        }
      })
      .catch(() => setBadge({ text: R.t.error, cls: 'error' }))
      .finally(() => {
        R.watcherBusy = false;
      });
  }

  function changeTarget(value: string) {
    setTarget(value);
    R.target = value.trim();
    R.lastSeen = false;
    setBadge(R.target ? { text: R.t.watching, cls: 'watching' } : { text: R.t.off, cls: '' });
  }

  /* ───────────────── voice in ───────────────── */
  function safeStart() {
    try {
      R.recog?.start();
      R.recogActive = true;
    } catch {
      // Already started.
    }
  }
  function pauseRecognition() {
    if (R.recog && R.recogActive) R.recog.abort();
  }
  function resumeRecognition() {
    if (R.live && R.recog && !R.recogActive && R.speaking === 0) safeStart();
  }

  // "What is this?" only makes sense with the frame from *now*. The moment the
  // mic hears you start talking, take one snapshot, so "this" means what is in
  // front of the camera as you ask — not whatever you last pressed Look at.
  function onSpeech(interim: string, final: string) {
    if (!R.utterance) {
      R.utterance = true;
      if (!R.streaming) look('voice');
    }
    setYou(final || interim);
    const said = final.trim();
    if (!said) return;
    R.utterance = false;
    void framesForTurn().then((frames) => runTurn(said, frames));
  }

  function goLive() {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      setHint(R.t.noSpeech, true);
      return;
    }
    const recog = new Ctor();
    recog.lang = R.locale === 'es' ? 'es-ES' : 'en-US';
    recog.continuous = true;
    recog.interimResults = true;
    recog.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim || final) onSpeech(interim, final);
    };
    recog.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        stopLive();
        setHint(R.t.micBlocked, true);
      }
    };
    // Chrome ends a session after a stretch of silence: keep it open.
    recog.onend = () => {
      R.recogActive = false;
      R.utterance = false;
      resumeRecognition();
    };
    R.recog = recog;
    R.live = true;
    setLive(true);
    setHint(R.t.listening);
    safeStart();
  }

  function stopLive() {
    R.live = false;
    R.recog?.abort();
    R.recog = null;
    R.recogActive = false;
    interrupt();
    setLive(false);
    setHint(R.t.tapToLive);
  }

  function submitDraft(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void framesForTurn().then((frames) => runTurn(text, frames));
  }

  /* ───────────────── lifecycle ───────────────── */
  useEffect(() => {
    void startCamera();
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      const typing = !!el && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName);
      if (event.code === 'Space' && !typing) {
        event.preventDefault();
        look('button');
      } else if (event.code === 'Escape') {
        interrupt();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearInterval(R.timer);
      window.clearTimeout(R.thumbTimer);
      window.clearTimeout(R.hintTimer);
      R.live = false;
      R.streaming = false;
      R.recog?.abort();
      R.abort?.abort();
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      R.cam?.getTracks().forEach((track) => track.stop());
      R.urls.forEach((url) => URL.revokeObjectURL(url));
      R.urls = [];
    };
    // Mount once: every handler reads live values through R.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statText = [
    `${stats.frames} ${stats.frames === 1 ? t.frame : t.frames}`,
    stats.kb ? `${stats.kb} KB` : '',
    stats.tokens ? `${(stats.tokens / 1000).toFixed(1)}k tok` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={['lv', className].filter(Boolean).join(' ')}>
      {/* ───────── stage: what the agent sees ───────── */}
      <section className="lv-stage">
        <div className={`lv-viewfinder${hasCam ? ' has-cam' : ''}`} data-mode={mode}>
          <video ref={videoRef} autoPlay playsInline muted />
          <canvas ref={canvasRef} hidden />
          {!hasCam && (
            <button type="button" className="lv-nocam" onClick={() => void startCamera()}>
              <CameraIcon />
              <b>{t.camOn}</b>
              <small>{t.camAllow}</small>
            </button>
          )}
          <div className="lv-scan" aria-hidden />
          <div key={flash} className={`lv-flash${flash ? ' go' : ''}`} aria-hidden />

          <div className="lv-hud lv-hud-top">
            <div className="lv-hud-group">
              <div className={`lv-pill${live ? ' live' : ''}`}>
                <i className="lv-dot" />
                <span>{live ? t.live : t.offlineStatus}</span>
              </div>
              <button
                type="button"
                className="lv-pill lv-pill-btn"
                onClick={() => void startCamera(hasCam)}
                title={t.camTitle}
              >
                <CameraIcon />
                <span>{hasCam ? t.flip : t.camera}</span>
              </button>
            </div>
            <div className="lv-hud-group lv-hud-right">
              <div className="lv-pill lv-ghost">{statText}</div>
              {thumb.url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img className={`lv-thumb${thumb.show ? ' show' : ''}`} src={thumb.url} alt={t.thumbAlt} />
              )}
            </div>
          </div>

          <div className="lv-hud lv-hud-bottom" aria-live="polite">
            {you && <p className="lv-you">{you}</p>}
            <p className={`lv-agent${thinking && !agent ? ' thinking' : ''}`}>
              {agent || (thinking ? t.thinking : t.intro)}
            </p>
          </div>
        </div>
      </section>

      {/* ───────── panel: how frames get in ───────── */}
      <aside className="lv-panel">
        <div className="lv-modes">
          <button type="button" className="lv-mode" onClick={() => look('button')} title="Space">
            <EyeIcon />
            <span className="lv-big">{t.look}</span>
            <span className="lv-small">{t.oneFrame}</span>
          </button>

          <div className={`lv-mode lv-mode-watch${streaming ? ' on' : ''}`}>
            <button
              type="button"
              className="lv-mode-hit"
              onClick={() => setStreaming(!R.streaming)}
              aria-pressed={streaming}
            >
              <EyeIcon waves />
              <span className="lv-big">{t.watch}</span>
              <span className="lv-small">{t.framesPerSec}</span>
            </button>
            <div className="lv-fps" role="group" aria-label={t.framesPerSec}>
              {FPS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={fps === value ? 'on' : ''}
                  aria-pressed={fps === value}
                  onClick={() => {
                    R.fps = value;
                    setFps(value);
                    if (R.streaming) setStreaming(true);
                  }}
                >
                  {value === 0.5 ? '½' : value}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={`lv-pipeline${streaming ? ' stream' : ''}`} aria-hidden>
          {NODES.map((node) => (
            <span key={node} className={`lv-node${lit[node] ? ' lit' : ''}`}>
              {t.nodes[node]}
            </span>
          ))}
        </div>

        <label className="lv-watcher">
          <span className="lv-label">{t.watcher}</span>
          <input
            value={target}
            onChange={(event) => changeTarget(event.target.value)}
            placeholder={t.watchPlaceholder}
            autoComplete="off"
            maxLength={80}
          />
          <span className={`lv-badge ${badge.cls}`}>{badge.text}</span>
        </label>

        <form className="lv-say" onSubmit={submitDraft}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t.typePlaceholder}
            aria-label={t.typePlaceholder}
            autoComplete="off"
            maxLength={800}
          />
          <button type="submit" disabled={!draft.trim()}>
            {t.send}
          </button>
        </form>

        <footer className="lv-controls">
          <button
            type="button"
            className={`lv-mic${live ? ' live' : ''}`}
            onClick={() => (R.live ? stopLive() : goLive())}
            aria-label={live ? t.micStop : t.micStart}
            aria-pressed={live}
          >
            <i className="lv-ring" />
            <MicIcon />
          </button>
          <span className={`lv-hint${hint.err ? ' err' : ''}`} role="status">
            {hint.text}
          </span>
        </footer>
      </aside>
    </div>
  );
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth={2} aria-hidden {...stroke}>
      <rect x="3" y="7" width="18" height="13" rx="1.5" />
      <path d="M8.5 7l1.4-2.5h4.2L15.5 7" />
      <circle cx="12" cy="13.5" r="3.2" />
    </svg>
  );
}

function EyeIcon({ waves = false }: { waves?: boolean }) {
  return (
    <svg viewBox="0 0 48 48" strokeWidth={2.6} aria-hidden {...stroke}>
      {waves ? (
        <>
          <path d="M9 24c4-6.5 9-9.5 15-9.5s11 3 15 9.5c-4 6.5-9 9.5-15 9.5S13 30.500 9 24z" />
          <circle cx="24" cy="24" r="4.2" />
          <path d="M5 13.500a22 22 0 0 0 0 21M43 13.500a22 22 0 0 1 0 21" />
        </>
      ) : (
        <>
          <path d="M5 24c5-8 11.500-12 19-12s14 4 19 12c-5 8-11.500 12-19 12S10 32 5 24z" />
          <circle cx="24" cy="24" r="5.500" />
        </>
      )}
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth={2.2} aria-hidden {...stroke}>
      <rect x="9" y="2.500" width="6" height="12" rx="3" />
      <path d="M5.500 11.500a6.500 6.500 0 0 0 13 0M12 18v3.500M8.500 21.500h7" />
    </svg>
  );
}
