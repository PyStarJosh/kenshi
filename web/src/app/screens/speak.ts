// Minimal speech for the setup screens. The audio engine (step U1) will own spoken alerts; this only
// reads out calibration steps and results.

export function speak(text: string, rate = 1): void {
  const synth = window.speechSynthesis
  if (!synth) return
  synth.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = rate
  synth.speak(utterance)
}

export function stopSpeaking(): void {
  window.speechSynthesis?.cancel()
}
