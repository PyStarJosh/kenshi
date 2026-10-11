import { describe, expect, test, vi } from 'vitest'
import { CONFIG } from '../core/config'
import { bytesToBase64, LocateError, locateTarget, scaledSize } from './locateClient'
import type { LocateErrorKind } from './locateTypes'
import { describeLocateError, FIND_MESSAGES } from './messages'

const request = { target: 'keys', frames: ['/9j/AAAA'] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const found = { found: true, frameIndex: 0, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, label: 'keys', confidence: 0.9 }

async function kindOf(promise: Promise<unknown>): Promise<LocateErrorKind | 'no error'> {
  try {
    await promise
    return 'no error'
  } catch (error) {
    if (error instanceof LocateError) return error.kind
    throw error
  }
}

describe('scaledSize', () => {
  test('keeps small frames and shrinks big ones by their longer side', () => {
    expect(scaledSize(640, 480, 768)).toEqual({ width: 640, height: 480 })
    expect(scaledSize(1280, 720, 768)).toEqual({ width: 768, height: 432 })
    expect(scaledSize(720, 1280, 768)).toEqual({ width: 432, height: 768 })
  })

  test('never returns a zero side', () => {
    expect(scaledSize(10000, 2, 100)).toEqual({ width: 100, height: 1 })
  })
})

describe('bytesToBase64', () => {
  test('matches the known encoding, including for data longer than one chunk', () => {
    expect(bytesToBase64(new Uint8Array([72, 105]))).toBe('SGk=')
    const big = new Uint8Array(100_000).map((_, i) => i % 251)
    expect(atob(bytesToBase64(big))).toHaveLength(100_000)
    expect(Uint8Array.from(atob(bytesToBase64(big)), (c) => c.charCodeAt(0))).toEqual(big)
  })
})

describe('locateTarget', () => {
  test('posts JSON to /api/locate and returns a found result', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(found))
    await expect(locateTarget(request, { fetchImpl })).resolves.toEqual(found)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/locate')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual(request)
  })

  test('not found is a result, not an error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ found: false }))
    await expect(locateTarget(request, { fetchImpl })).resolves.toEqual({ found: false })
  })

  test('refuses a bad request without calling the network', async () => {
    const fetchImpl = vi.fn()
    expect(await kindOf(locateTarget({ target: ' ', frames: ['/9j/AAAA'] }, { fetchImpl }))).toBe('bad-request')
    expect(await kindOf(locateTarget({ target: 'keys', frames: [] }, { fetchImpl }))).toBe('bad-request')
    const many = Array.from({ length: CONFIG.find.maxFrames + 1 }, () => '/9j/AAAA')
    expect(await kindOf(locateTarget({ target: 'keys', frames: many }, { fetchImpl }))).toBe('bad-request')
    expect(await kindOf(locateTarget({ target: 'k'.repeat(CONFIG.find.maxTargetChars + 1), frames: ['/9j/AAAA'] }, { fetchImpl }))).toBe('bad-request')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('the function\'s error kinds come through', async () => {
    for (const [status, kind] of [[429, 'rate-limited'], [500, 'not-configured'], [502, 'unavailable'], [400, 'bad-request']] as const) {
      const fetchImpl = vi.fn().mockResolvedValue(json({ error: kind, message: 'x' }, status))
      expect(await kindOf(locateTarget(request, { fetchImpl }))).toBe(kind)
    }
  })

  test('an error reply we do not recognize is unavailable', async () => {
    expect(await kindOf(locateTarget(request, { fetchImpl: vi.fn().mockResolvedValue(json({ error: 'weird' }, 500)) }))).toBe('unavailable')
    expect(await kindOf(locateTarget(request, { fetchImpl: vi.fn().mockResolvedValue(new Response('<html>', { status: 502 })) }))).toBe('unavailable')
  })

  test('a reply of the wrong shape is bad-reply', async () => {
    expect(await kindOf(locateTarget(request, { fetchImpl: vi.fn().mockResolvedValue(json({ found: true })) }))).toBe('bad-reply')
    expect(await kindOf(locateTarget(request, { fetchImpl: vi.fn().mockResolvedValue(json({ hello: 1 })) }))).toBe('bad-reply')
    expect(await kindOf(locateTarget(request, { fetchImpl: vi.fn().mockResolvedValue(new Response('nope')) }))).toBe('bad-reply')
  })

  test('no network is network', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await kindOf(locateTarget(request, { fetchImpl }))).toBe('network')
  })

  test('waiting too long is timeout', async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }),
    )
    expect(await kindOf(locateTarget(request, { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 20 }))).toBe('timeout')
  })
})

describe('messages', () => {
  test('every error kind and the not-found case have a sentence', () => {
    for (const kind of ['network', 'timeout', 'rate-limited', 'unavailable', 'bad-reply', 'not-configured', 'bad-request'] as const) {
      expect(describeLocateError(kind)).toBe(FIND_MESSAGES[kind])
      expect(FIND_MESSAGES[kind].length).toBeGreaterThan(10)
    }
  })

  test('not found is a limit of the search, never a claim about the room (SR-11)', () => {
    expect(FIND_MESSAGES.notFound).toBe('I could not find it.')
    expect(FIND_MESSAGES.notFound).not.toMatch(/not (here|there)|nothing|isn't|is not/i)
  })
})
