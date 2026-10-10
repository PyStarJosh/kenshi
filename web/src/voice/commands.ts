// Voice commands (pure): recognized text to a VoiceIntent by simple keyword matching, plus the phrases
// spoken back. Order matters: the first rule that matches wins.
import { CONFIG } from '../core/config'
import type { VoiceIntent } from '../core/types'

const RULES: { intent: VoiceIntent; pattern: RegExp }[] = [
  { intent: 'describe', pattern: /\b(describe|what do you see|what can you see)\b/ },
  { intent: 'help', pattern: /\b(help|commands|what can i say|options)\b/ },
  { intent: 'repeat', pattern: /\b(repeat|again|say that|last one|what was that)\b/ },
  { intent: 'slower', pattern: /\b(slower|slow down|too fast|speak slower)\b/ },
  { intent: 'faster', pattern: /\b(faster|speed up|too slow|speak faster)\b/ },
  { intent: 'resume', pattern: /\b(resume|continue|start|restart|go on|unpause)\b/ },
  { intent: 'pause', pattern: /\b(pause|stop|hold on|wait)\b/ },
  { intent: 'whats-around', pattern: /\b(around|here|near|nearby|front|ahead|surroundings|whats up)\b/ },
]

/** Map recognized text to an intent; anything not matched is 'unknown'. */
export function parseCommand(text: string): VoiceIntent {
  const normalized = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return 'unknown'
  return RULES.find((rule) => rule.pattern.test(normalized))?.intent ?? 'unknown'
}

/** New speech rate after "slower" or "faster", kept inside the allowed range. */
export function stepSpeechRate(rate: number, direction: 'slower' | 'faster'): number {
  const { speechRateMin, speechRateMax, speechRateStep } = CONFIG.audio
  const next = rate + (direction === 'faster' ? speechRateStep : -speechRateStep)
  // Round away floating point drift (1 - 0.2 - 0.2 ...).
  return Math.round(Math.min(speechRateMax, Math.max(speechRateMin, next)) * 100) / 100
}

export const VOICE_PHRASES = {
  unavailable: 'Voice commands unavailable. Tap to hear what\'s around you.',
  notUnderstood: 'Sorry, I didn\'t catch that.',
  paused: 'Paused.',
  resumed: 'Resuming.',
  slower: 'Slower.',
  faster: 'Faster.',
  slowestReached: 'Slowest speed.',
  fastestReached: 'Fastest speed.',
  nothingToRepeat: 'Nothing to repeat yet.',
  describeSoon: 'Describe is not available yet.',
  aroundSoon: 'What\'s around me is not available yet.',
  help: 'Tap, then say: what\'s around me, pause, resume, repeat, slower, faster, or help. If I hear nothing, tapping alone tells you what\'s around. Hold for one second to pause or resume. This does not replace your cane.',
} as const
