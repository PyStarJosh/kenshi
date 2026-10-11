// Export of a test log: shared as a .jsonl file through the Web Share API (the iPhone share sheet), with a
// download link as the fallback. Call saveLog directly from a tap: share() needs the user gesture.

export type SaveResult = 'shared' | 'downloaded' | 'cancelled'

/** The parts of the browser that saveLog uses, so tests can stand in for them. */
export interface ExportEnv {
  canShare?: (data: { files: File[] }) => boolean
  share?: (data: { files: File[]; title: string }) => Promise<void>
  /** Starts a download of the file; returns when the click has been issued. */
  download: (file: File) => void
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** walk-2026-10-10-143005.jsonl, in the phone's local time. */
export function logFileName(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `walk-${day}-${time}.jsonl`
}

// The share sheet is stricter about file types than a download; try the honest type first, then plain text.
const TYPES = ['application/x-ndjson', 'text/plain']

export function buildLogFile(lines: readonly string[], name: string, type: string = TYPES[0]): File {
  return new File(lines.map((line) => `${line}\n`), name, { type })
}

export function browserExportEnv(): ExportEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  return {
    canShare: nav && typeof nav.canShare === 'function' ? (data) => nav.canShare(data) : undefined,
    share: nav && typeof nav.share === 'function' ? (data) => nav.share(data) : undefined,
    download: (file) => {
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name
      document.body.append(link)
      link.click()
      link.remove()
      // Safari needs the URL to live a moment after the click.
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    },
  }
}

export async function saveLog(lines: readonly string[], date: Date, env: ExportEnv = browserExportEnv()): Promise<SaveResult> {
  const name = logFileName(date)
  if (env.share && env.canShare) {
    for (const type of TYPES) {
      const file = buildLogFile(lines, name, type)
      if (!env.canShare({ files: [file] })) continue
      try {
        await env.share({ files: [file], title: name })
        return 'shared'
      } catch (error) {
        // Closing the share sheet is a choice, not a failure.
        if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
        break // any other share failure: fall back to a download
      }
    }
  }
  env.download(buildLogFile(lines, name))
  return 'downloaded'
}
