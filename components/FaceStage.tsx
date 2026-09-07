"use client";

import { useRef } from "react";
import type { FaceStatus } from "./useDidStream";

type Props = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  status: FaceStatus;
  face: string | null;
  error: string | null;
  onUpload: (file: File) => void | Promise<void>;
};

export default function FaceStage({ videoRef, status, face, error, onUpload }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = () => fileRef.current?.click();

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void onUpload(file);
        }}
      />

      <div className="relative aspect-[3/4] h-full max-h-full overflow-hidden rounded-3xl border border-white/10 bg-black/40 shadow-[0_0_80px_rgba(79,70,229,0.18)]">
        {/* The still portrait sits underneath so she is visible before the stream is up. */}
        {face && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={face}
            alt=""
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
              status === "live" || status === "speaking" ? "opacity-0" : "opacity-100"
            }`}
          />
        )}

        <video
          ref={videoRef}
          autoPlay
          playsInline
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
            status === "live" || status === "speaking" ? "opacity-100" : "opacity-0"
          }`}
        />

        {status === "connecting" && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-gradient-to-t from-black/80 to-transparent pb-4 pt-10 text-xs text-slate-300">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-indigo-400" />
            Waking her up…
          </div>
        )}

        {status === "unconfigured" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-8 text-center">
            <p className="text-sm text-slate-200">No D-ID key yet</p>
            <p className="max-w-xs text-xs leading-relaxed text-slate-400">
              Add <code className="text-slate-300">DID_API_KEY</code> to{" "}
              <code className="text-slate-300">.env.local</code> and restart the dev server to give
              her a face. Chat mode works without it.
            </p>
          </div>
        )}

        {status === "no-face" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-sm text-slate-200">Who should she look like?</p>
            <p className="max-w-xs text-xs leading-relaxed text-slate-400">
              Upload a front-facing portrait — one face, eyes open, cropped close. It must be your
              own photo, someone who agreed, or an AI-generated face.
            </p>
            <button
              onClick={pick}
              className="mt-1 rounded-full bg-white px-4 py-2 text-xs font-medium text-slate-900 transition hover:bg-slate-200"
            >
              Choose a photo
            </button>
          </div>
        )}

        {face && status !== "no-face" && (
          <button
            onClick={pick}
            className="absolute right-3 top-3 rounded-full border border-white/15 bg-black/50 px-3 py-1.5 text-[11px] text-slate-300 backdrop-blur transition hover:bg-black/70"
          >
            Change face
          </button>
        )}
      </div>

      {error && (
        <p className="absolute inset-x-4 bottom-2 rounded-lg border border-rose-400/30 bg-rose-500/15 px-3 py-2 text-center text-xs text-rose-100 backdrop-blur">
          {error}
        </p>
      )}
    </div>
  );
}
