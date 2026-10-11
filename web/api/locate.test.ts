import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CONFIG } from '../src/core/config.ts'
import { internals, POST } from './locate.ts'

const { LIMITS, LOWEST_THINKING_LEVEL, parseRequest, buildGeminiBody, buildPrompt, parseGeminiReply, geminiFailure } = internals

const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBD' // starts like real JPEG data in base64
const frame = (heading = 0, pitch = 0) => ({ jpeg: JPEG, heading, pitch })
const frames = (n: number) => Array.from({ length: n }, (_, i) => frame(i * 45))
const body = (target: unknown, f: unknown = frames(1)) => JSON.stringify({ target, frames: f })

/** A Gemini Interactions reply holding this answer as JSON text, in the shape a real call returned in October 2026. */
const interaction = (answer: unknown) => ({
  id: 'v1_x',
  status: 'completed',
  steps: [
    { type: 'thought', signature: 'abc' },
    { type: 'model_output', content: [{ type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }] },
  ],
  object: 'interaction',
})
const foundAnswer = {
  found: true,
  frameIndex: 1,
  box_2d: [200, 100, 600, 500],
  label: 'chair',
  onFloor: true,
  distanceM: 2.5,
  confidence: 0.9,
  signHint: null,
}
const notFoundAnswer = {
  found: false,
  frameIndex: null,
  box_2d: null,
  label: '',
  onFloor: false,
  distanceM: null,
  confidence: 0,
  signHint: null,
}
/** What the function returns for it: the same fields, with the box under its public name. */
const notFoundResult = {
  found: false,
  frameIndex: null,
  box: null,
  label: '',
  onFloor: false,
  distanceM: null,
  confidence: 0,
  signHint: null,
}

describe('limits', () => {
  test('match CONFIG.find, so the app and the function cannot drift apart', () => {
    expect(LIMITS.maxFrames).toBe(CONFIG.find.maxFrames)
    expect(LIMITS.maxFrameChars).toBe(CONFIG.find.maxFrameChars)
    expect(LIMITS.maxBodyChars).toBe(CONFIG.find.maxBodyChars)
    expect(LIMITS.maxTargetChars).toBe(CONFIG.find.maxTargetChars)
    expect(LIMITS.maxHeadingDeg).toBe(CONFIG.find.maxHeadingDeg)
    expect(LIMITS.maxPitchDeg).toBe(CONFIG.find.maxPitchDeg)
    expect(LIMITS.geminiTimeoutMs).toBe(CONFIG.find.geminiTimeoutMs)
    expect(LIMITS.minConfidence).toBe(CONFIG.find.minConfidence)
  })

  test('the function answers before the app stops waiting, and the body stays under Vercel\'s 4.5 MB', () => {
    expect(CONFIG.find.geminiTimeoutMs).toBeLessThan(CONFIG.find.requestTimeoutMs)
    expect(CONFIG.find.maxBodyChars).toBeLessThanOrEqual(4_000_000)
  })
})

