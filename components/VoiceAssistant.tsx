"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

type Turn = { role: "user" | "assistant"; content: string };
type Action = { tool: string; input: unknown; ok: boolean };
type SessionInfo = { googleConnected: boolean; email: string | null; anthropicConfigured: boolean };

const TOOL_LABELS: Record<string, string> = {
  get_current_time: "checked the time",
  list_calendar_events: "read your calendar",
  create_calendar_event: "created an event",
  delete_calendar_event: "deleted an event",
  search_email: "searched your inbox",
  read_email: "read an email",
  create_email_draft: "saved a draft",
  send_email: "sent an email",
  add_reminder: "added a reminder",
  list_reminders: "read your reminders",
  complete_reminder: "completed a reminder",
  delete_reminder: "deleted a reminder",
};

/** Mutable snapshot of the things async speech callbacks need, without stale closures. */
type Latest = {
  turns: Turn[];
  handsFree: boolean;
  muted: boolean;
  send: (text: string) => void;
  startListening: () => void;
};

export default function VoiceAssistant() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [actions, setActions] = useState<Record<number, Action[]>>({});
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

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, interim, thinking]);

  const speak = useCallback((text: string, onDone?: () => void) => {
    if (latest.current.muted || !window.speechSynthesis) {
      onDone?.();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    const voice = window.speechSynthesis
      .getVoices()
      .find((v) => v.lang.startsWith("en") && /Google (UK|US) English|Samantha|Natural/i.test(v.name));
    if (voice) utterance.voice = voice;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => {
      setSpeaking(false);
      onDone?.();
    };
    utterance.onerror = () => {
      setSpeaking(false);
      onDone?.();
    };
    window.speechSynthesis.speak(utterance);
  }, []);

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
            messages: next,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Request failed");

        const withReply: Turn[] = [...next, { role: "assistant", content: data.reply }];
        latest.current.turns = withReply;
        setTurns(withReply);
        if (data.actions?.length) {
          setActions((a) => ({ ...a, [withReply.length - 1]: data.actions }));
        }
        setThinking(false);
        speak(data.reply, () => {
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

  const busy = thinking || speaking;
  const shownError = error ?? authError;
  const statusText = thinking
    ? "Thinking…"
    : speaking
      ? "Speaking…"
      : listening
        ? interim || "Listening…"
        : handsFree
          ? "Hands-free on"
          : "Tap to talk";

  return (
    <div className="flex min-h-dvh flex-col bg-[#0b0f17] text-slate-100">
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
        <div>
          <h1 className="text-base font-semibold tracking-tight">Ava</h1>
          <p className="text-xs text-slate-400">Voice personal assistant</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMuted((m) => !m)}
            className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-white/5"
            aria-pressed={muted}
          >
            {muted ? "Voice off" : "Voice on"}
          </button>
          {session?.googleConnected ? (
            <button
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                setSession({ ...session, googleConnected: false, email: null });
              }}
              className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs text-emerald-300 transition hover:bg-emerald-400/20"
              title={session.email ?? undefined}
            >
              Google connected
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

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-6">
        {turns.length === 0 && (
          <div className="mx-auto max-w-md space-y-3 pt-10 text-center">
            <p className="text-sm text-slate-400">Try saying</p>
            <ul className="space-y-2 text-sm text-slate-300">
              <li>&ldquo;What&rsquo;s on my calendar tomorrow?&rdquo;</li>
              <li>&ldquo;Any unread email from this week?&rdquo;</li>
              <li>&ldquo;Book a dentist appointment Friday at 3pm.&rdquo;</li>
              <li>&ldquo;Remind me to call mum tonight.&rdquo;</li>
            </ul>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className={turn.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div className="max-w-[85%] space-y-1.5">
              <div
                className={
                  turn.role === "user"
                    ? "rounded-2xl rounded-br-sm bg-indigo-500 px-4 py-2.5 text-sm text-white"
                    : "rounded-2xl rounded-bl-sm bg-white/5 px-4 py-2.5 text-sm text-slate-100"
                }
              >
                {turn.content}
              </div>
              {actions[i]?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {actions[i].map((action, j) => (
                    <span
                      key={j}
                      className={`rounded-full px-2 py-0.5 text-[11px] ${
                        action.ok ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300"
                      }`}
                    >
                      {TOOL_LABELS[action.tool] ?? action.tool}
                      {action.ok ? "" : " (failed)"}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ))}

        {interim && (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-indigo-400/30 px-4 py-2.5 text-sm text-indigo-200/70">
              {interim}
            </div>
          </div>
        )}

        {thinking && (
          <div className="flex justify-start">
            <div className="flex gap-1 rounded-2xl rounded-bl-sm bg-white/5 px-4 py-3">
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {shownError && (
        <p className="mx-5 mb-3 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
          {shownError}
        </p>
      )}

      {!supported && (
        <p className="mx-5 mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          Speech recognition needs Chrome or Edge. You can still type below.
        </p>
      )}

      <footer className="space-y-4 border-t border-white/10 px-5 pb-8 pt-6">
        <div className="flex flex-col items-center gap-3">
          <button
            onClick={listening ? stopListening : startListening}
            disabled={busy}
            aria-label={listening ? "Stop listening" : "Start listening"}
            className={`relative flex h-20 w-20 items-center justify-center rounded-full transition disabled:opacity-40 ${
              listening ? "bg-rose-500" : "bg-indigo-500 hover:bg-indigo-400"
            }`}
          >
            {listening && <span className="absolute inset-0 animate-ping rounded-full bg-rose-500/40" />}
            <svg viewBox="0 0 24 24" className="relative h-8 w-8 fill-white" aria-hidden>
              <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z" />
              <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V21a1 1 0 1 0 2 0v-3.08A7 7 0 0 0 19 11Z" />
            </svg>
          </button>
          <p className="h-5 text-center text-xs text-slate-400">{statusText}</p>
          <button
            onClick={toggleHandsFree}
            className={`rounded-full border px-3 py-1 text-xs transition ${
              handsFree
                ? "border-indigo-400/40 bg-indigo-400/15 text-indigo-200"
                : "border-white/10 text-slate-400 hover:bg-white/5"
            }`}
          >
            Hands-free {handsFree ? "on" : "off"}
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const text = typed.trim();
            if (!text || busy) return;
            setTyped("");
            void send(text);
          }}
          className="flex gap-2"
        >
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="…or type instead"
            className="flex-1 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none placeholder:text-slate-500 focus:border-indigo-400/50"
          />
          <button
            type="submit"
            disabled={busy || !typed.trim()}
            className="rounded-full bg-white/10 px-4 py-2 text-sm transition hover:bg-white/20 disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}
