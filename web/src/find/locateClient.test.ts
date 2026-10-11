import { describe, expect, test, vi } from 'vitest'
import { CONFIG } from '../core/config'
import type { LocateErrorCode, LocateResult } from '../core/types'
import { bytesToBase64, CallLimiter, isLocateResult, Locator, scaledSize } from './locateClient'
import type { Capture, LocateClientErrorCode } from './locateClient'
import { describeLocateError, FIND_MESSAGES } from './messages'

const bitmap = {} as ImageBitmap
const capture = (heading = 0, pitch = 0): Capture => ({ bitmap, heading, pitch })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const found: LocateResult = {
  found: true,
  frameIndex: 0,
  box: { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.6 },
  label: 'chair',
  onFloor: true,
  distanceM: 2.5,
  confidence: 0.9,
  signHint: null,
  latencyMs: 1200,
}
const notFound: LocateResult = {
  found: false,
  frameIndex: null,
  box: null,
  label: '',
  onFloor: false,
  distanceM: null,
  confidence: 0,
  signHint: null,
  latencyMs: 900,
}

function setup(
  options: { reply?: () => Promise<Response>; minGapMs?: number; maxPerMinute?: number; timeoutMs?: number; slotWaitMs?: number } = {},
) {
  const clock = { nowMs: 100_000 }
  const fetchImpl = vi.fn(options.reply ?? (() => Promise.resolve(json(found))))
  const encode = vi.fn(async () => '/9j/AAAA')
  const locator = new Locator({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    encode,
    now: () => clock.nowMs,
    minGapMs: options.minGapMs ?? 6000,
    maxPerMinute: options.maxPerMinute ?? 8,
    timeoutMs: options.timeoutMs ?? 12_000,
    slotWaitMs: options.slotWaitMs ?? 8000,
  })
  return { clock, fetchImpl, encode, locator }
}

describe('scaledSize', () => {
  test('keeps narrow frames and shrinks wide ones to the target width', () => {
    expect(scaledSize(480, 360, 640)).toEqual({ width: 480, height: 360 })
    expect(scaledSize(1280, 720, 640)).toEqual({ width: 640, height: 360 })
    expect(scaledSize(1920, 1080, 640)).toEqual({ width: 640, height: 360 })
  })

  test('never returns a zero height', () => {
    expect(scaledSize(10000, 2, 100)).toEqual({ width: 100, height: 1 })
  })

  test('the default is 720 px wide at quality 0.8', () => {
    expect(CONFIG.find.imageWidthPx).toBe(720)
    expect(CONFIG.find.jpegQuality).toBe(0.8)
  })
})

describe('bytesToBase64', () => {
  test('matches the standard encoding, including for large inputs', () => {
    expect(bytesToBase64(new Uint8Array([255, 216, 255]))).toBe('/9j/')
    const big = new Uint8Array(100_000).map((_, i) => i % 251)
    const decoded = Uint8Array.from(atob(bytesToBase64(big)), (c) => c.charCodeAt(0))
    expect(decoded).toEqual(big)
  })
})

describe('CallLimiter', () => {
  test('allows the first call, then blocks until the minimum gap has passed', () => {
    const limiter = new CallLimiter(6000, 8)
    expect(limiter.check(0)).toEqual({ ok: true })
    limiter.record(0)
    expect(limiter.check(2000)).toEqual({ ok: false, error: 'too_soon', retryAfterMs: 4000 })
    expect(limiter.check(6000)).toEqual({ ok: true })
  })

  test('blocks the ninth call inside one minute, and frees it when the oldest call ages out', () => {
    const limiter = new CallLimiter(1000, 8)
    for (let i = 0; i < 8; i++) limiter.record(i * 1000)
    expect(limiter.check(8000)).toEqual({ ok: false, error: 'limit', retryAfterMs: 52_000 })
    expect(limiter.check(60_000)).toEqual({ ok: true })
  })

  test('an unpaced check skips the gap but not the per-minute cap', () => {
    const limiter = new CallLimiter(6000, 3)
    limiter.record(0)
    expect(limiter.check(1000, true)).toMatchObject({ ok: false, error: 'too_soon' })
    expect(limiter.check(1000, false)).toEqual({ ok: true })
    limiter.record(1000)
    limiter.record(2000)
    expect(limiter.check(3000, false)).toMatchObject({ ok: false, error: 'limit' })
  })

  test('the defaults: a 6 s gap for paced calls, 12 per minute, 4 looks at once', () => {
    expect(CONFIG.find.minGapMs).toBe(6000)
    expect(CONFIG.find.maxPerMinute).toBe(12)
    expect(CONFIG.find.maxConcurrentCalls).toBe(4)
  })
})