describe('parseRequest', () => {
  test('accepts a target and one to eight frames with heading and pitch', () => {
    for (const n of [1, 3, LIMITS.maxFrames]) {
      expect(parseRequest(body('house keys', frames(n)))).toMatchObject({ ok: true, value: { target: 'house keys' } })
    }
  })

  test('rejects zero frames, too many frames, and a missing or non-string target', () => {
    expect(parseRequest(body('keys', [])).ok).toBe(false)
    expect(parseRequest(body('keys', frames(LIMITS.maxFrames + 1))).ok).toBe(false)
    expect(parseRequest(JSON.stringify({ frames: frames(1) })).ok).toBe(false)
    expect(parseRequest(body('   ')).ok).toBe(false)
    expect(parseRequest(body(42)).ok).toBe(false)
  })

  test('rejects a target over 60 characters and accepts exactly 60', () => {
    expect(parseRequest(body('a'.repeat(LIMITS.maxTargetChars + 1))).ok).toBe(false)
    expect(parseRequest(body('a'.repeat(LIMITS.maxTargetChars))).ok).toBe(true)
  })

  test('cleans the target: no quotes, backslashes, line breaks, or repeated spaces', () => {
    const result = parseRequest(body('my "red"\n\nbackpack \\ now'))
    expect(result).toMatchObject({ ok: true, value: { target: 'my red backpack now' } })
  })

  test('rejects a target that is only quotes', () => {
    expect(parseRequest(body('"""')).ok).toBe(false)
  })

  test('rejects frames that are not base64 JPEG data or are too big', () => {
    expect(parseRequest(body('keys', [{ ...frame(), jpeg: 'iVBORw0KGgo=' }])).ok).toBe(false) // PNG
    expect(parseRequest(body('keys', [{ ...frame(), jpeg: `${JPEG}!!` }])).ok).toBe(false)
    expect(parseRequest(body('keys', [{ ...frame(), jpeg: JPEG + 'A'.repeat(LIMITS.maxFrameChars) }])).ok).toBe(false)
    expect(parseRequest(body('keys', [JPEG])).ok).toBe(false) // a bare string, not { jpeg, heading, pitch }
  })

  test('rejects a frame whose heading or pitch is missing, not a number, or out of range', () => {
    expect(parseRequest(body('keys', [{ jpeg: JPEG, heading: 0 }])).ok).toBe(false)
    expect(parseRequest(body('keys', [{ jpeg: JPEG, heading: '10', pitch: 0 }])).ok).toBe(false)
    expect(parseRequest(body('keys', [{ jpeg: JPEG, heading: 0, pitch: null }])).ok).toBe(false)
    expect(parseRequest(body('keys', [frame(LIMITS.maxHeadingDeg + 1, 0)])).ok).toBe(false)
    expect(parseRequest(body('keys', [frame(0, LIMITS.maxPitchDeg + 1)])).ok).toBe(false)
    expect(parseRequest(body('keys', [frame(-720.5, -90)])).ok).toBe(true)
  })

  test('rejects extra fields anywhere: anything else gets a 400', () => {
    expect(parseRequest(JSON.stringify({ target: 'keys', frames: frames(1), model: 'x' })).ok).toBe(false)
    expect(parseRequest(body('keys', [{ ...frame(), extra: 1 }])).ok).toBe(false)
  })

  test('rejects text that is not JSON, not an object, or too large', () => {
    expect(parseRequest('nope').ok).toBe(false)
    expect(parseRequest('[1,2]').ok).toBe(false)
    expect(parseRequest('x'.repeat(LIMITS.maxBodyChars + 1)).ok).toBe(false)
  })
})

