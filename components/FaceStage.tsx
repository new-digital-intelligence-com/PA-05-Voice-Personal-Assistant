"use client";

import type { FaceStatus } from "./useSimliStream";

type Props = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  status: FaceStatus;
};

export default function FaceStage({ videoRef, audioRef, status }: Props) {
  const live = status === "live" || status === "speaking";

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <div className="relative aspect-square max-h-full max-w-full overflow-hidden rounded-3xl border border-white/10 bg-black/40 shadow-[0_0_80px_rgba(79,70,229,0.18)]">
        {/* The still portrait holds the frame until the live face takes over. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/face.png"
          alt=""
          className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-700 ${
            live ? "opacity-0" : "opacity-100"
          }`}
        />

        <video
          ref={videoRef}
          autoPlay
          playsInline
          className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-700 ${
            live ? "opacity-100" : "opacity-0"
          }`}
        />
        <audio ref={audioRef} autoPlay />

        {status === "face-pending" && (
          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 bg-gradient-to-t from-black/85 to-transparent px-6 pb-5 pt-12 text-center">
            <p className="text-sm text-slate-100">She is still being brought to life</p>
            <p className="max-w-sm text-xs leading-relaxed text-slate-400">
              Simli is generating her avatar from your photo. It usually takes a while;
              reload this page once it is done and she will start speaking.
            </p>
          </div>
        )}

        {status === "unconfigured" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 p-8 text-center backdrop-blur-sm">
            <p className="text-sm text-slate-200">Her face is not set up yet</p>
            <p className="max-w-xs text-xs leading-relaxed text-slate-400">
              Add <code className="text-slate-300">SIMLI_API_KEY</code> and{" "}
              <code className="text-slate-300">SIMLI_FACE_ID</code> to{" "}
              <code className="text-slate-300">.env.local</code>, then restart. Chat mode works
              without them.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
