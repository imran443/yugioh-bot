"use client";

import { useEffect, useRef } from "react";
import { useDraftStore } from "@/lib/stores/draft-store";

type BrowserAudioContext = typeof AudioContext;

function playTimerWarning() {
  try {
    const AudioContextCtor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: BrowserAudioContext }).webkitAudioContext;

    if (!AudioContextCtor) {
      return;
    }

    const audioContext = new AudioContextCtor();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.frequency.value = 880;
    gain.gain.value = 0.06;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.12);
  } catch {
    // Browsers can block audio before user interaction; the timer should keep working.
  }
}

export function useDraftCountdown() {
  const packRound = useDraftStore((s) => s.packRound);
  const pickStep = useDraftStore((s) => s.pickStep);
  const timerSeconds = useDraftStore((s) => s.timerSeconds);
  const completed = useDraftStore((s) => s.completed);
  const tick = useDraftStore((s) => s.tick);
  const warnedPickKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const pickKey = `${packRound}:${pickStep}`;

    if (completed || timerSeconds !== 10 || warnedPickKeyRef.current === pickKey) {
      return;
    }

    warnedPickKeyRef.current = pickKey;
    playTimerWarning();
  }, [completed, packRound, pickStep, timerSeconds]);

  useEffect(() => {
    if (completed || timerSeconds <= 0) {
      return;
    }

    const timeout = window.setTimeout(() => {
      tick();
    }, 1000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [completed, timerSeconds, tick]);
}