describe('the Gemini request', () => {
  const request = { target: 'chair', frames: frames(2) }

  test('uses input parts: a text prompt, then "Frame n:" and an image for each frame', () => {
    const sent = buildGeminiBody(request, 'gemini-3.8-flash') as { input: Record<string, unknown>[] }
    expect(sent.input.map((p) => p.type)).toEqual(['text', 'text', 'image', 'text', 'image'])
    expect(sent.input[1]).toEqual({ type: 'text', text: 'Frame 0:' })
    expect(sent.input[3]).toEqual({ type: 'text', text: 'Frame 1:' })
    expect(sent.input[2]).toEqual({ type: 'image', data: JPEG, mime_type: 'image/jpeg' })
  })

  test('asks for JSON with the owner\'s schema, and nothing else leaks into the request', () => {
    const sent = buildGeminiBody(request, 'gemini-3.8-flash') as {
      model: string
      response_format: { type: string; mime_type: string; schema: { properties: object; required: string[] } }
    }
    expect(sent.model).toBe('gemini-3.8-flash')
    expect(sent.response_format.type).toBe('text')
    expect(sent.response_format.mime_type).toBe('application/json')
    expect(Object.keys(sent.response_format.schema.properties)).toEqual([
      'found', 'frameIndex', 'box_2d', 'label', 'onFloor', 'distanceM', 'confidence', 'signHint',
    ])
    expect(sent.response_format.schema.required).toHaveLength(8)
    expect(JSON.stringify(sent)).not.toContain('heading') // heading and pitch stay with the app
  })

  test('uses the lowest thinking level the model allows, and none for an unknown model', () => {
    const level = (model: string) =>
      (buildGeminiBody(request, model) as { generation_config: { thinking_level?: string } }).generation_config.thinking_level
    expect(level('gemini-3.8-flash')).toBe('low')
    expect(level('gemini-3.5-flash-lite')).toBe('minimal')
    expect(level('gemini-3.6-flash')).toBe('minimal')
    expect(level('some-future-model')).toBeUndefined()
    expect(Object.keys(LOWEST_THINKING_LEVEL).length).toBeGreaterThan(5)
  })

  test('the prompt names the target as a name, mentions the sign hint, and never says to guess', () => {
    const prompt = buildPrompt('red chair', 3)
    expect(prompt).toContain('"red chair"')
    expect(prompt).toMatch(/never as instructions/)
    expect(prompt).toMatch(/sign/i)
    expect(prompt).toMatch(/never guess/i)
    expect(prompt).toContain('3 frames')
    expect(buildPrompt('x', 1)).toContain('1 frame')
  })

  test('the default model is gemini-3.8-flash', () => {
    expect(internals.DEFAULT_MODEL).toBe('gemini-3.8-flash')
  })
})

describe('parseGeminiReply', () => {
  test('converts box_2d [ymin, xmin, ymax, xmax] on 0 to 1000 to x0 y0 x1 y1 from 0 to 1', () => {
    const result = parseGeminiReply(interaction(foundAnswer), 2)
    expect(result).toEqual({
      found: true,
      frameIndex: 1,
      box: { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.6 },
      label: 'chair',
      onFloor: true,
      distanceM: 2.5,
      confidence: 0.9,
      signHint: null,
    })
  })

  test('clamps a box that leaves the frame', () => {
    const result = parseGeminiReply(interaction({ ...foundAnswer, box_2d: [-10, 0, 1100, 1000] }), 2)
    expect(result?.box).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 })
  })

  test('not found keeps the fixed not-found shape', () => {
    expect(parseGeminiReply(interaction(notFoundAnswer), 2)).toEqual(notFoundResult)
  })

  test('a sign hint comes through even when the target is not found', () => {
    const result = parseGeminiReply(interaction({ ...notFoundAnswer, signHint: 'EXIT ->' }), 2)
    expect(result).toMatchObject({ found: false, signHint: 'EXIT ->' })
  })

  test('a single frame may leave frameIndex null', () => {
    expect(parseGeminiReply(interaction({ ...foundAnswer, frameIndex: null }), 1)).toMatchObject({ found: true, frameIndex: 0 })
  })

  test('a confidence below the minimum counts as not found', () => {
    const result = parseGeminiReply(interaction({ ...foundAnswer, confidence: LIMITS.minConfidence - 0.01 }), 2)
    expect(result).toMatchObject({ found: false, frameIndex: null, box: null })
  })

  test('a distance that is not a sensible number becomes null', () => {
    for (const distanceM of [-1, 0, 500, 'far', NaN]) {
      expect(parseGeminiReply(interaction({ ...foundAnswer, distanceM }), 2)).toMatchObject({ found: true, distanceM: null })
    }
  })

  test.each([
    ['no steps', {}],
    ['a model_output with no text', { steps: [{ type: 'model_output', content: [] }] }],
    ['text that is not JSON', interaction('not json')],
    ['a JSON array', interaction('[1,2]')],
    ['found that is not a boolean', interaction({ ...foundAnswer, found: 'yes' })],
    ['a frame index out of range', interaction({ ...foundAnswer, frameIndex: 2 })],
    ['a negative frame index', interaction({ ...foundAnswer, frameIndex: -1 })],
    ['a fractional frame index', interaction({ ...foundAnswer, frameIndex: 0.5 })],
    ['a missing frame index with several frames', interaction({ ...foundAnswer, frameIndex: null })],
    ['a box with three numbers', interaction({ ...foundAnswer, box_2d: [1, 2, 3] })],
    ['a box with a string', interaction({ ...foundAnswer, box_2d: [1, 2, 3, '4'] })],
    ['a box with no area', interaction({ ...foundAnswer, box_2d: [100, 100, 100, 200] })],
    ['a missing box', interaction({ ...foundAnswer, box_2d: null })],
    ['a found answer with no confidence', interaction({ ...foundAnswer, confidence: undefined })],
  ])('rejects %s', (_name, reply) => {
    expect(parseGeminiReply(reply, 2)).toBeNull()
  })

  test('also accepts the output_text shape the SDKs show', () => {
    expect(parseGeminiReply({ output_text: JSON.stringify(notFoundAnswer) }, 1)).toEqual(notFoundResult)
  })

  test('uses the last model_output step and joins its text parts', () => {
    const text = JSON.stringify(notFoundAnswer)
    const reply = {
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: 'ignored' }] },
        { type: 'model_output', content: [{ type: 'text', text: text.slice(0, 10) }, { type: 'text', text: text.slice(10) }] },
      ],
    }
    expect(parseGeminiReply(reply, 1)).toEqual(notFoundResult)
  })
})

