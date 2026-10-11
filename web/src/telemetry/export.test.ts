import { describe, expect, test, vi } from 'vitest'
import { buildLogFile, logFileName, saveLog } from './export'
import type { ExportEnv } from './export'

const LINES = ['{"kind":"session"}', '{"kind":"frame"}']
const DATE = new Date(2026, 9, 10, 14, 30, 5)

describe('logFileName', () => {
  test('is walk-<date>-<time>.jsonl in local time', () => {
    expect(logFileName(DATE)).toBe('walk-2026-10-10-143005.jsonl')
    expect(logFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe('walk-2026-01-02-030405.jsonl')
  })
})

describe('buildLogFile', () => {
  test('writes one JSON entry per line, ending with a newline', async () => {
    const file = buildLogFile(LINES, 'x.jsonl')
    expect(file.name).toBe('x.jsonl')
    expect(await file.text()).toBe('{"kind":"session"}\n{"kind":"frame"}\n')
  })
})

describe('saveLog', () => {
  const env = (patch: Partial<ExportEnv> = {}): ExportEnv & { download: ReturnType<typeof vi.fn> } => ({
    download: vi.fn(),
    ...patch,
  }) as ExportEnv & { download: ReturnType<typeof vi.fn> }

  test('shares the file through the share sheet when the browser can', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const e = env({ canShare: () => true, share })
    await expect(saveLog(LINES, DATE, e)).resolves.toBe('shared')
    expect(share).toHaveBeenCalledOnce()
    expect(share.mock.calls[0][0].files[0].name).toBe('walk-2026-10-10-143005.jsonl')
    expect(e.download).not.toHaveBeenCalled()
  })

  test('tries plain text when the share sheet refuses the first file type', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const types: string[] = []
    const e = env({
      canShare: ({ files }) => (types.push(files[0].type), files[0].type === 'text/plain'),
      share,
    })
    await expect(saveLog(LINES, DATE, e)).resolves.toBe('shared')
    expect(types).toEqual(['application/x-ndjson', 'text/plain'])
  })

  test('downloads the file when sharing is not possible', async () => {
    const e = env({ canShare: () => false, share: vi.fn() })
    await expect(saveLog(LINES, DATE, e)).resolves.toBe('downloaded')
    expect(e.download.mock.calls[0][0].name).toBe('walk-2026-10-10-143005.jsonl')
  })

  test('downloads when the browser has no share API at all', async () => {
    const e = env()
    await expect(saveLog(LINES, DATE, e)).resolves.toBe('downloaded')
  })

  test('closing the share sheet is not a failure and does not start a download', async () => {
    const e = env({ canShare: () => true, share: vi.fn().mockRejectedValue(new DOMException('closed', 'AbortError')) })
    await expect(saveLog(LINES, DATE, e)).resolves.toBe('cancelled')
    expect(e.download).not.toHaveBeenCalled()
  })

  test('falls back to a download when sharing fails for another reason', async () => {
    const e = env({ canShare: () => true, share: vi.fn().mockRejectedValue(new Error('boom')) })
    await expect(saveLog(LINES, DATE, e)).resolves.toBe('downloaded')
    expect(e.download).toHaveBeenCalledOnce()
  })
})
