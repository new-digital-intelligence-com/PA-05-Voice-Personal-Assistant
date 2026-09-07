import { Suspense } from "react";
import VoiceAssistant from "@/components/VoiceAssistant";

export default function Home() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-[#0b0f17]" />}>
      <VoiceAssistant />
    </Suspense>
  );
}
