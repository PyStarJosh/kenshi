import { describe, expect, test } from 'vitest'
import { VoiceControl } from './control'
import type { VoiceControlDeps } from './control'
import type { ListenResult } from './recognizer'

function setup(options: { supported?: boolean; paused?: boolean; rate?: number; findActive?: boolean } = {}) {
  const log: string[] = []
  let resolveListen: ((result: ListenResult) => void) | null = null
  let listening = false
  let rate = options.rate ?? 1
  const deps: VoiceControlDeps = {
    recognizer: {
      isSupported: () => options.supported ?? true,
      isListening: () => listening,
      listen: () => {
        listening = true
        log.push('listen')
        return new Promise((resolve) => {
          resolveListen = (result) => {
            listening = false
            resolve(result)
          }
        })
      },
      cancel: () => {
        log.push('cancel')
        resolveListen?.({ kind: 'cancelled' })
      },
    },
    say: (text) => log.push(`say: ${text}`),
    holdSpeech: (held) => log.push(`hold ${held}`),
    earcon: (phase) => log.push(`earcon ${phase}`),
    startFind: (target) => log.push(`find ${target}`),
    cancelFind: () => log.push('cancelFind'),
    isFindActive: () => options.findActive ?? false,
    pauseDetection: () => log.push('pause'),
    resumeDetection: () => log.push('resume'),
    isPaused: () => options.paused ?? false,
    getSpeechRate: () => rate,
    setSpeechRate: (value) => {
      rate = value
      log.push(`rate ${value}`)
    },
    onIntent: (intent, source) => log.push(`intent ${intent} ${source}`),
    onError: (message) => log.push(`error: ${message}`),
  }
  const control = new VoiceControl(deps)
  const finishListen = async (result: ListenResult) => {
    resolveListen?.(result)
    await Promise.resolve()
    await Promise.resolve()
  }
  return { control, log, finishListen }
}

describe('VoiceControl', () => {
  test('a tap holds speech, plays the start earcon, and listens', () => {
    const { control, log } = setup()
    control.tap()
    expect(log).toEqual(['hold true', 'earcon start', 'listen'])
  })

  test('a recognized command runs, after the stop earcon and releasing speech', async () => {
    const { control, log, finishListen } = setup()
    control.tap()
    log.length = 0
    await finishListen({ kind: 'text', text: 'pause' })
    expect(log).toEqual(['hold false', 'earcon stop', 'intent pause speech', 'pause', 'say: Paused.'])
  })

  test('unknown text only apologizes', async () => {
    const { control, log, finishListen } = setup()
    control.tap()
    log.length = 0
    await finishListen({ kind: 'text', text: 'banana' })
    expect(log.slice(2)).toEqual(["say: Sorry, I didn't catch that."])
  })

  test('silence does nothing: the tap never reads out objects', async () => {
    const { control, log, finishListen } = setup()
    control.tap()
    log.length = 0
    await finishListen({ kind: 'silence' })
    expect(log).toEqual(['hold false', 'earcon stop'])
  })

  test('a second tap while listening cancels without running anything', async () => {
    const { control, log } = setup()
    control.tap()
    log.length = 0
    control.tap()
    await Promise.resolve()
    await Promise.resolve()
    expect(log).toEqual(['cancel', 'hold false', 'earcon stop'])
  })

  test('unsupported recognition: the tap says so, and only the first time', () => {
    const { control, log } = setup({ supported: false })
    control.tap()
    expect(log).toEqual(['say: Voice commands are not available on this device.'])
    log.length = 0
    control.tap()
    expect(log).toEqual([])
  })

  test('a denied microphone falls back, reports the error, and skips listening next time', async () => {
    const { control, log, finishListen } = setup()
    control.tap()
    log.length = 0
    await finishListen({ kind: 'failed', message: 'Microphone access was denied.', permanent: true })
    expect(log).toContain('error: Microphone access was denied.')
    expect(log).toContain('say: Voice commands are not available on this device.')
    log.length = 0
    control.tap()
    expect(log).not.toContain('listen')
  })

  test('a temporary failure (offline) still falls back but listens again next time', async () => {
    const { control, log, finishListen } = setup()
    control.tap()
    await finishListen({ kind: 'failed', message: 'Speech recognition needs a connection.', permanent: false })
    log.length = 0
    control.tap()
    expect(log).toContain('listen')
  })

  test('long press toggles detection', () => {
    const running = setup({ paused: false })
    running.control.longPress()
    expect(running.log).toContain('pause')
    const paused = setup({ paused: true })
    paused.control.longPress()
    expect(paused.log).toContain('resume')
  })

  test('"find <target>" starts a search and says nothing itself (Find speaks its own confirmation)', async () => {
    const { control, log, finishListen } = setup()
    control.tap()
    log.length = 0
    await finishListen({ kind: 'text', text: "Where's the exit?" })
    expect(log).toEqual(['hold false', 'earcon stop', 'intent find speech', 'find exit'])
  })

  test('"take me to" and "find my" give the cleaned target', async () => {
    for (const [text, target] of [['take me to the elevator', 'elevator'], ['find my keys please', 'keys']] as const) {
      const { control, log, finishListen } = setup()
      control.tap()
      await finishListen({ kind: 'text', text })
      expect(log).toContain(`find ${target}`)
    }
  })

  test('"stop" cancels a running Find', async () => {
    const { control, log, finishListen } = setup({ findActive: true })
    control.tap()
    log.length = 0
    await finishListen({ kind: 'text', text: 'stop' })
    expect(log).toContain('cancelFind')
    expect(log).not.toContain('pause')
  })

  test('"stop" with nothing running says so, and does not pause', async () => {
    const { control, log, finishListen } = setup({ findActive: false })
    control.tap()
    log.length = 0
    await finishListen({ kind: 'text', text: 'stop' })
    expect(log).toContain('say: Nothing to stop.')
    expect(log).not.toContain('cancelFind')
    expect(log).not.toContain('pause')
  })

  test('a long press cancels a running Find instead of pausing', () => {
    const running = setup({ findActive: true, paused: false })
    running.control.longPress()
    expect(running.log).toContain('cancelFind')
    expect(running.log).not.toContain('pause')
  })

  test('slower and faster change the rate and stop at the limits', async () => {
    const slow = setup({ rate: 1 })
    slow.control.tap()
    await slow.finishListen({ kind: 'text', text: 'slower' })
    expect(slow.log).toContain('rate 0.8')
    const limit = setup({ rate: 0.6 })
    limit.control.tap()
    await limit.finishListen({ kind: 'text', text: 'slower' })
    expect(limit.log).toContain('say: Slowest speed.')
    expect(limit.log.some((line) => line.startsWith('rate'))).toBe(false)
  })

  test('help lists the commands', async () => {
    const h = setup()
    h.control.tap()
    await h.finishListen({ kind: 'text', text: 'help' })
    expect(h.log.some((line) => line.startsWith('say: Tap, then say:'))).toBe(true)
  })

  test('an urgent alert cancels listening', () => {
    const { control, log } = setup()
    control.tap()
    control.cancelForUrgent()
    expect(log).toContain('cancel')
  })
})
