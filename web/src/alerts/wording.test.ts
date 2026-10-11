// SR-2 across the whole app: nothing Kenshi says or shows may suggest the path is clear, safe, or free.
// This reads the wording of every module (read only), so a new sentence anywhere is checked too.
import { describe, expect, test } from 'vitest'
import { MESSAGES } from '../app/messages'
import { GREETING } from '../audio/unlock'
import { FIND_MESSAGES } from '../find/messages'
import {
  arrivedPhrase,
  directionPhrase,
  FIND_PHRASES,
  foundPhrase,
  lookingFor,
  lostPhrase,
  notFoundPhrase,
} from '../find/phrases'
import type { Direction } from '../find/phrases'
import { QUICK_PICKS } from '../find/targets'
import { HEALTH_PHRASES } from '../health/monitor'
import { VOICE_PHRASES } from '../voice/commands'

const DIRECTIONS: Direction[] = ['ahead', 'slightly-left', 'slightly-right', 'left', 'right', 'behind']

/** Every sentence Find can build, for every quick-pick target and every direction, with and without a sign. */
function findSentences(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pick of QUICK_PICKS) {
    const target = pick.toLowerCase()
    out[`looking ${target}`] = lookingFor(target)
    out[`lost ${target}`] = lostPhrase(target)
    out[`arrived ${target}`] = arrivedPhrase(target)
    out[`notFound ${target}`] = notFoundPhrase(target, null)
    out[`notFoundSign ${target}`] = notFoundPhrase(target, 'EXIT ->')
    for (const direction of DIRECTIONS) {
      out[`found ${target} ${direction}`] = foundPhrase(target, direction)
      out[`direction ${direction}`] = directionPhrase(direction)
    }
  }
  return out
}

const BANNED = /\b(clear|clearly|safe|safely|safety|free|all good|no obstacles?|nothing there|nothing ahead)\b/i

const sources: [string, Record<string, string> | string][] = [
  ['voice phrases', VOICE_PHRASES],
  ['health phrases', HEALTH_PHRASES],
  ['status messages', MESSAGES],
  ['greeting', { greeting: GREETING }],
  ['find messages', FIND_MESSAGES],
  ['find phrases', FIND_PHRASES],
  ['find phrases with every quick-pick target', findSentences()],
]

describe('SR-2 wording', () => {
  test.each(sources)('%s never say the path is clear, safe, or free', (_name, texts) => {
    const values = typeof texts === 'string' ? [texts] : Object.values(texts)
    expect(values.length).toBeGreaterThan(0)
    for (const text of values) expect(text).not.toMatch(BANNED)
  })

  test('the checker itself catches the phrases it is meant to forbid', () => {
    for (const bad of ['The path is clear.', 'It is safe to walk.', 'All good.', 'No obstacles ahead.', 'Path free.']) {
      expect(bad).toMatch(BANNED)
    }
  })

  test('the greeting says the app name as Ken-shee, not Navigator', () => {
    expect(GREETING).toMatch(/^Ken-shee\./)
    expect(GREETING).not.toMatch(/navigator/i)
  })
})
