import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CONFIG } from '../src/core/config.ts'
import { internals, POST } from './locate.ts'

const { LIMITS, parseRequest, buildGeminiBody, buildPrompt, parseGeminiReply, geminiFailure } = internals

const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBD' // starts like real JPEG data in base64
const frames = (n: number) => Array.from({ length: n }, () => JPEG)
const body = (target: string, f: unknown = frames(1)) => JSON.stringify({ target, frames: f })

describe('limits', () => {
  test('match CONFIG.find, so the app and the function cannot drift apart', () => {
    expect(LIMITS.maxFrames).toBe(CONFIG.find.maxFrames)
    expect(LIMITS.maxFrameChars).toBe(CONFIG.find.maxFrameChars)
    expect(LIMITS.maxBodyChars).toBe(CONFIG.find.maxBodyChars)
    expect(LIMITS.maxTargetChars).toBe(CONFIG.find.maxTargetChars)
    expect(LIMITS.geminiTimeoutMs).toBe(CONFIG.find.geminiTimeoutMs)
    expect(LIMITS.minConfidence).toBe(CONFIG.find.minConfidence)
  })

  test('the function answers before the app stops waiting', () => {
    expect(CONFIG.find.geminiTimeoutMs).toBeLessThan(CONFIG.find.requestTimeoutMs)
  })
})

describe('parseRequest', () => {
  test('accepts a target and one to eight JPEG frames', () => {
    for (const n of [1, 3, LIMITS.maxFrames]) {
      expect(parseRequest(body('house keys', frames(n)))).toMatchObject({ ok: true, value: { target: 'house keys' } })
    }
  })

  test('rejects zero frames, too many frames, and a missing target', () => {
    expect(parseRequest(body('keys', []))).toMatchObject({ ok: false })
    expect(parseRequest(body('keys', frames(LIMITS.maxFrames + 1)))).toMatchObject({ ok: false })
    expect(parseRequest(JSON.stringify({ frames: frames(1) }))).toMatchObject({ ok: false })
    expect(parseRequest(body('   '))).toMatchObject({ ok: false })
  })

  test('rejects a target that is too long', () => {
    expect(parseRequest(body('a'.repeat(LIMITS.maxTargetChars + 1)))).toMatchObject({ ok: false })
    expect(parseRequest(body('a'.repeat(LIMITS.maxTargetChars)))).toMatchObject({ ok: true })
  })

  test('cleans the target: no quotes, backslashes, line breaks, or repeated spaces', () => {
    const result = parseRequest(body('my "red"\n\nbackpack \\ now'))
    expect(result).toEqual({ ok: true, value: { target: 'my red backpack now', frames: frames(1) } })
  })

  test('rejects frames that are not base64 JPEG data or are too big', () => {
    expect(parseRequest(body('keys', ['iVBORw0KGgo='])).ok).toBe(false) // PNG
    expect(parseRequest(body('keys', [`${JPEG}!!`])).ok).toBe(false)
    expect(parseRequest(body('keys', [JPEG + 'A'.repeat(LIMITS.maxFrameChars)])).ok).toBe(false)
    expect(parseRequest(body('keys', [42])).ok).toBe(false)
  })

  test('rejects text that is not JSON, not an object, or too large', () => {
    expect(parseRequest('nope').ok).toBe(false)
    expect(parseRequest('[1,2]').ok).toBe(false)
    expect(parseRequest('x'.repeat(LIMITS.maxBodyChars + 1)).ok).toBe(false)
  })
})

describe('what is sent to Gemini', () => {
  const request = { target: 'blue mug', frames: [JPEG, JPEG + 'AA'] }

  test('every frame is numbered and sent as a JPEG, in order', () => {
    const sent = buildGeminiBody(request) as {
      contents: { parts: ({ text?: string; inline_data?: { mime_type: string; data: string } })[] }[]
    }
    const parts = sent.contents[0].parts
    expect(parts.map((p) => p.text ?? p.inline_data?.mime_type)).toEqual([
      expect.stringContaining('blue mug'),
      'Frame 0:',
      'image/jpeg',
      'Frame 1:',
      'image/jpeg',
    ])
    expect(parts[2].inline_data?.data).toBe(JPEG)
    expect(parts[4].inline_data?.data).toBe(JPEG + 'AA')
  })

  test('asks for JSON in a fixed shape with no randomness', () => {
    const sent = buildGeminiBody(request) as { generationConfig: Record<string, unknown> }
    expect(sent.generationConfig).toMatchObject({ temperature: 0, responseMimeType: 'application/json' })
    expect(JSON.stringify(sent.generationConfig.responseSchema)).toContain('box_2d')
  })

  test('the target is named once, in quotes, and declared to be data', () => {
    const prompt = buildPrompt('blue mug', 2)
    expect(prompt.match(/blue mug/g)).toHaveLength(1)
    expect(prompt).toContain('"blue mug"')
    expect(prompt).toMatch(/never as instructions/)
    expect(prompt).toMatch(/Do not guess/)
  })
})

