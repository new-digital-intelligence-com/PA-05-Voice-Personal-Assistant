"use client";

import { useCallback, useEffect, useRef, useState } from "react";
// simli-client 3.0.2 ships dist/client.js but its index re-exports "./Client" with a
// capital C, which resolves on Windows and fails on any case-sensitive filesystem.
// Importing the module directly sidesteps the broken barrel file.
import { LogLevel, SimliClient } from "simli-client/dist/client";

export type FaceStatus =
  | "unconfigured" // no Simli key or face id on the server
  | "face-pending" // avatar accepted but still generating at Simli
  | "idle" // ready to connect
  | "connecting"
  | "live" // stream up, she is watching
  | "speaking"
  | "error";

/** Simli expects 16-bit PCM at 16kHz; keep chunks sample-aligned. */
const CHUNK_BYTES = 4096;
/** Backoff before retrying a connection that failed, so a hard failure cannot spin. */
const RECONNECT_MS = 15_000;

/**
 * Holds a Simli session: a photoreal face lip-syncing to audio we push at it.
 *
 * The whole reply is spoken as one continuous PCM stream rather than a sequence of
 * rendered clips, so there are no seams and nothing to queue. `endTurn()` marks the
 * last audio as sent; the turn is over when she falls silent, which is what re-opens
 * the mic in hands-free mode.
 */
export function useSimliStream(onSpeechEnd?: () => void) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const clientRef = useRef<SimliClient | null>(null);
  const connectingRef = useRef<Promise<void> | null>(null);
  const failuresRef = useRef(0);
  const turnOpenRef = useRef(false);
  const sendingRef = useRef(0);
  const endCallbackRef = useRef(onSpeechEnd);

  const [status, setStatus] = useState<FaceStatus>("idle");
  const [configured, setConfigured] = useState(true);

  const report = (message: string) => console.warn("[Simli]", message);

  useEffect(() => {
    endCallbackRef.current = onSpeechEnd;
  }, [onSpeechEnd]);

  useEffect(() => {
    fetch("/api/simli")
      .then((r) => r.json())
      .then((d) => {
        const ready = Boolean(d.configured) && !d.faceProcessing;
        setConfigured(ready);
        setStatus(!d.configured ? "unconfigured" : d.faceProcessing ? "face-pending" : "idle");
      })
      .catch(() => undefined);
  }, []);

  /** The turn is over once she stops talking and no more audio is coming. */
  const settle = useCallback(() => {
    if (turnOpenRef.current || sendingRef.current > 0) return;
    setStatus((s) => (s === "speaking" ? "live" : s));
    endCallbackRef.current?.();
  }, []);

  const teardown = useCallback(() => {
    turnOpenRef.current = false;
    sendingRef.current = 0;
    const client = clientRef.current;
    clientRef.current = null;
    if (client) void client.stop().catch(() => undefined);
  }, []);

  const connect = useCallback(async () => {
    if (clientRef.current) return;
    if (connectingRef.current) return connectingRef.current;

    const run = (async () => {
      setStatus("connecting");

      const res = await fetch("/api/simli", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);

      const video = videoRef.current;
      const audio = audioRef.current;
      if (!video || !audio) throw new Error("Video element is not mounted yet");

      // LiveKit is Simli's default transport and relays through TURN when a network
      // blocks direct peer traffic; plain p2p times out behind stricter firewalls.
      const transport =
        process.env.NEXT_PUBLIC_SIMLI_TRANSPORT === "p2p" ? "p2p" : "livekit";

      const client = new SimliClient(
        data.sessionToken,
        video,
        audio,
        data.iceServers ?? null,
        LogLevel.ERROR,
        transport,
      );

      client.on("speaking", () => setStatus("speaking"));
      client.on("silent", () => {
        setStatus((s) => (s === "speaking" ? "live" : s));
        settle();
      });
      client.on("error", (detail: string) => report(String(detail)));
      client.on("startup_error", (detail: string) => report(String(detail)));
      client.on("stop", () => {
        clientRef.current = null;
        setStatus("idle");
      });

      await client.start();
      clientRef.current = client;
      failuresRef.current = 0;
      setStatus("live");
    })();

    connectingRef.current = run;
    try {
      await run;
    } catch (e) {
      failuresRef.current += 1;
      teardown();
      setStatus("idle"); // lets the reconnect effect try again after a pause
      report(e instanceof Error ? e.message : "Could not start the video stream");
      throw e;
    } finally {
      connectingRef.current = null;
    }
  }, [settle, teardown]);

  // Holding the session open costs nothing until she speaks, so stay connected and
  // reconnect quietly if it drops.
  useEffect(() => {
    if (status !== "idle" || !configured) return;
    const delay = failuresRef.current > 0 ? RECONNECT_MS : 0;
    const timer = window.setTimeout(() => {
      void connect().catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [status, configured, connect]);

  const beginTurn = useCallback(() => {
    turnOpenRef.current = true;
  }, []);

  const endTurn = useCallback(() => {
    turnOpenRef.current = false;
    settle();
  }, [settle]);

  /**
   * Speaks a line: fetches it as PCM and forwards the bytes to Simli as they arrive,
   * so her mouth starts moving before the sentence has finished synthesising.
   */
  const speak = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      sendingRef.current += 1;
      try {
        await connect();
        const client = clientRef.current;
        if (!client) throw new Error("Simli session is not open");

        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, format: "pcm" }),
        });
        if (!res.ok || !res.body) {
          const failed = await res.json().catch(() => ({}));
          throw new Error(failed.error ?? `Speech failed (${res.status})`);
        }

        const reader = res.body.getReader();
        // Carries the odd byte between reads so a 16-bit sample is never split.
        let carry = new Uint8Array(0);

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.length) continue;

          const merged = new Uint8Array(carry.length + value.length);
          merged.set(carry);
          merged.set(value, carry.length);

          const usable = merged.length - (merged.length % 2);
          for (let offset = 0; offset < usable; offset += CHUNK_BYTES) {
            const end = Math.min(offset + CHUNK_BYTES, usable);
            client.sendAudioData(merged.slice(offset, end));
          }
          carry = merged.slice(usable);
        }
      } catch (e) {
        report(e instanceof Error ? e.message : "She could not speak");
      } finally {
        sendingRef.current = Math.max(0, sendingRef.current - 1);
        settle();
      }
    },
    [connect, settle],
  );

  /** Cuts her off mid-sentence — used when the user starts talking again. */
  const interrupt = useCallback(() => {
    clientRef.current?.ClearBuffer();
    turnOpenRef.current = false;
    setStatus((s) => (s === "speaking" ? "live" : s));
  }, []);

  useEffect(() => {
    const release = () => teardown();
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, [teardown]);

  useEffect(() => teardown, [teardown]);

  return {
    videoRef,
    audioRef,
    status,
    configured,
    speak,
    beginTurn,
    endTurn,
    interrupt,
    disconnect: teardown,
  };
}
