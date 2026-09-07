"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import type { AvatarState } from "./Avatar";
import type { Card } from "@/lib/cards";
import CardView from "./Cards";

const Avatar = dynamic(() => import("./Avatar"), { ssr: false });

type Mode = "avatar" | "chat";
type Turn = { role: "user" | "assistant"; content: string; cards?: Card[] };
type SessionInfo = { googleConnected: boolean; email: string | null; anthropicConfigured: boolean };

type Latest = {
  turns: Turn[];
  handsFree: boolean;
  muted: boolean;
  send: (text: string) => void;
  startListening: () => void;
};

const PROMPTS = [
  "What's on my calendar tomorrow?",
  "Any unread email this week?",
  "Book a dentist appointment Friday at 3.",
  "Remind me to call mum tonight.",
];

function TranscriptList({
  turns,
  listRef,
  fadeTop = false,
}: {
  turns: Turn[];
  listRef: React.RefObject<HTMLDivElement | null>;
  /** Softens the top edge where the list runs under other content. */
  fadeTop?: boolean;
}) {
  return (
    <div
      ref={listRef}
      className={`min-h-0 flex-1 space-y-4 overflow-y-auto pb-4 pr-1 ${
        fadeTop ? "[mask-image:linear-gradient(to_bottom,transparent,black_40px)]" : "pt-4"
      }`}
    >
      {turns.length === 0 && (
        <div className="space-y-2.5 pt-8">
          <p className="text-xs uppercase tracking-wider text-slate-500">Try saying</p>
          {PROMPTS.map((prompt) => (
            <p key={prompt} className="text-sm text-slate-400">
              &ldquo;{prompt}&rdquo;
            </p>
          ))}
        </div>
      )}

      {turns.map((turn, i) => (
        <div key={i} className="space-y-2">
          {turn.role === "user" ? (
            <div className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-500/90 px-3.5 py-2 text-sm text-white">
                {turn.content}
              </p>
            </div>
          ) : (
            <p className="max-w-[92%] text-sm leading-relaxed text-slate-200">{turn.content}</p>
          )}
          {turn.cards?.map((card, j) => (
            <CardView key={j} card={card} />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function VoiceAssistant() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [interim, setInterim] = useState("");
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [typed, setTyped] = useState("");
  // "avatar" = talk to her face; "chat" = plain voice-to-text transcript.
  const [mode, setMode] = useState<Mode>(() =>
    typeof window !== "undefined" && window.localStorage.getItem("pa_mode") === "chat" ? "chat" : "avatar",
  );

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // --- audio: her voice drives the mouth, frame by frame -----------------
  const mouthRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const meterRef = useRef<number | null>(null);

  const latest = useRef<Latest>({
    turns: [],
    handsFree: false,
    muted: false,
    send: () => undefined,
    startListening: () => undefined,
  });

  const searchParams = useSearchParams();
  const googleStatus = searchParams.get("google");
  const authError = googleStatus?.startsWith("error:")
    ? `Google sign-in failed: ${googleStatus.slice("error:".length)}`
    : null;

  useEffect(() => {
    if (googleStatus) window.history.replaceState({}, "", window.location.pathname);
  }, [googleStatus]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/session", { signal: controller.signal })
      .then((r) => r.json())
      .then(setSession)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, thinking]);

  const stopMeter = useCallback(() => {
    if (meterRef.current !== null) cancelAnimationFrame(meterRef.current);
    meterRef.current = null;
    mouthRef.current = 0;
  }, []);

  /** Reads loudness off the playing audio so the mouth matches the actual words. */
  const startMeter = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const level = Math.min(1, Math.sqrt(sum / data.length) * 4.5);
      mouthRef.current = mouthRef.current * 0.55 + level * 0.45;
      meterRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, []);

  /** Browser speech synthesis has no audio graph, so approximate the mouth. */
  const startFakeMeter = useCallback(() => {
    const tick = () => {
      const t = performance.now() / 1000;
      const envelope = Math.sin(t * 3.1) * 0.3 + 0.7;
      const syllables = Math.abs(Math.sin(t * 9.5)) * envelope;
      mouthRef.current = mouthRef.current * 0.5 + syllables * 0.5;
      meterRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, []);

  const speakWithBrowser = useCallback(
    (text: string, onDone?: () => void) => {
      if (!window.speechSynthesis) {
        onDone?.();
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.02;
      utterance.pitch = 1.05;
      const voice = window.speechSynthesis
        .getVoices()
        .find((v) => v.lang.startsWith("en") && /female|zira|samantha|aria|natural|google uk english female/i.test(v.name));
      if (voice) utterance.voice = voice;
      utterance.onstart = () => {
        setSpeaking(true);
        startFakeMeter();
      };
      const finish = () => {
        stopMeter();
        setSpeaking(false);
        onDone?.();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      window.speechSynthesis.speak(utterance);
    },
    [startFakeMeter, stopMeter],
  );

  const speak = useCallback(
    async (text: string, onDone?: () => void) => {
      if (latest.current.muted) {
        onDone?.();
        return;
      }
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        // 501 = no ElevenLabs key configured; fall back to the browser voice.
        if (res.status === 501 || !res.ok) {
          speakWithBrowser(text, onDone);
          return;
        }

        const buffer = await res.arrayBuffer();
        const ctx = (audioCtxRef.current ??= new AudioContext());
        if (ctx.state === "suspended") await ctx.resume();
        const decoded = await ctx.decodeAudioData(buffer);

        const source = ctx.createBufferSource();
        source.buffer = decoded;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        analyser.connect(ctx.destination);

        analyserRef.current = analyser;
        sourceRef.current = source;

        source.onended = () => {
          sourceRef.current = null;
          stopMeter();
          setSpeaking(false);
          onDone?.();
        };
        setSpeaking(true);
        source.start();
        startMeter();
      } catch {
        speakWithBrowser(text, onDone);
      }
    },
    [speakWithBrowser, startMeter, stopMeter],
  );

  const stopSpeaking = useCallback(() => {
    window.speechSynthesis?.cancel();
    if (sourceRef.current) {
      sourceRef.current.onended = null;
      try {
        sourceRef.current.stop();
      } catch {
        /* already stopped */
      }
      sourceRef.current = null;
    }
    stopMeter();
    setSpeaking(false);
  }, [stopMeter]);

  const startListening = useCallback(() => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setSupported(false);
      return;
    }
    if (recognitionRef.current) return;

    const recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    let finalText = "";

    recognition.onresult = (event) => {
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      setInterim(interimText);
    };

    recognition.onerror = (event) => {
      if (event.error !== "no-speech" && event.error !== "aborted") {
        setError(`Microphone error: ${event.error}`);
        setHandsFree(false);
        latest.current.handsFree = false;
      }
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      setInterim("");
      const text = finalText.trim();
      if (text) latest.current.send(text);
      else if (latest.current.handsFree) window.setTimeout(() => latest.current.startListening(), 400);
    };

    recognitionRef.current = recognition;
    setError(null);
    setListening(true);
    recognition.start();
  }, []);

  const stopListening = useCallback(() => {
    setHandsFree(false);
    latest.current.handsFree = false;
    recognitionRef.current?.stop();
  }, []);

  const send = useCallback(
    async (text: string) => {
      const next: Turn[] = [...latest.current.turns, { role: "user", content: text }];
      latest.current.turns = next;
      setTurns(next);
      setThinking(true);
      setError(null);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: next.map(({ role, content }) => ({ role, content })),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Request failed");

        const withReply: Turn[] = [
          ...next,
          { role: "assistant", content: data.reply, cards: data.cards ?? [] },
        ];
        latest.current.turns = withReply;
        setTurns(withReply);
        setThinking(false);
        void speak(data.reply, () => {
          if (latest.current.handsFree) latest.current.startListening();
        });
      } catch (e) {
        setThinking(false);
        setError(e instanceof Error ? e.message : "Something went wrong");
        setHandsFree(false);
        latest.current.handsFree = false;
      }
    },
    [speak],
  );

  useEffect(() => {
    latest.current = { turns, handsFree, muted, send: (t) => void send(t), startListening };
  }, [turns, handsFree, muted, send, startListening]);

  useEffect(() => {
    return () => {
      if (meterRef.current !== null) cancelAnimationFrame(meterRef.current);
      audioCtxRef.current?.close().catch(() => undefined);
    };
  }, []);

  const toggleHandsFree = () => {
    if (handsFree) {
      setHandsFree(false);
      latest.current.handsFree = false;
      recognitionRef.current?.stop();
    } else {
      setHandsFree(true);
      latest.current.handsFree = true;
      startListening();
    }
  };

  const onMicClick = () => {
    if (speaking) {
      stopSpeaking();
      return;
    }
    if (listening) stopListening();
    else startListening();
  };

  const avatarState: AvatarState = thinking
    ? "thinking"
    : speaking
      ? "speaking"
      : listening
        ? "listening"
        : "idle";

  const lastAssistant = useMemo(
    () => [...turns].reverse().find((t) => t.role === "assistant"),
    [turns],
  );
  const caption = interim || (thinking ? "" : lastAssistant?.content) || "";
  const shownError = error ?? authError;

  const statusText = thinking
    ? "Thinking"
    : speaking
      ? "Speaking — tap to interrupt"
      : listening
        ? "Listening"
        : handsFree
          ? "Hands-free · she'll listen after each reply"
          : "Tap the mic and talk";

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[#06080e] text-slate-100">
      {/* ambient light behind everything */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[38%] h-[75vmin] w-[75vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-600/25 blur-[110px]" />
        <div className="absolute right-[8%] top-[12%] h-[40vmin] w-[40vmin] rounded-full bg-sky-500/10 blur-[90px]" />
        <div className="absolute bottom-0 left-0 h-[35vmin] w-[45vmin] rounded-full bg-fuchsia-600/10 blur-[100px]" />
      </div>

      <header className="relative z-20 flex items-center justify-between gap-3 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span
            className={`h-2 w-2 rounded-full transition-colors ${
              listening
                ? "bg-sky-400 shadow-[0_0_10px_2px_rgba(56,189,248,0.6)]"
                : speaking
                  ? "bg-indigo-400 shadow-[0_0_10px_2px_rgba(129,140,248,0.6)]"
                  : thinking
                    ? "bg-amber-400"
                    : "bg-slate-600"
            }`}
          />
          <div>
            <h1 className="text-sm font-medium tracking-tight">Ava</h1>
            <p className="text-[11px] text-slate-500">{statusText}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-full border border-white/10 bg-white/[0.03] p-0.5 text-xs backdrop-blur">
            {(["avatar", "chat"] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  try {
                    window.localStorage.setItem("pa_mode", m);
                  } catch {
                    /* private mode */
                  }
                }}
                aria-pressed={mode === m}
                className={`rounded-full px-3 py-1 transition ${
                  mode === m ? "bg-white/15 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {m === "avatar" ? "Avatar" : "Chat"}
              </button>
            ))}
          </div>
          <button
            onClick={() => {
              if (!muted) stopSpeaking();
              setMuted((m) => !m);
            }}
            className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300 backdrop-blur transition hover:bg-white/10"
            aria-pressed={muted}
          >
            {muted ? "Muted" : "Voice on"}
          </button>
          {session?.googleConnected ? (
            <button
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                setSession({ ...session, googleConnected: false, email: null });
              }}
              className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1.5 text-xs text-emerald-300 backdrop-blur transition hover:bg-emerald-400/20"
              title={session.email ?? undefined}
            >
              Google
            </button>
          ) : (
            <a
              href="/api/auth/google"
              className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-slate-900 transition hover:bg-slate-200"
            >
              Connect Google
            </a>
          )}
        </div>
      </header>

      {mode === "avatar" ? (
        <main className="relative z-10 grid min-h-0 flex-1 gap-4 px-5 lg:grid-cols-[1fr_min(38%,420px)]">
          {/* --- her --- */}
          <section className="relative min-h-0">
            <div className="absolute inset-0">
              <Avatar mouthRef={mouthRef} state={avatarState} />
            </div>

            {/* what she just said, over the bottom of the stage */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-3 pb-2">
              {caption && (
                <p
                  className={`max-w-xl text-balance text-center text-[15px] leading-relaxed drop-shadow-[0_2px_12px_rgba(0,0,0,0.9)] transition ${
                    interim ? "italic text-sky-200/80" : "text-slate-100"
                  }`}
                >
                  {caption}
                </p>
              )}
              {thinking && (
                <div className="flex gap-1.5">
                  {[0, 150, 300].map((d) => (
                    <span
                      key={d}
                      className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
                      style={{ animationDelay: `${d}ms` }}
                    />
                  ))}
                </div>
              )}
              {/* on small screens the cards live under the caption */}
              {!!lastAssistant?.cards?.length && (
                <div className="pointer-events-auto w-full max-w-md space-y-2 lg:hidden">
                  {lastAssistant.cards.slice(0, 2).map((card, i) => (
                    <CardView key={i} card={card} />
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* --- conversation --- */}
          <aside className="hidden min-h-0 flex-col lg:flex">
            <TranscriptList turns={turns} listRef={transcriptRef} fadeTop />
          </aside>
        </main>
      ) : (
        <main className="relative z-10 mx-auto flex w-full min-h-0 max-w-2xl flex-1 flex-col px-5">
          <TranscriptList turns={turns} listRef={transcriptRef} />
          {interim && (
            <p className="pb-2 text-right text-sm italic text-sky-200/70">{interim}</p>
          )}
          {thinking && (
            <div className="flex gap-1.5 pb-2">
              {[0, 150, 300].map((d) => (
                <span
                  key={d}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
                  style={{ animationDelay: `${d}ms` }}
                />
              ))}
            </div>
          )}
        </main>
      )}

      {shownError && (
        <p className="relative z-20 mx-5 mb-2 rounded-xl border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-200 backdrop-blur">
          {shownError}
        </p>
      )}
      {!supported && (
        <p className="relative z-20 mx-5 mb-2 rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs text-amber-200 backdrop-blur">
          Speech recognition needs Chrome or Edge — you can still type below.
        </p>
      )}

      <footer className="relative z-20 flex flex-col items-center gap-3 px-5 pb-6 pt-2">
        <div className="flex items-center gap-4">
          <button
            onClick={toggleHandsFree}
            className={`rounded-full border px-3 py-1.5 text-xs transition ${
              handsFree
                ? "border-indigo-400/40 bg-indigo-400/15 text-indigo-200"
                : "border-white/10 text-slate-400 hover:bg-white/5"
            }`}
          >
            Hands-free
          </button>

          <button
            onClick={onMicClick}
            aria-label={listening ? "Stop listening" : "Start listening"}
            disabled={thinking}
            className={`relative flex h-16 w-16 items-center justify-center rounded-full transition disabled:opacity-40 ${
              listening
                ? "bg-rose-500 shadow-[0_0_36px_rgba(244,63,94,0.45)]"
                : speaking
                  ? "bg-slate-700"
                  : "bg-indigo-500 shadow-[0_0_36px_rgba(99,102,241,0.45)] hover:bg-indigo-400"
            }`}
          >
            {listening && <span className="absolute inset-0 animate-ping rounded-full bg-rose-500/40" />}
            {speaking ? (
              <svg viewBox="0 0 24 24" className="relative h-6 w-6 fill-white" aria-hidden>
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="relative h-7 w-7 fill-white" aria-hidden>
                <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z" />
                <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V21a1 1 0 1 0 2 0v-3.08A7 7 0 0 0 19 11Z" />
              </svg>
            )}
          </button>

          <div className="w-[86px]" />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const text = typed.trim();
            if (!text || thinking) return;
            setTyped("");
            void send(text);
          }}
          className="flex w-full max-w-md gap-2"
        >
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="…or type instead"
            className="flex-1 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm outline-none backdrop-blur placeholder:text-slate-600 focus:border-indigo-400/50"
          />
          <button
            type="submit"
            disabled={thinking || !typed.trim()}
            className="rounded-full bg-white/10 px-4 py-2 text-sm backdrop-blur transition hover:bg-white/20 disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}
