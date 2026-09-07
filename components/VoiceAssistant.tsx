"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import FaceStage from "./FaceStage";
import CardView from "./Cards";
import { useDidStream } from "./useDidStream";
import type { Card } from "@/lib/cards";

type Mode = "face" | "chat";
type Turn = { role: "user" | "assistant"; content: string; cards?: Card[] };
type SessionInfo = { googleConnected: boolean; email: string | null; anthropicConfigured: boolean };

type Latest = {
  turns: Turn[];
  handsFree: boolean;
  muted: boolean;
  mode: Mode;
  send: (text: string) => void;
  startListening: () => void;
};

/** Her opening words go out as soon as this much text exists, mid-sentence if need be. */
const FIRST_UTTERANCE = 18;
/**
 * After she is already talking, prefer longer runs of whole sentences: each utterance
 * is a separate render at D-ID, and fewer, larger ones mean fewer seams in her speech.
 */
const MIN_UTTERANCE = 90;

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
  const [chatSpeaking, setChatSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [typed, setTyped] = useState("");
  const [mode, setMode] = useState<Mode>(() =>
    typeof window !== "undefined" && window.localStorage.getItem("pa_mode") === "chat"
      ? "chat"
      : "face",
  );

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const prewarmRef = useRef<(() => void) | null>(null);
  /** Set when the user (not the silence timer) ends the turn. */
  const stopRequestedRef = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const latest = useRef<Latest>({
    turns: [],
    handsFree: false,
    muted: false,
    mode: "face",
    send: () => undefined,
    startListening: () => undefined,
  });

  /** After she finishes a reply, re-open the mic if hands-free is on. */
  const onSpeechEnd = useCallback(() => {
    if (latest.current.handsFree) latest.current.startListening();
  }, []);

  const did = useDidStream(onSpeechEnd);

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

  /* ----------------------------------------------- chat-mode voice output */

  const speakWithBrowser = useCallback((text: string, onDone: () => void) => {
    if (!window.speechSynthesis) {
      onDone();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.02;
    utterance.pitch = 1.05;
    const voice = window.speechSynthesis
      .getVoices()
      .find((v) => v.lang.startsWith("en") && /female|zira|samantha|aria|natural/i.test(v.name));
    if (voice) utterance.voice = voice;
    utterance.onstart = () => setChatSpeaking(true);
    const finish = () => {
      setChatSpeaking(false);
      onDone();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
  }, []);

  const speakInChat = useCallback(
    async (text: string, onDone: () => void) => {
      if (latest.current.muted) {
        onDone();
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
        const url = URL.createObjectURL(await res.blob());
        const audio = new Audio(url);
        audioRef.current = audio;
        const finish = () => {
          URL.revokeObjectURL(url);
          audioRef.current = null;
          setChatSpeaking(false);
          onDone();
        };
        audio.onended = finish;
        audio.onerror = finish;
        setChatSpeaking(true);
        await audio.play();
      } catch {
        speakWithBrowser(text, onDone);
      }
    },
    [speakWithBrowser],
  );

  const stopSpeaking = useCallback(() => {
    window.speechSynthesis?.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setChatSpeaking(false);
  }, []);

  /* -------------------------------------------------------- speech input */

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
    recognition.continuous = true;
    recognition.maxAlternatives = 1;

    let finalText = "";
    let lastInterim = "";
    stopRequestedRef.current = false;

    recognition.onresult = (event) => {
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      lastInterim = interimText;
      setInterim(interimText);
    };

    recognition.onerror = (event) => {
      if (event.error !== "no-speech" && event.error !== "aborted") {
        setError(`Microphone error: ${event.error}`);
        stopRequestedRef.current = true;
        setHandsFree(false);
        latest.current.handsFree = false;
      }
    };

    recognition.onend = () => {
      // Nothing is sent until the mic button says so. Chrome stops listening by itself
      // after a few seconds of quiet, so simply start it again.
      if (!stopRequestedRef.current) {
        try {
          recognition.start();
          return;
        } catch {
          /* cannot restart — fall through and send what we have */
        }
      }

      recognitionRef.current = null;
      stopRequestedRef.current = false;
      setListening(false);
      setInterim("");
      const text = (finalText.trim() || lastInterim.trim()).trim();
      if (text) latest.current.send(text);
      else if (latest.current.handsFree) window.setTimeout(() => latest.current.startListening(), 400);
    };

    recognitionRef.current = recognition;
    setError(null);
    setListening(true);
    recognition.start();

    // Open the video stream while the user is still talking, so her first sentence
    // does not wait on a WebRTC handshake.
    if (latest.current.mode === "face") prewarmRef.current?.();
  }, []);

  const stopListening = useCallback(() => {
    setHandsFree(false);
    latest.current.handsFree = false;
    stopRequestedRef.current = true;
    recognitionRef.current?.stop();
  }, []);

  /* --------------------------------------------------------------- turns */

  /**
   * Splits a growing reply on sentence boundaries so each finished sentence can be
   * spoken while the next one is still being written.
   */
  const takeSentences = (buffer: string, atEnd: boolean): [string[], string] => {
    const out: string[] = [];
    let rest = buffer;
    const boundary = /[.!?…]["')\]]?\s+|\n+/;
    for (;;) {
      const match = boundary.exec(rest);
      if (!match) break;
      const cut = match.index + match[0].length;
      const sentence = rest.slice(0, cut).trim();
      if (sentence) out.push(sentence);
      rest = rest.slice(cut);
    }
    if (atEnd && rest.trim()) {
      out.push(rest.trim());
      rest = "";
    }
    return [out, rest];
  };

  const send = useCallback(
    async (text: string) => {
      const next: Turn[] = [...latest.current.turns, { role: "user", content: text }];
      latest.current.turns = next;
      setTurns(next);
      setThinking(true);
      setError(null);

      const face = latest.current.mode === "face" && !latest.current.muted;
      if (face) did.beginTurn();

      let spoken = "";
      let buffer = "";
      // Each utterance is a separate render request, so avoid firing off "Hello!" on
      // its own — group finished sentences until there is a worthwhile chunk.
      let chunk = "";
      let full = "";
      let cards: Card[] = [];

      const paint = () => {
        const withReply: Turn[] = [...next, { role: "assistant", content: full, cards }];
        latest.current.turns = withReply;
        setTurns(withReply);
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: next.map(({ role, content }) => ({ role, content })),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        });

        if (!res.ok || !res.body) {
          const failed = await res.json().catch(() => ({}));
          throw new Error(failed.error ?? `Request failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let carry = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          carry += decoder.decode(value, { stream: true });

          const frames = carry.split("\n\n");
          carry = frames.pop() ?? "";

          for (const frame of frames) {
            const line = frame.trim();
            if (!line.startsWith("data:")) continue;
            const event = JSON.parse(line.slice(5).trim());

            if (event.type === "text") {
              setThinking(false);
              full += event.delta;
              buffer += event.delta;
              paint();
              if (face) {
                const [sentences, rest] = takeSentences(buffer, false);
                buffer = rest;
                for (const sentence of sentences) {
                  chunk = chunk ? `${chunk} ${sentence}` : sentence;
                }

                // Nothing said yet: cut at the latest word boundary rather than wait
                // for a full stop, so she opens her mouth about a second sooner.
                if (!spoken && !chunk && buffer.length >= FIRST_UTTERANCE) {
                  const cut = buffer.lastIndexOf(" ");
                  if (cut >= FIRST_UTTERANCE - 4) {
                    chunk = buffer.slice(0, cut).trim();
                    buffer = buffer.slice(cut);
                  }
                }

                if (chunk && (!spoken || chunk.length >= MIN_UTTERANCE)) {
                  spoken += chunk;
                  void did.speak(chunk);
                  chunk = "";
                }
              }
            } else if (event.type === "cards") {
              cards = [...cards, ...event.cards];
              paint();
            } else if (event.type === "error") {
              throw new Error(event.error);
            } else if (event.type === "done") {
              full = event.reply ?? full;
              cards = event.cards ?? cards;
              paint();
            }
          }
        }

        setThinking(false);

        if (face) {
          // Anything left after the last sentence boundary.
          const [tail] = takeSentences(buffer, true);
          for (const sentence of tail) {
            chunk = chunk ? `${chunk} ${sentence}` : sentence;
          }
          if (chunk.trim()) {
            spoken += chunk;
            void did.speak(chunk);
          }
          if (!spoken.trim() && full.trim()) void did.speak(full);
          did.endTurn();
        } else {
          void speakInChat(full, onSpeechEnd);
        }
      } catch (e) {
        setThinking(false);
        if (face) did.endTurn();
        setError(e instanceof Error ? e.message : "Something went wrong");
        setHandsFree(false);
        latest.current.handsFree = false;
      }
    },
    [did, speakInChat, onSpeechEnd],
  );

  useEffect(() => {
    prewarmRef.current = did.prewarm;
  }, [did.prewarm]);

  useEffect(() => {
    latest.current = {
      turns,
      handsFree,
      muted,
      mode,
      send: (t) => void send(t),
      startListening,
    };
  }, [turns, handsFree, muted, mode, send, startListening]);

  /* ----------------------------------------------------------------- ui */

  const speaking = mode === "face" ? did.status === "speaking" : chatSpeaking;
  const busy = thinking || speaking;

  const toggleHandsFree = () => {
    if (handsFree) {
      setHandsFree(false);
      latest.current.handsFree = false;
      stopRequestedRef.current = true;
      recognitionRef.current?.stop();
    } else {
      setHandsFree(true);
      latest.current.handsFree = true;
      startListening();
    }
  };

  const onMicClick = () => {
    if (speaking) {
      if (mode === "chat") stopSpeaking();
      return;
    }
    if (listening) stopListening();
    else startListening();
  };

  const changeMode = (next: Mode) => {
    setMode(next);
    latest.current.mode = next;
    stopSpeaking();
    if (next === "chat") did.disconnect();
    try {
      window.localStorage.setItem("pa_mode", next);
    } catch {
      /* private mode */
    }
  };

  const lastAssistant = useMemo(
    () => [...turns].reverse().find((t) => t.role === "assistant"),
    [turns],
  );
  const caption = interim || (thinking ? "" : lastAssistant?.content) || "";
  const shownError = error ?? authError;

  const statusText = thinking
    ? "Thinking"
    : speaking
      ? "Speaking"
      : listening
        ? "Listening"
        : did.status === "connecting" && mode === "face"
          ? "Connecting"
          : handsFree
            ? "Hands-free · the mic re-opens after each reply"
            : "Tap the mic and talk";

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[#06080e] text-slate-100">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[38%] h-[75vmin] w-[75vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-600/20 blur-[110px]" />
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
            {(["face", "chat"] as const).map((m) => (
              <button
                key={m}
                onClick={() => changeMode(m)}
                aria-pressed={mode === m}
                className={`rounded-full px-3 py-1 transition ${
                  mode === m ? "bg-white/15 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {m === "face" ? "Face" : "Chat"}
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

      <main
        className={`relative z-10 min-h-0 flex-1 gap-4 px-5 ${
          mode === "face"
            ? "grid lg:grid-cols-[1fr_min(38%,420px)]"
            : "mx-auto flex w-full max-w-2xl flex-col"
        }`}
      >
        <section className="relative flex min-h-0 flex-col">
          {mode === "face" ? (
            <div className="min-h-0 flex-1 pb-2">
              <FaceStage
                videoRef={did.videoRef}
                status={did.status}
                face={did.face}
                error={did.error}
                onUpload={did.uploadFace}
              />
            </div>
          ) : (
            <TranscriptList turns={turns} listRef={transcriptRef} />
          )}

          {mode === "face" && (
            <div className="pointer-events-none flex flex-col items-center gap-2 pb-1">
              {/* Wide screens read the conversation in the panel beside her, so the
                  caption would only repeat it. Narrow screens have no panel. */}
              {caption && (
                <p
                  className={`max-w-xl text-balance text-center text-[15px] leading-relaxed drop-shadow-[0_2px_12px_rgba(0,0,0,0.9)] lg:hidden ${
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
              {!!lastAssistant?.cards?.length && (
                <div className="pointer-events-auto w-full max-w-md space-y-2 lg:hidden">
                  {lastAssistant.cards.slice(0, 2).map((card, i) => (
                    <CardView key={i} card={card} />
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {mode === "face" && (
          <aside className="hidden min-h-0 flex-col lg:flex">
            <TranscriptList turns={turns} listRef={transcriptRef} fadeTop />
          </aside>
        )}
      </main>

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
            aria-label={listening ? "Send what you said" : "Start listening"}
            disabled={thinking || (speaking && mode === "face")}
            className={`relative flex h-16 w-16 items-center justify-center rounded-full transition disabled:opacity-40 ${
              listening
                ? "bg-rose-500 shadow-[0_0_36px_rgba(244,63,94,0.45)]"
                : "bg-indigo-500 shadow-[0_0_36px_rgba(99,102,241,0.45)] hover:bg-indigo-400"
            }`}
          >
            {listening && <span className="absolute inset-0 animate-ping rounded-full bg-rose-500/40" />}
            {listening ? (
              // Send arrow: tapping again is what submits the turn.
              <svg viewBox="0 0 24 24" className="relative h-7 w-7 fill-white" aria-hidden>
                <path d="M3.4 20.4 21 12 3.4 3.6 3.39 10l12.6 2-12.6 2z" />
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
            if (!text || busy) return;
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
            disabled={busy || !typed.trim()}
            className="rounded-full bg-white/10 px-4 py-2 text-sm backdrop-blur transition hover:bg-white/20 disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}
