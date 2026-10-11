import { afterEach, describe, expect, test, vi } from 'vitest'
import { setAudioSessionMode } from './unlock'

describe('setAudioSessionMode', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('switches the Safari audio session between playback and play-and-record', () => {
    const audioSession = { type: 'auto' }
    vi.stubGlobal('navigator', { audioSession })
    setAudioSessionMode('play-and-record')
    expect(audioSession.type).toBe('play-and-record')
    setAudioSessionMode('playback')
    expect(audioSession.type).toBe('playback')
  })

  test('does nothing where the browser has no audio session API, and never throws', () => {
    vi.stubGlobal('navigator', {})
    expect(() => setAudioSessionMode('play-and-record')).not.toThrow()
    const refusing = {
      set type(_value: string) {
        throw new Error('refused')
      },
    }
    vi.stubGlobal('navigator', { audioSession: refusing })
    expect(() => setAudioSessionMode('playback')).not.toThrow()
  })
})