describe('isLocateResult', () => {
  test('accepts found and not found results', () => {
    expect(isLocateResult(found)).toBe(true)
    expect(isLocateResult(notFound)).toBe(true)
  })

  test.each([
    ['null', null],
    ['no latency', { ...found, latencyMs: undefined }],
    ['a found result with no box', { ...found, box: null }],
    ['a box outside 0 to 1', { ...found, box: { x0: 0, y0: 0, x1: 2, y1: 1 } }],
    ['a found result with a fractional frame index', { ...found, frameIndex: 0.5 }],
    ['a not-found result that still has a box', { ...notFound, box: found.box }],
    ['a distance that is a string', { ...found, distanceM: 'far' }],
    ['a sign hint that is a number', { ...found, signHint: 5 }],
  ])('rejects %s', (_name, value) => {
    expect(isLocateResult(value)).toBe(false)
  })
})

describe('Locator', () => {
  test('encodes every frame and posts the target with each frame\'s heading and pitch', async () => {
    const { locator, fetchImpl, encode } = setup()
    const outcome = await locator.locate(' chair ', [capture(10, -2), capture(55, -3)])
    expect(outcome).toEqual({ ok: true, result: found })
    expect(encode).toHaveBeenCalledTimes(2)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/locate')
    expect(JSON.parse(init.body as string)).toEqual({
      target: 'chair',
      frames: [
        { jpeg: '/9j/AAAA', heading: 10, pitch: -2 },
        { jpeg: '/9j/AAAA', heading: 55, pitch: -3 },
      ],
    })
  })

  test('a not-found answer is a successful outcome', async () => {
    const { locator } = setup({ reply: () => Promise.resolve(json(notFound)) })
    expect(await locator.locate('chair', [capture()])).toEqual({ ok: true, result: notFound })
  })

  test('bad input comes back as bad_request without any call or any use of the allowance', async () => {
    const { locator, fetchImpl, clock } = setup()
    for (const [target, captures] of [
      ['', [capture()]],
      ['   ', [capture()]],
      ['a'.repeat(61), [capture()]],
      ['chair', []],
      ['chair', Array.from({ length: 9 }, () => capture())],
    ] as const) {
      expect(await locator.locate(target, captures)).toMatchObject({ ok: false, error: 'bad_request' })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await locator.locate('chair', [capture()])).toMatchObject({ ok: true }) // clock never moved, yet allowed
    expect(clock.nowMs).toBe(100_000)
  })

  test('a second call too soon is refused with the time to wait, and nothing is sent', async () => {
    const { locator, fetchImpl, clock } = setup()
    await locator.locate('chair', [capture()])
    clock.nowMs += 2000
    expect(await locator.locate('chair', [capture()])).toEqual({
      ok: false,
      error: 'too_soon',
      message: 'Too many searches too fast.',
      retryAfterMs: 4000,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    clock.nowMs += 4000
    expect(await locator.locate('chair', [capture()])).toMatchObject({ ok: true })
  })

  test('the per-minute cap refuses the ninth call', async () => {
    const { locator, clock, fetchImpl } = setup({ minGapMs: 1000 })
    for (let i = 0; i < 8; i++) {
      clock.nowMs += 1000
      expect(await locator.locate('chair', [capture()])).toMatchObject({ ok: true })
    }
    clock.nowMs += 1000
    expect(await locator.locate('chair', [capture()])).toMatchObject({ ok: false, error: 'limit' })
    expect(fetchImpl).toHaveBeenCalledTimes(8)
  })

  test('a failed call still counts against the allowance', async () => {
    const { locator, clock } = setup({ reply: () => Promise.resolve(json({ error: 'quota', message: 'x' }, 429)) })
    await locator.locate('chair', [capture()])
    clock.nowMs += 1000
    expect(await locator.locate('chair', [capture()])).toMatchObject({ error: 'too_soon' })
  })

  test('unpaced looks go out back to back, up to the concurrency cap', async () => {
    const releases: ((r: Response) => void)[] = []
    const { locator, fetchImpl, clock } = setup({
      minGapMs: 6000,
      maxPerMinute: 20,
      reply: () => new Promise<Response>((resolve) => releases.push(resolve)),
    })
    const looks = []
    for (let i = 0; i < 4; i++) {
      clock.nowMs += 100 // far inside the 6 s gap
      looks.push(locator.locate('chair', [capture()], { paced: false }))
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(i + 1))
    }
    clock.nowMs += 100
    expect(locator.canLocate(false)).toBe(false)
    // a fifth look waits for one to come back instead of being dropped
    const fifth = locator.locate('chair', [capture()], { paced: false })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    releases[0](json(found))
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5))
    for (const release of releases.slice(1)) release(json(found))
    expect((await Promise.all([...looks, fifth])).every((o) => o.ok)).toBe(true)
    expect(locator.canLocate(false)).toBe(true)
  })

  test('a look that cannot get a slot in time is refused, and nothing is sent for it', async () => {
    const releases: ((r: Response) => void)[] = []
    const { locator, fetchImpl, clock } = setup({
      maxPerMinute: 20,
      slotWaitMs: 30,
      reply: () => new Promise<Response>((resolve) => releases.push(resolve)),
    })
    const looks = []
    for (let i = 0; i < 4; i++) {
      clock.nowMs += 100
      looks.push(locator.locate('chair', [capture()], { paced: false }))
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(i + 1))
    }
    expect(await locator.locate('chair', [capture()], { paced: false })).toMatchObject({ ok: false, error: 'too_soon' })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    for (const release of releases) release(json(found))
    await Promise.all(looks)
  })

  test('a re-check sends where the target should be, so Gemini picks the same one of several', async () => {
    const { locator, fetchImpl } = setup()
    await locator.locate('chair', [capture()], { nearX: 0.62 })
    const sent = (calls: unknown[][]) => JSON.parse((calls[0] as [string, RequestInit])[1].body as string)
    expect(sent(fetchImpl.mock.calls).nearX).toBe(0.62)
    const { locator: plain, fetchImpl: plainFetch } = setup()
    await plain.locate('chair', [capture()])
    expect(sent(plainFetch.mock.calls)).not.toHaveProperty('nearX')
  })

  test('asks for JSON back', async () => {
    const { locator, fetchImpl } = setup()
    await locator.locate('chair', [capture()])
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toMatchObject({ accept: 'application/json' })
  })

  test('a paced call still waits for the gap and for any look in flight', async () => {
    const releases: ((r: Response) => void)[] = []
    const { locator, clock } = setup({ reply: () => new Promise<Response>((resolve) => releases.push(resolve)) })
    const look = locator.locate('chair', [capture()], { paced: false })
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    clock.nowMs += 10_000 // the gap has passed, but a look is out
    expect(locator.canLocate(true)).toBe(false)
    expect(await locator.locate('chair', [capture()])).toMatchObject({ ok: false, error: 'too_soon' })
    releases[0](json(found))
    await look
    expect(locator.canLocate(true)).toBe(true)
  })

  test('a call made while another is running is refused', async () => {
    let finish: (r: Response) => void = () => {}
    const { locator, fetchImpl, clock } = setup({
      minGapMs: 0,
      reply: () => new Promise<Response>((resolve) => (finish = resolve)),
    })
    const first = locator.locate('chair', [capture()])
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled())
    clock.nowMs += 10
    expect(await locator.locate('chair', [capture()])).toMatchObject({ ok: false, error: 'too_soon' })
    finish(json(found))
    expect(await first).toMatchObject({ ok: true })
  })

  test.each<[LocateErrorCode, number]>([
    ['bad_request', 400],
    ['timeout', 504],
    ['quota', 429],
    ['auth', 500],
    ['bad_response', 502],
    ['network', 502],
  ])('the function\'s %s error (HTTP %i) is passed on', async (code, status) => {
    const { locator } = setup({ reply: () => Promise.resolve(json({ error: code, message: 'x' }, status)) })
    expect(await locator.locate('chair', [capture()])).toMatchObject({ ok: false, error: code })
  })

  test('an unknown error code or a non-JSON failure becomes network', async () => {
    const odd = setup({ reply: () => Promise.resolve(json({ error: 'martian' }, 500)) })
    expect(await odd.locator.locate('chair', [capture()])).toMatchObject({ error: 'network' })
    const html = setup({ reply: () => Promise.resolve(new Response('<html>', { status: 502 })) })
    expect(await html.locator.locate('chair', [capture()])).toMatchObject({ error: 'network' })
  })

  test('a server with no locate function (404, 405, or the app\'s HTML page) is auth with a clear message, not network', async () => {
    for (const reply of [
      new Response('Not Found', { status: 404 }),
      new Response('', { status: 405 }),
      new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ]) {
      const { locator } = setup({ reply: () => Promise.resolve(reply) })
      const outcome = await locator.locate('chair', [capture()])
      expect(outcome).toMatchObject({ ok: false, error: 'auth' })
      expect(outcome.ok ? '' : outcome.message).toMatch(/No locate function at \/api\/locate/)
    }
  })

  test('the platform\'s own errors, which are not our JSON, are told by their status: a timeout is a timeout', async () => {
    const cases: [Response, LocateClientErrorCode][] = [
      [new Response('An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT', { status: 504 }), 'timeout'],
      [new Response('<html>Gateway Timeout</html>', { status: 504, headers: { 'content-type': 'text/html' } }), 'timeout'],
      [new Response('Too Many Requests', { status: 429 }), 'quota'],
      [new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }), 'network'],
      [new Response(null, { status: 304 }), 'network'],
      [json({ error: { code: 'FUNCTION_INVOCATION_TIMEOUT' } }, 504), 'timeout'],
    ]
    for (const [reply, code] of cases) {
      const { locator } = setup({ reply: () => Promise.resolve(reply) })
      expect(await locator.locate('chair', [capture()]), String(reply.status)).toMatchObject({ ok: false, error: code })
    }
  })

  test('a 200 that is not JSON or has the wrong shape is bad_response', async () => {
    const html = setup({ reply: () => Promise.resolve(new Response('not json', { status: 200 })) })
    expect(await html.locator.locate('chair', [capture()])).toMatchObject({ error: 'bad_response' })
    const wrong = setup({ reply: () => Promise.resolve(json({ found: 'maybe' })) })
    expect(await wrong.locator.locate('chair', [capture()])).toMatchObject({ error: 'bad_response' })
  })

  test('a fetch failure is network and never throws', async () => {
    const { locator } = setup({ reply: () => Promise.reject(new TypeError('Failed to fetch')) })
    expect(await locator.locate('chair', [capture()])).toMatchObject({ ok: false, error: 'network' })
  })

  test('a stalled call times out', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
          }),
      )
      const locator = new Locator({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        encode: async () => '/9j/AAAA',
        now: () => 0,
        timeoutMs: 5000,
      })
      const pending = locator.locate('chair', [capture()])
      await vi.advanceTimersByTimeAsync(5001)
      expect(await pending).toMatchObject({ ok: false, error: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  test('an encoding failure is reported as bad_request, not thrown', async () => {
    const locator = new Locator({
      fetchImpl: (() => Promise.resolve(json(found))) as unknown as typeof fetch,
      encode: () => Promise.reject(new Error('canvas broke')),
      now: () => 0,
    })
    expect(await locator.locate('chair', [capture()])).toMatchObject({ ok: false, error: 'bad_request' })
  })
})

describe('messages', () => {
  const codes: LocateClientErrorCode[] = ['bad_request', 'timeout', 'quota', 'auth', 'bad_response', 'network', 'too_soon', 'limit']

  test('every error code has a spoken sentence', () => {
    for (const code of codes) expect(describeLocateError(code)).toBe(FIND_MESSAGES[code])
    expect(Object.keys(FIND_MESSAGES).sort()).toEqual([...codes, 'notFound'].sort())
  })

  test('not found says the search failed, never that the thing is absent', () => {
    expect(FIND_MESSAGES.notFound).toBe('I could not find it.')
  })
})
