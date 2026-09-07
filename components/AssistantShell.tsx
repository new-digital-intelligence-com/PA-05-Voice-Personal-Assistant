"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";

// Rendered client-side only: the 3D canvas, the Web Speech API and the remembered
// avatar/chat preference all need the browser.
const VoiceAssistant = dynamic(() => import("./VoiceAssistant"), {
  ssr: false,
  loading: () => <div className="h-dvh bg-[#06080e]" />,
});

export default function AssistantShell() {
  return (
    <Suspense fallback={<div className="h-dvh bg-[#06080e]" />}>
      <VoiceAssistant />
    </Suspense>
  );
}