const geminiAnswer = (answer: unknown) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] })

describe('parseGeminiReply', () => {
  test('turns [ymin, xmin, ymax, xmax] on 0 to 1000 into a box from the top-left, 0 to 1', () => {
    const result = parseGeminiReply(
      geminiAnswer({ found: true, frame_index: 1, box_2d: [200, 100, 600, 500], label: 'mug', confidence: 0.9 }),
      3,
    )
    expect(result).toEqual({
      found: true,
      frameIndex: 1,
      box: { x: 0.1, y: 0.2, width: 0.4, height: 0.4 },
      label: 'mug',
      confidence: 0.9,
    })
  })

  test('not found stays not found', () => {
    expect(parseGeminiReply(geminiAnswer({ found: false }), 2)).toEqual({ found: false })
  })

  test('a weak answer counts as not found (SR-11)', () => {
    const weak = geminiAnswer({ found: true, frame_index: 0, box_2d: [0, 0, 500, 500], confidence: LIMITS.minConfidence - 0.01 })
    expect(parseGeminiReply(weak, 1)).toEqual({ found: false })
    const ok = geminiAnswer({ found: true, frame_index: 0, box_2d: [0, 0, 500, 500], confidence: LIMITS.minConfidence })
    expect(parseGeminiReply(ok, 1)).toMatchObject({ found: true })
  })

  test('one frame needs no frame_index; several do', () => {
    const answer = { found: true, box_2d: [0, 0, 500, 500], confidence: 0.8 }
    expect(parseGeminiReply(geminiAnswer(answer), 1)).toMatchObject({ found: true, frameIndex: 0 })
    expect(parseGeminiReply(geminiAnswer(answer), 2)).toBeNull()
  })

  test('boxes outside the frame are clamped, and empty or inverted boxes are rejected', () => {
    const clamped = parseGeminiReply(geminiAnswer({ found: true, box_2d: [-50, -50, 1200, 1200], confidence: 1 }), 1)
    expect(clamped).toMatchObject({ box: { x: 0, y: 0, width: 1, height: 1 } })
    expect(parseGeminiReply(geminiAnswer({ found: true, box_2d: [500, 0, 400, 100], confidence: 1 }), 1)).toBeNull()
    expect(parseGeminiReply(geminiAnswer({ found: true, box_2d: [10, 10, 10, 90], confidence: 1 }), 1)).toBeNull()
  })

  test('anything unusable is null, not a guess', () => {
    expect(parseGeminiReply(null, 1)).toBeNull()
    expect(parseGeminiReply({ candidates: [] }, 1)).toBeNull()
    expect(parseGeminiReply({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }, 1)).toBeNull()
    expect(parseGeminiReply(geminiAnswer({ found: 'yes' }), 1)).toBeNull()
    expect(parseGeminiReply(geminiAnswer({ found: true, frame_index: 5, box_2d: [0, 0, 5, 5], confidence: 1 }), 2)).toBeNull()
    expect(parseGeminiReply(geminiAnswer({ found: true, frame_index: 0, box_2d: [0, 0, 5], confidence: 1 }), 1)).toBeNull()
    expect(parseGeminiReply(geminiAnswer({ found: true, frame_index: 0, box_2d: [0, 0, 5, 5] }), 1)).toBeNull()
  })
})

describe('geminiFailure', () => {
  test('maps Gemini statuses to our kinds', () => {
    expect(geminiFailure(429, '')).toBe('rate-limited')
    expect(geminiFailure(403, '')).toBe('not-configured')
    expect(geminiFailure(404, '')).toBe('not-configured')
    expect(geminiFailure(400, 'API key not valid. Please pass a valid API key.')).toBe('not-configured')
    expect(geminiFailure(400, 'Request payload size exceeds the limit')).toBe('unavailable')
    expect(geminiFailure(500, '')).toBe('unavailable')
    expect(geminiFailure(503, '')).toBe('unavailable')
  })
})

