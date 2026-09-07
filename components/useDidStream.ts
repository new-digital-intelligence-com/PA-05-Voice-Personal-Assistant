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
 * Holds a D-ID Talks Stream: a photoreal face delivered as a live WebRTC video
 * track. `speak()` connects on first use and reuses the stream after that, since
 * an open stream is what costs credits.
 */
export function useDidStream(onSpeechEnd?: () => void) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<{ id: string; sessionId: string } | null>(null);
  const connectingRef = useRef<Promise<void> | null>(null);
  const endTimerRef = useRef<number | null>(null);
  const endCallbackRef = useRef(onSpeechEnd);

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
        setFace(d.face ?? null);
        setStatus(!d.configured ? "unconfigured" : d.face ? "idle" : "no-face");
      })
      .catch(() => undefined);
  }, []);

  const finishSpeaking = useCallback(() => {
    if (endTimerRef.current !== null) {
      window.clearTimeout(endTimerRef.current);
      endTimerRef.current = null;
    }
    setStatus((s) => (s === "speaking" ? "live" : s));
    endCallbackRef.current?.();
  }, []);

  const teardown = useCallback(() => {
    channelRef.current?.close();
    channelRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    const open = streamRef.current;
    streamRef.current = null;
    if (open) void didApi({ action: "close", ...open }).catch(() => undefined);
  }, []);

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
        if (message.startsWith("stream/done")) finishSpeaking();
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
  }, [finishSpeaking, teardown]);

  const speak = useCallback(
    async (text: string) => {
      try {
        await connect();
        const open = streamRef.current;
        if (!open) throw new Error("Stream is not open");
        setStatus("speaking");
        await didApi({ action: "talk", ...open, text });

        // Safety net: if the done-event never arrives, release on an estimate of how
        // long the line takes to say (~14 characters a second) plus a little slack.
        if (endTimerRef.current !== null) window.clearTimeout(endTimerRef.current);
        endTimerRef.current = window.setTimeout(finishSpeaking, (text.length / 14) * 1000 + 6000);
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "She could not speak");
        endCallbackRef.current?.();
      }
    },
    [connect, finishSpeaking],
  );

  const uploadFace = useCallback(async (file: File) => {
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
    setFace(data.face);
    setStatus("idle");
  }, [teardown]);

  useEffect(() => teardown, [teardown]);

  return { videoRef, status, face, error, speak, connect, uploadFace, disconnect: teardown };
}
