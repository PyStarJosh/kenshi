// SR-2 across the whole app: nothing Kenshi says or shows may suggest the path is clear, safe, or free.
// This reads the wording of every module (read only), so a new sentence anywhere is checked too.
import { describe, expect, test } from 'vitest'
import { MESSAGES } from '../app/messages'
import { GREETING } from '../audio/unlock'
import { HEALTH_PHRASES } from '../health/monitor'
import { VOICE_PHRASES } from '../voice/commands'
import { SUMMARY_NONE } from './phrases'

const BANNED = /\b(clear|clearly|safe|safely|safety|free|all good|no obstacles?|nothing there|nothing ahead)\b/i

const sources: [string, Record<string, string> | string][] = [
  ['alert phrases', { none: SUMMARY_NONE }],
  ['voice phrases', VOICE_PHRASES],
  ['health phrases', HEALTH_PHRASES],
  ['status messages', MESSAGES],
  ['greeting', { greeting: GREETING }],
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

  test('the none-detected answer states a limit and points back to the cane', () => {
    expect(SUMMARY_NONE).toMatch(/miss things/)
    expect(SUMMARY_NONE).toMatch(/cane/)
  })

  test('the greeting says the app name as Ken-shee, not Navigator', () => {
    expect(GREETING).toMatch(/^Ken-shee\./)
    expect(GREETING).not.toMatch(/navigator/i)
  })
})
