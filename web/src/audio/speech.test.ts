import { describe, expect, test } from 'vitest'
import { pickVoice, Speaker } from './speech'
import type { SpeechOutcome, SpeechRequest, UtteranceLike, VoiceLike } from './speech'

/** A fake speechSynthesis with manual timers: tests decide when utterances start and end. */
function setup() {
  const spoken: UtteranceLike[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  let now = 0
  let cancels = 0
  const synthState = { speaking: false }
  const speaker = new Speaker({
    synth: {
      isSpeaking: () => synthState.speaking,
      speak: (u) => spoken.push(u),
      cancel: () => {
        cancels += 1
        // Like Safari: the cancelled utterance reports an "interrupted" error afterwards.
        for (const u of spoken) u.onerror?.({ error: 'interrupted' })
      },
    },
    createUtterance: (text) => ({ text, rate: 1, voice: null, onstart: null, onend: null, onerror: null }),
    now: () => now,
    setTimer: (callback) => {
      const id = nextTimer++
      timers.set(id, callback)
      return id
    },
    clearTimer: (id) => timers.delete(id as number),
  })
  const log: string[] = []
  const request = (text: string, urgent = false, extra: Partial<SpeechRequest> = {}): SpeechRequest => ({
    text,
    urgent,
    onStart: (t) => log.push(`start ${text} @${t}`),
    onDone: (outcome: SpeechOutcome) => log.push(`${outcome} ${text}`),
    ...extra,
  })
  const last = () => spoken[spoken.length - 1]
  const runTimers = () => {
    const pending = [...timers.values()]
    timers.clear()
    for (const callback of pending) callback()
  }
  return {
    speaker,
    spoken,
    log,
    request,
    last,
    runTimers,
    timers,
    setNow: (t: number) => (now = t),
    synthState,
    cancels: () => cancels,
  }
}

describe('Speaker and the engine\'s state', () => {
  test('an urgent phrase starts at once when nothing was being said', () => {
    const s = setup()
    s.speaker.speak(s.request('Detection stalled.', true))
    expect(s.last().text).toBe('Detection stalled.')
  })

  test('after cutting a phrase off, the next waits a moment (iOS can drop or double a phrase started in the same instant)', () => {
    const s = setup()
    s.speaker.speak(s.request('Chair found, ahead.'))
    s.speaker.speak(s.request('Raise the phone.', true)) // cuts it off
    expect(s.spoken).toHaveLength(1) // nothing new yet
    expect(s.cancels()).toBe(1)
    s.runTimers()
    expect(s.last().text).toBe('Raise the phone.')
  })

  test('the wait is the configured gap, and a phrase that starts later than that needs no wait', () => {
    const s = setup()
    s.speaker.speak(s.request('first'))
    s.speaker.interrupt()
    s.setNow(10_000) // long after the cancel
    s.speaker.speak(s.request('second'))
    expect(s.last().text).toBe('second')
  })

  test('if the engine is still speaking something we thought was over, it is cleared once and the phrase starts after a moment', () => {
    const s = setup()
    s.synthState.speaking = true // an utterance whose end we never heard
    s.speaker.speak(s.request('Turn left.'))
    expect(s.cancels()).toBe(1)
    expect(s.spoken).toHaveLength(0)
    s.synthState.speaking = false
    s.runTimers()
    expect(s.last().text).toBe('Turn left.')
  })

  test('it clears a leftover only once per phrase, so a stuck flag cannot stop speech for good', () => {
    const s = setup()
    s.synthState.speaking = true // never goes false
    s.speaker.speak(s.request('Turn left.'))
    s.runTimers()
    expect(s.last().text).toBe('Turn left.')
    expect(s.cancels()).toBe(1)
  })
})

describe('Speaker', () => {
  test('isUrgent is true only while an urgent phrase is waiting or playing', () => {
    const s = setup()
    expect(s.speaker.isUrgent()).toBe(false)
    s.speaker.speak(s.request('Detection stalled.', true))
    expect(s.speaker.isBusy()).toBe(true)
    expect(s.speaker.isUrgent()).toBe(true)
    s.last().onend?.()
    expect(s.speaker.isUrgent()).toBe(false)
    s.speaker.speak(s.request('Chair found, ahead.', false))
    expect(s.speaker.isBusy()).toBe(true)
    expect(s.speaker.isUrgent()).toBe(false)
  })

  test('a normal phrase that is cut off by an urgent one hands over: urgent while the warning plays', () => {
    const s = setup()
    s.speaker.speak(s.request('Bear right.', false))
    s.speaker.speak(s.request('Low light.', true))
    expect(s.speaker.isUrgent()).toBe(true)
  })

  test('speaks at once when idle, at the set rate and voice, and timestamps the start', () => {
    const s = setup()
    const voice = { name: 'Ava', lang: 'en-US', localService: true }
    s.speaker.setRate(1.4)
    s.speaker.setVoice(voice)
    s.speaker.speak(s.request('Hello'))
    expect(s.spoken.map((u) => u.text)).toEqual(['Hello'])
    expect(s.last().rate).toBe(1.4)
    expect(s.last().voice).toBe(voice)
    expect(s.speaker.isBusy()).toBe(true)
    s.setNow(42)
    s.last().onstart?.()
    s.last().onend?.()
    expect(s.log).toEqual(['start Hello @42', 'finished Hello'])
    expect(s.speaker.isBusy()).toBe(false)
  })

  test('keeps only the newest waiting phrase, then speaks it', () => {
    const s = setup()
    s.speaker.speak(s.request('one'))
    s.speaker.speak(s.request('two'))
    s.speaker.speak(s.request('three'))
    expect(s.log).toEqual(['preempted two'])
    s.spoken[0].onend?.()
    expect(s.spoken.map((u) => u.text)).toEqual(['one', 'three'])
  })

  test('urgent cancels the current phrase and the waiting one, then speaks at once', () => {
    const s = setup()
    s.speaker.speak(s.request('normal'))
    s.speaker.speak(s.request('waiting'))
    s.speaker.speak(s.request('STOP', true))
    expect(s.cancels()).toBe(1)
    expect(s.log).toEqual(['preempted waiting', 'preempted normal'])
    // The engine gets a moment after the cancel (iOS can drop or double a phrase started in the same instant).
    expect(s.speaker.isBusy()).toBe(true)
    expect(s.spoken).toHaveLength(1)
    s.runTimers()
    expect(s.last().text).toBe('STOP')
    // The late "interrupted" error from the cancelled utterance must not end the urgent one.
    expect(s.speaker.isBusy()).toBe(true)
  })

  test('prepare can drop a phrase or delay it for a lead-in tone', () => {
    const s = setup()
    s.speaker.speak(s.request('stale', false, { prepare: () => null }))
    expect(s.log).toEqual(['dropped stale'])
    expect(s.spoken).toHaveLength(0)

    s.speaker.speak(s.request('after tone', false, { prepare: () => 200 }))
    expect(s.spoken).toHaveLength(0)
    expect(s.speaker.isBusy()).toBe(true)
    s.runTimers()
    expect(s.last().text).toBe('after tone')
  })

  test('the waiting phrase is prepared only when its turn comes', () => {
    const s = setup()
    let prepared = 0
    s.speaker.speak(s.request('first'))
    s.speaker.speak(s.request('second', false, { prepare: () => (prepared++, 0) }))
    expect(prepared).toBe(0)
    s.spoken[0].onend?.()
    expect(prepared).toBe(1)
  })

  test('a speech error other than a cancel is reported as failed and the queue moves on', () => {
    const s = setup()
    s.speaker.speak(s.request('one'))
    s.speaker.speak(s.request('two'))
    s.spoken[0].onerror?.({ error: 'synthesis-failed' })
    expect(s.log).toEqual(['failed one'])
    expect(s.last().text).toBe('two')
  })

  test('the watchdog frees the speaker if speech never ends', () => {
    const s = setup()
    s.speaker.speak(s.request('stuck'))
    s.runTimers()
    expect(s.log).toEqual(['finished stuck'])
    expect(s.speaker.isBusy()).toBe(false)
  })

  test('with spoken feedback off, prepare still runs but nothing is spoken', () => {
    const s = setup()
    let prepared = false
    s.speaker.setEnabled(false)
    s.speaker.speak(s.request('quiet', false, { prepare: () => ((prepared = true), 0) }))
    expect(prepared).toBe(true)
    expect(s.spoken).toHaveLength(0)
    expect(s.log).toEqual(['finished quiet'])
  })
})

describe('Speaker hold', () => {
  test('holding stops the current phrase and drops normal ones, but urgent still speaks', () => {
    const s = setup()
    s.speaker.speak(s.request('Bench, 12 o\'clock'))
    s.speaker.setHeld(true)
    expect(s.log).toContain('preempted Bench, 12 o\'clock')
    s.speaker.speak(s.request('Chair, 1 o\'clock'))
    expect(s.log).toContain('preempted Chair, 1 o\'clock')
    expect(s.speaker.isBusy()).toBe(false)
    s.speaker.speak(s.request('Pole, 12 o\'clock', true))
    s.runTimers()
    expect(s.last().text).toBe('Pole, 12 o\'clock')
  })

  test('releasing the hold lets normal phrases speak again', () => {
    const s = setup()
    s.speaker.setHeld(true)
    s.speaker.setHeld(false)
    s.speaker.speak(s.request('Bench'))
    expect(s.last().text).toBe('Bench')
  })
})

describe('pickVoice', () => {
  const v = (name: string, lang: string, localService = true): VoiceLike => ({ name, lang, localService })

  test('prefers an enhanced local US English voice', () => {
    const voices = [v('Thomas', 'fr-FR'), v('Samantha', 'en-US'), v('Ava (Enhanced)', 'en-US'), v('Daniel (Enhanced)', 'en-GB')]
    expect(pickVoice(voices)?.name).toBe('Ava (Enhanced)')
  })

  test('then any enhanced English, then local US, then local, then any English', () => {
    expect(pickVoice([v('Samantha', 'en-US'), v('Daniel (Premium)', 'en-GB')])?.name).toBe('Daniel (Premium)')
    expect(pickVoice([v('Daniel', 'en-GB'), v('Samantha', 'en_US')])?.name).toBe('Samantha')
    expect(pickVoice([v('Cloud', 'en-US', false), v('Daniel', 'en-GB')])?.name).toBe('Daniel')
    expect(pickVoice([v('Cloud', 'en-US', false)])?.name).toBe('Cloud')
  })

  test('null when no English voice exists, so the browser default is used', () => {
    expect(pickVoice([v('Thomas', 'fr-FR')])).toBeNull()
    expect(pickVoice([])).toBeNull()
  })
})