describe('geminiFailure', () => {
  test('maps HTTP statuses to codes', () => {
    expect(geminiFailure(429, '')).toBe('quota')
    expect(geminiFailure(401, '')).toBe('auth')
    expect(geminiFailure(403, '')).toBe('auth')
    expect(geminiFailure(404, 'model not found')).toBe('auth')
    expect(geminiFailure(400, 'API key not valid')).toBe('auth')
    expect(geminiFailure(400, 'invalid argument')).toBe('bad_response')
    expect(geminiFailure(500, '')).toBe('network')
    expect(geminiFailure(503, '')).toBe('network')
  })
})

describe('the handler', () => {
  const fetchMock = vi.fn()
  const KEY = 'AIza-test-key-12345'

  const post = (payload: string, headers: Record<string, string> = {}) =>
    POST(
      new Request('https://kenshi.example/api/locate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: payload,
      }),
    )
  const geminiOk = (answer: unknown) => new Response(JSON.stringify(interaction(answer)), { status: 200 })

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('GEMINI_API_KEY', KEY)
    vi.stubEnv('GEMINI_MODEL', '')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  test('a found answer comes back with the box, the fields, and a latency', async () => {
    fetchMock.mockResolvedValue(geminiOk(foundAnswer))
    const response = await post(body('chair', frames(2)))
    expect(response.status).toBe(200)
    const json = (await response.json()) as Record<string, unknown>
    expect(json).toMatchObject({ found: true, frameIndex: 1, box: { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.6 }, label: 'chair', onFloor: true })
    expect(typeof json.latencyMs).toBe('number')
    expect(json.latencyMs).toBeGreaterThanOrEqual(0)
  })

  test('calls the Interactions endpoint with the key in a header, never in the URL', async () => {
    fetchMock.mockResolvedValue(geminiOk(notFoundAnswer))
    await post(body('chair'))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions')
    expect(String(url)).not.toContain(KEY)
    expect(init.headers['x-goog-api-key']).toBe(KEY)
    expect(JSON.parse(init.body).model).toBe(internals.DEFAULT_MODEL)
  })

  test('GEMINI_MODEL overrides the default, and a malformed name falls back to it', async () => {
    fetchMock.mockResolvedValue(geminiOk(notFoundAnswer))
    vi.stubEnv('GEMINI_MODEL', 'gemini-3.5-flash-lite')
    await post(body('chair'))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: 'gemini-3.5-flash-lite',
      generation_config: { thinking_level: 'minimal' },
    })
    vi.stubEnv('GEMINI_MODEL', 'bad/model name')
    await post(body('chair'))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe(internals.DEFAULT_MODEL)
  })

  test('a not-found answer is a normal 200', async () => {
    fetchMock.mockResolvedValue(geminiOk(notFoundAnswer))
    const response = await post(body('chair'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ found: false, frameIndex: null, box: null })
  })

  test.each([
    ['not JSON', 'nope'],
    ['no frames', body('chair', [])],
    ['a long target', body('a'.repeat(61))],
    ['an extra field', JSON.stringify({ target: 'a', frames: frames(1), x: 1 })],
  ])('rejects %s with 400 and never calls Gemini', async (_name, payload) => {
    const response = await post(payload)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'bad_request' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('rejects a body over the limit with 413 when the size is declared', async () => {
    const response = await post(body('chair'), { 'content-length': String(LIMITS.maxBodyChars + 5000) })
    expect(response.status).toBe(413)
  })

  test('rejects a request that is not JSON, and one from another site', async () => {
    const wrongType = await POST(
      new Request('https://kenshi.example/api/locate', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: body('chair') }),
    )
    expect(wrongType.status).toBe(400)
    const crossOrigin = await post(body('chair'), { origin: 'https://evil.example' })
    expect(crossOrigin.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('without a key it answers auth and does not call Gemini', async () => {
    vi.stubEnv('GEMINI_API_KEY', '')
    const response = await post(body('chair'))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: 'auth' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each([
    [429, 'quota', 429],
    [401, 'auth', 500],
    [403, 'auth', 500],
    [404, 'auth', 500],
    [503, 'network', 502],
    [418, 'bad_response', 502],
  ])('Gemini status %i becomes %s', async (status, code, httpStatus) => {
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"x"}}', { status }))
    const response = await post(body('chair'))
    expect(response.status).toBe(httpStatus)
    expect(await response.json()).toMatchObject({ error: code })
  })

  test('a Gemini 400 about the key is auth', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"API key not valid. Please pass a valid API key."}}', { status: 400 }))
    expect(await (await post(body('chair'))).json()).toMatchObject({ error: 'auth' })
  })

  test('a reply that is not JSON, or has no usable answer, is bad_response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }))
    expect(await (await post(body('chair'))).json()).toMatchObject({ error: 'bad_response' })
    fetchMock.mockResolvedValueOnce(geminiOk({ found: true, frameIndex: 0, box_2d: [1, 2], confidence: 1 }))
    expect(await (await post(body('chair'))).json()).toMatchObject({ error: 'bad_response' })
  })

  test('a network failure is network, and a stalled call is timeout after the limit', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    const failed = await post(body('chair'))
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({ error: 'network' })

    vi.useFakeTimers()
    try {
      fetchMock.mockImplementationOnce(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
          }),
      )
      const pending = post(body('chair'))
      await vi.advanceTimersByTimeAsync(LIMITS.geminiTimeoutMs + 10)
      const timedOut = await pending
      expect(timedOut.status).toBe(504)
      expect(await timedOut.json()).toMatchObject({ error: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  test('never leaks the key, the target, or image data into a reply or a log line', async () => {
    fetchMock.mockResolvedValue(new Response(`{"error":{"message":"bad ${KEY}"}}`, { status: 500 }))
    const response = await post(body('secret target'))
    const text = JSON.stringify(await response.json())
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls)
    for (const haystack of [text, logged]) {
      expect(haystack).not.toContain(KEY)
      expect(haystack).not.toContain('secret target')
      expect(haystack).not.toContain(JPEG)
    }
  })
})