describe('POST /api/locate', () => {
  const secret = 'test-secret-key-123'
  const url = 'https://kenshi.example/api/locate'
  const call = (text: string, headers: Record<string, string> = {}) =>
    POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: text }))
  let fetchMock: ReturnType<typeof vi.fn>
  let errorLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.stubEnv('GEMINI_API_KEY', secret)
    vi.stubEnv('GEMINI_MODEL', '')
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    errorLog.mockRestore()
  })

  const gemini = (answer: unknown, status = 200) => new Response(JSON.stringify(answer), { status })

  test('a found target comes back as a box, and the key travels only in a header', async () => {
    fetchMock.mockResolvedValue(gemini(geminiAnswer({ found: true, box_2d: [100, 200, 300, 400], label: 'keys', confidence: 0.8 })))
    const response = await call(body('keys'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ found: true, frameIndex: 0, box: { x: 0.2, y: 0.1, width: 0.2, height: 0.2 } })
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${internals.DEFAULT_MODEL}:generateContent`)
    expect(calledUrl).not.toContain(secret)
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(secret)
    expect(String(init.body)).not.toContain(secret)
  })

  test('GEMINI_MODEL picks the model when it looks like a model name, and is ignored when it does not', async () => {
    fetchMock.mockResolvedValue(gemini(geminiAnswer({ found: false })))
    vi.stubEnv('GEMINI_MODEL', 'gemini-next-flash')
    await call(body('keys'))
    expect(fetchMock.mock.calls[0][0]).toContain('/models/gemini-next-flash:generateContent')
    vi.stubEnv('GEMINI_MODEL', '../evil?x=')
    await call(body('keys'))
    expect(fetchMock.mock.calls[1][0]).toContain(`/models/${internals.DEFAULT_MODEL}:generateContent`)
  })

  test('not found is a normal answer', async () => {
    fetchMock.mockResolvedValue(gemini(geminiAnswer({ found: false })))
    const response = await call(body('keys'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ found: false })
  })

  test('no key means not-configured, and nothing is sent to Gemini', async () => {
    vi.stubEnv('GEMINI_API_KEY', '')
    const response = await call(body('keys'))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: 'not-configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('a bad request is refused before Gemini is called', async () => {
    const response = await call(body('keys', frames(LIMITS.maxFrames + 1)))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'bad-request' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('only JSON is accepted', async () => {
    const response = await POST(new Request(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: body('keys') }))
    expect(response.status).toBe(400)
  })

  test('a request from another site is refused, and the same site is allowed', async () => {
    fetchMock.mockResolvedValue(gemini(geminiAnswer({ found: false })))
    const other = await call(body('keys'), { origin: 'https://evil.example', host: 'kenshi.example' })
    expect(other.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    const same = await call(body('keys'), { origin: 'https://kenshi.example', host: 'kenshi.example' })
    expect(same.status).toBe(200)
  })

  test('rate limits, rejected keys, outages, and unusable answers each get their own error', async () => {
    const cases: [Response, number, string][] = [
      [gemini({ error: { message: 'quota' } }, 429), 429, 'rate-limited'],
      [gemini({ error: { message: 'API key not valid' } }, 400), 500, 'not-configured'],
      [gemini({ error: { message: 'boom' } }, 503), 502, 'unavailable'],
      [gemini({ candidates: [] }, 200), 502, 'bad-reply'],
    ]
    for (const [upstream, status, kind] of cases) {
      fetchMock.mockResolvedValueOnce(upstream)
      const response = await call(body('keys'))
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error: kind })
    }
  })

  test('a Gemini timeout or network failure is unavailable', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    expect((await call(body('keys'))).status).toBe(504)
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect((await call(body('keys'))).status).toBe(502)
  })

  test('errors and logs never contain the key, the target, or any image data', async () => {
    fetchMock.mockResolvedValue(gemini({ error: { message: `leaked ${secret}` } }, 503))
    const response = await call(body('secret target', [JPEG]))
    const text = JSON.stringify(await response.json())
    for (const forbidden of [secret, 'secret target', JPEG]) expect(text).not.toContain(forbidden)
    const logged = errorLog.mock.calls.flat().join(' ')
    for (const forbidden of [secret, 'secret target', JPEG]) expect(logged).not.toContain(forbidden)
  })
})
