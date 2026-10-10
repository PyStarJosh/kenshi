import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import { TalkGesture } from './gesture'

function setup() {
  let now = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  let nextId = 1
  const calls: string[] = []
  const gesture = new TalkGesture({
    now: () => now,
    setTimer: (callback, ms) => {
      const id = nextId++
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimer: (id) => timers.delete(id as number),
    onTap: () => calls.push('tap'),
    onLongPress: () => calls.push('long'),
  })
  const advance = (ms: number) => {
    now += ms
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id)
        timer.callback()
      }
    }
  }
  return { gesture, calls, advance }
}

describe('TalkGesture', () => {
  test('a short press is one tap', () => {
    const { gesture, calls, advance } = setup()
    gesture.pressStart()
    advance(100)
    gesture.pressEnd()
    expect(calls).toEqual(['tap'])
  })

  test('holding fires a long press once, and releasing does not tap', () => {
    const { gesture, calls, advance } = setup()
    gesture.pressStart()
    advance(CONFIG.voice.longPressMs)
    expect(calls).toEqual(['long'])
    advance(2000)
    gesture.pressEnd()
    expect(calls).toEqual(['long'])
  })

  test('two taps inside the debounce window count once', () => {
    const { gesture, calls, advance } = setup()
    gesture.tap()
    advance(CONFIG.voice.tapDebounceMs - 1)
    gesture.tap()
    expect(calls).toEqual(['tap'])
    advance(1)
    gesture.tap()
    expect(calls).toEqual(['tap', 'tap'])
  })

  test('a pointer press plus its synthesized click is one tap', () => {
    const { gesture, calls, advance } = setup()
    gesture.pressStart()
    advance(50)
    gesture.pressEnd()
    gesture.tap()
    expect(calls).toEqual(['tap'])
  })

  test('a cancelled press fires nothing', () => {
    const { gesture, calls, advance } = setup()
    gesture.pressStart()
    gesture.pressCancel()
    advance(5000)
    gesture.pressEnd()
    expect(calls).toEqual([])
  })
})
