import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import { Recognizer } from './recognizer'
import type { RecognitionLike } from './recognizer'

function setup(options: { create?: boolean; startThrows?: boolean } = {}) {
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const recognition: RecognitionLike & { stops: number; aborts: number } = {
    lang: '',
    continuous: true,
    interimResults: true,
    maxAlternatives: 0,
    onresult: null,
    onerror: null,
    onend: null,
    stops: 0,
    aborts: 0,
    start: () => {
      if (options.startThrows) throw new Error('already started')
    },
    stop() {
      this.stops += 1
      // Like the browser: stopping ends the session.
      queueMicrotask(() => this.onend?.())
    },
    abort() {
      this.aborts += 1
    },
  }
  const recognizer = new Recognizer({
    supported: () => options.create !== false,
    create: () => (options.create === false ? null : recognition),
    setTimer: (callback) => {
      const id = nextTimer++
      timers.set(id, callback)
      return id
    },
    clearTimer: (id) => timers.delete(id as number),
  })
  const result = (transcript: string, isFinal = true) => ({
    results: [Object.assign([{ transcript }], { isFinal })],
  })
  return { recognizer, recognition, timers, result }
}

describe('Recognizer', () => {
  test('configures one English utterance without interim results', () => {
    const { recognizer, recognition } = setup()
    void recognizer.listen()
    expect(recognition.lang).toBe('en-US')
    expect(recognition.continuous).toBe(false)
    expect(recognition.interimResults).toBe(false)
    expect(recognizer.isListening()).toBe(true)
  })

  test('returns the first final result and stops', async () => {
    const { recognizer, recognition, result } = setup()
    const promise = recognizer.listen()
    recognition.onresult?.(result('Pause please'))
    expect(await promise).toEqual({ kind: 'text', text: 'Pause please' })
    expect(recognition.stops).toBe(1)
    expect(recognizer.isListening()).toBe(false)
  })

  test('a result that is not final is kept and used when listening ends', async () => {
    const { recognizer, recognition, result } = setup()
    const promise = recognizer.listen()
    recognition.onresult?.(result('pause', false))
    recognition.onend?.()
    expect(await promise).toEqual({ kind: 'text', text: 'pause' })
  })

  test('the listen timeout stops listening and reports silence', async () => {
    const { recognizer, timers } = setup()
    const promise = recognizer.listen()
    expect(timers.size).toBe(1)
    expect(CONFIG.voice.listenTimeoutMs).toBeGreaterThan(0)
    for (const callback of [...timers.values()]) callback()
    expect(await promise).toEqual({ kind: 'silence' })
  })

  test('no-speech is silence, not a failure', async () => {
    const { recognizer, recognition } = setup()
    const promise = recognizer.listen()
    recognition.onerror?.({ error: 'no-speech' })
    recognition.onend?.()
    expect(await promise).toEqual({ kind: 'silence' })
  })

  test('denied microphone is a permanent failure', async () => {
    const { recognizer, recognition } = setup()
    const promise = recognizer.listen()
    recognition.onerror?.({ error: 'not-allowed' })
    expect(await promise).toEqual({ kind: 'failed', message: 'Microphone access was denied.', permanent: true })
  })

  test('a network error is a temporary failure', async () => {
    const { recognizer, recognition } = setup()
    const promise = recognizer.listen()
    recognition.onerror?.({ error: 'network' })
    expect(await promise).toMatchObject({ kind: 'failed', permanent: false })
  })

  test('unsupported or a start() that throws is a failure', async () => {
    expect(await setup({ create: false }).recognizer.listen()).toMatchObject({ kind: 'failed', permanent: true })
    expect(setup({ create: false }).recognizer.isSupported()).toBe(false)
    expect(await setup({ startThrows: true }).recognizer.listen()).toMatchObject({ kind: 'failed' })
  })

  test('cancel resolves as cancelled and aborts', async () => {
    const { recognizer, recognition } = setup()
    const promise = recognizer.listen()
    recognizer.cancel()
    expect(await promise).toEqual({ kind: 'cancelled' })
    expect(recognition.aborts).toBe(1)
    expect(recognizer.isListening()).toBe(false)
  })
})
