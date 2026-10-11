import { describe, expect, test } from 'vitest'
import { noteRunning, RESTART_NOTICE, takeRestartNotice } from './restartNotice'
import type { FlagStorage } from './restartNotice'

function memory(): FlagStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

describe('the restart notice', () => {
  test('a reload while running gives the notice once', () => {
    const storage = memory()
    noteRunning(storage, true)
    expect(takeRestartNotice(storage)).toBe(RESTART_NOTICE)
    expect(takeRestartNotice(storage)).toBeNull()
  })

  test('a reload after stopping, or a first visit, gives none', () => {
    const storage = memory()
    expect(takeRestartNotice(storage)).toBeNull()
    noteRunning(storage, true)
    noteRunning(storage, false)
    expect(takeRestartNotice(storage)).toBeNull()
  })

  test('blocked or missing storage never breaks anything', () => {
    const broken: FlagStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => noteRunning(broken, true)).not.toThrow()
    expect(takeRestartNotice(broken)).toBeNull()
    expect(takeRestartNotice(null)).toBeNull()
  })

  test('it tells the user what to do', () => {
    expect(RESTART_NOTICE).toMatch(/Press Start/)
  })
})
