"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type FaceStatus =
  | "unconfigured" // no DID_API_KEY on the server
  | "no-face" // key present, but no portrait uploaded yet
  | "idle" // ready to connect
  | "connecting"
  | "live" // stream up, she is watching
  | "speaking"
  | "error";

/** How many utterances D-ID will hold for one stream before rejecting the next. */
const MAX_PENDING = 2;

type Api = { action: string; [k: string]: unknown };

async function didApi<T = Record<string, unknown>>(payload: Api): Promise<T> {
  const res = await fetch("/api/did", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

/**
 * Holds a D-ID Talks Stream: a photoreal face delivered as a live WebRTC video track.
 *
 * A reply arrives as several `speak()` calls — one per sentence, as the model writes
 * them — so she starts talking before the answer is finished. `endTurn()` marks the
 * last sentence as sent; the turn is only over once every utterance has played, which
 * is what re-opens the mic in hands-free mode.
 */
export function useDidStream(onSpeechEnd?: () => void) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<{ id: string; sessionId: string } | null>(null);
  const connectingRef = useRef<Promise<void> | null>(null);
  const endCallbackRef = useRef(onSpeechEnd);

  // D-ID accepts only a couple of un-rendered utterances per stream, so queue them
  // here: one plays while the next renders, and nothing is dropped.
  const queueRef = useRef<string[]>([]);
  const inFlightRef = useRef(0);
  const pumpingRef = useRef(false);
  const turnOpenRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  const [status, setStatus] = useState<FaceStatus>("idle");
  const [face, setFace] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    endCallbackRef.current = onSpeechEnd;
  }, [onSpeechEnd]);

  useEffect(() => {
    fetch("/api/did/face")
      .then((r) => r.json())
      .then((d) => {
        setFace(d.preview ?? null);
        setStatus(!d.configured ? "unconfigured" : d.hasFace ? "idle" : "no-face");
      })
      .catch(() => undefined);
  }, []);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current = [];
  }, []);

  /** The turn is done only when nothing is queued and no more sentences are coming. */
  const settle = useCallback(() => {
    if (inFlightRef.current > 0 || queueRef.current.length > 0 || turnOpenRef.current) return;
    clearTimers();
    setStatus((s) => (s === "speaking" ? "live" : s));
    endCallbackRef.current?.();
  }, [clearTimers]);

  const pumpRef = useRef<() => void>(() => undefined);

  const utteranceFinished = useCallback(() => {
    inFlightRef.current = Math.max(0, inFlightRef.current - 1);
    pumpRef.current();
    settle();
  }, [settle]);

  const teardown = useCallback(() => {
    clearTimers();
    queueRef.current = [];
    inFlightRef.current = 0;
    pumpingRef.current = false;
    turnOpenRef.current = false;
    channelRef.current?.close();
    channelRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    const open = streamRef.current;
    streamRef.current = null;
    if (open) void didApi({ action: "close", ...open }).catch(() => undefined);
  }, [clearTimers]);

  const connect = useCallback(async () => {
    if (streamRef.current && pcRef.current?.connectionState === "connected") return;
    if (connectingRef.current) return connectingRef.current;

    const run = (async () => {
      setStatus("connecting");
      setError(null);

      const { id, sessionId, offer, iceServers } = await didApi<{
        id: string;
        sessionId: string;
        offer: RTCSessionDescriptionInit;
        iceServers: RTCIceServer[];
      }>({ action: "create" });

      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;
      streamRef.current = { id, sessionId };

      // D-ID reports speech start/end over this channel; the name is part of their protocol.
      const channel = pc.createDataChannel("JanusDataChannel");
      channelRef.current = channel;
      channel.onmessage = (event) => {
        const message = String(event.data);
        if (message.startsWith("stream/started")) setStatus("speaking");
        if (message.startsWith("stream/done")) utteranceFinished();
      };

      pc.onicecandidate = (event) => {
        const c = event.candidate;
        void didApi({
          action: "ice",
          id,
          sessionId,
          candidate: c
            ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex }
            : {},
        }).catch(() => undefined);
      };

      pc.ontrack = (event) => {
        const video = videoRef.current;
        if (video && event.streams[0]) {
          video.srcObject = event.streams[0];
          void video.play().catch(() => undefined);
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === "connected") setStatus((s) => (s === "speaking" ? s : "live"));
        if (state === "failed" || state === "closed" || state === "disconnected") {
          teardown();
          setStatus("idle");
        }
      };

      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await didApi({ action: "sdp", id, sessionId, answer });
    })();

    connectingRef.current = run;
    try {
      await run;
    } catch (e) {
      teardown();
      setStatus("error");
      setError(e instanceof Error ? e.message : "Could not start the video stream");
      throw e;
    } finally {
      connectingRef.current = null;
    }
  }, [teardown, utteranceFinished]);

  /** Open the stream ahead of time so the first sentence does not wait on a handshake. */
  const prewarm = useCallback(() => {
    if (status === "unconfigured" || status === "no-face") return;
    void connect().catch(() => undefined);
  }, [connect, status]);

  const beginTurn = useCallback(() => {
    turnOpenRef.current = true;
  }, []);

  const endTurn = useCallback(() => {
    turnOpenRef.current = false;
    settle();
  }, [settle]);

  /** Sends queued lines while D-ID has room for them. */
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (inFlightRef.current < MAX_PENDING && queueRef.current.length > 0) {
        const text = queueRef.current[0];
        try {
          await connect();
          const open = streamRef.current;
          if (!open) throw new Error("Stream is not open");
          await didApi({ action: "talk", ...open, text });
        } catch (e) {
          const message = e instanceof Error ? e.message : "She could not speak";
          if (/pending requests limit/i.test(message)) {
            // Her queue upstream is full; try this same line again shortly.
            timersRef.current.push(window.setTimeout(() => void pumpRef.current(), 600));
            return;
          }
          queueRef.current.shift();
          setStatus("error");
          setError(message);
          continue;
        }

        queueRef.current.shift();
        inFlightRef.current += 1;
        setStatus("speaking");

        // Safety net: if a done-event never arrives, release on an estimate of how long
        // the line takes to say (~14 characters a second) plus slack.
        timersRef.current.push(
          window.setTimeout(utteranceFinished, (text.length / 14) * 1000 + 8000),
        );
      }
    } finally {
      pumpingRef.current = false;
    }
    settle();
  }, [connect, settle, utteranceFinished]);

  useEffect(() => {
    pumpRef.current = () => void pump();
  }, [pump]);

  const speak = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      queueRef.current.push(text.trim());
      await pump();
    },
    [pump],
  );

  const uploadFace = useCallback(
    async (file: File) => {
      setError(null);
      const form = new FormData();
      form.append("image", file);
      const res = await fetch("/api/did/face", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Upload failed");
        return;
      }
      // A new portrait means the open stream is showing the wrong person.
      teardown();
      // Cache-bust so the browser does not keep showing the previous photo.
      setFace(`${data.preview}?v=${Date.now()}`);
      setStatus("idle");
    },
    [teardown],
  );

  useEffect(() => teardown, [teardown]);

  return {
    videoRef,
    status,
    face,
    error,
    speak,
    prewarm,
    beginTurn,
    endTurn,
    uploadFace,
    disconnect: teardown,
  };
}
