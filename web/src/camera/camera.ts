// Rear camera: opens the stream, prefers the plain wide lens, and reports problems as typed errors.
import { CONFIG } from '../core/config'

export type CameraErrorKind =
  | 'permission-denied'
  | 'no-camera'
  | 'camera-busy'
  | 'insecure-page'
  | 'unknown'

/** One short sentence per kind, ready to be spoken and shown. */
const SPOKEN: Record<CameraErrorKind, string> = {
  'permission-denied': 'Camera access is blocked, so allow it in Safari settings and press Start.',
  'no-camera': 'No camera was found on this device.',
  'camera-busy': 'The camera is in use by another app, so close that app and press Start.',
  'insecure-page': 'The camera needs a secure page, so open this app with an https address.',
  unknown: 'The camera could not start, so press Start to try again.',
}

export class CameraError extends Error {
  kind: CameraErrorKind
  /** Ready to be spoken and written to the status line. */
  spoken: string
  constructor(kind: CameraErrorKind, detail?: string) {
    super(detail ? `${kind}: ${detail}` : kind)
    this.name = 'CameraError'
    this.kind = kind
    this.spoken = SPOKEN[kind]
  }
}

/** Turn whatever getUserMedia or play() threw into a CameraError. */
export function mapCameraError(error: unknown): CameraError {
  if (error instanceof CameraError) return error
  const name = error instanceof Error ? error.name : ''
  const detail = error instanceof Error ? error.message : String(error)
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return new CameraError('permission-denied', detail)
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new CameraError('no-camera', detail)
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError('camera-busy', detail)
    default:
      return new CameraError('unknown', detail)
  }
}

type DeviceSummary = Pick<MediaDeviceInfo, 'deviceId' | 'label' | 'kind'>

// Labels of virtual or non-main lenses. iPhones use "Back Dual Camera", "Back Triple Camera",
// "Back Ultra Wide Camera", and "Back Telephoto Camera".
const MULTI_LENS = /dual|triple|ultra|telephoto|tele\b|virtual/i
const BACK = /back|rear|environment/i

/**
 * Pick the plain wide back camera. Virtual multi-lens devices can switch lenses on their own,
 * which changes the field of view the distance math depends on. Returns null if nothing suitable
 * is listed (the caller keeps the stream it already has).
 */
export function chooseBackCamera(devices: readonly DeviceSummary[]): string | null {
  const back = devices.filter((d) => d.kind === 'videoinput' && BACK.test(d.label))
  const exact = back.find((d) => /^back camera$/i.test(d.label.trim()))
  if (exact) return exact.deviceId
  const single = back.find((d) => !MULTI_LENS.test(d.label))
  return single ? single.deviceId : null
}

/** The part of localStorage the camera needs, to remember which lens it used. */
export interface LensStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const LENS_KEY = 'kenshi.camera.lens.v1'

function browserStorage(): LensStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** A refusal is final; anything else when opening a remembered lens means it is gone and the lens is chosen again. */
function isRefusal(error: unknown): boolean {
  const name = error instanceof Error ? error.name : ''
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError'
}

export interface FrameSize {
  width: number
  height: number
}

export interface CameraInfo {
  label: string
  frameSize: FrameSize
}

export class Camera {
  private getVideo: () => HTMLVideoElement | null
  private storage: LensStorage | null
  private stream: MediaStream | null = null
  private endedListeners = new Set<() => void>()
  private sizeListeners = new Set<(size: FrameSize) => void>()
  private removeVideoListener: (() => void) | null = null
  private removeTrackListener: (() => void) | null = null

  /** getVideo may return null once the element is gone (a screen was closed); stop() then has nothing to detach. */
  constructor(getVideo: () => HTMLVideoElement | null, storage: LensStorage | null = browserStorage()) {
    this.getVideo = getVideo
    this.storage = storage
  }

  /** The stream is open and its picture still live (a pause keeps it, so resuming needs no new permission prompt). */
  isLive(): boolean {
    return this.stream?.getVideoTracks().some((track) => track.readyState === 'live') ?? false
  }

  /** Play the kept stream again after a pause (iOS pauses the video element while the page is hidden). */
  async resumePlayback(): Promise<CameraInfo> {
    const video = this.getVideo()
    const track = this.stream?.getVideoTracks()[0]
    if (!video || !track) throw new CameraError('unknown', 'There is no stream to resume.')
    try {
      if (video.paused) await video.play()
    } catch (error) {
      throw mapCameraError(error)
    }
    const settings = track.getSettings()
    return { label: track.label, frameSize: this.frameSize ?? { width: settings.width ?? 0, height: settings.height ?? 0 } }
  }

  /** Current frame size, or null before the first frame. */
  get frameSize(): FrameSize | null {
    const video = this.getVideo()
    return video && video.videoWidth > 0 ? { width: video.videoWidth, height: video.videoHeight } : null
  }

  /** Called when the frame size changes, for example after the phone is rotated. */
  onFrameSize(listener: (size: FrameSize) => void): () => void {
    this.sizeListeners.add(listener)
    return () => this.sizeListeners.delete(listener)
  }

  /** Called when the camera stops by itself (taken by another app, unplugged). */
  onEnded(listener: () => void): () => void {
    this.endedListeners.add(listener)
    return () => this.endedListeners.delete(listener)
  }

  /** Open the camera. Call this from the Start tap. Throws a CameraError. */
  async start(): Promise<CameraInfo> {
    this.stop()
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('insecure-page')
    }
    try {
      // The lens chosen last time is opened straight away: one stream, so one permission prompt, instead of opening the
      // default camera and then switching lenses.
      let stream = await this.openRememberedLens()
      if (!stream) {
        stream = await open({ facingMode: { ideal: 'environment' } })
        stream = await this.preferPlainBackCamera(stream)
      }
      this.stream = stream
      const video = this.getVideo()
      if (!video) throw new Error('The video element is not mounted')
      video.muted = true
      video.playsInline = true
      video.autoplay = true
      video.srcObject = stream
      const onResize = () => {
        const size = this.frameSize
        if (size) for (const listener of this.sizeListeners) listener(size)
      }
      video.addEventListener('resize', onResize)
      this.removeVideoListener = () => video.removeEventListener('resize', onResize)
      const track = stream.getVideoTracks()[0]
      const onEnded = () => {
        for (const listener of this.endedListeners) listener()
      }
      track.addEventListener('ended', onEnded)
      this.removeTrackListener = () => track.removeEventListener('ended', onEnded)
      await video.play()
      this.rememberLens(track.getSettings().deviceId)
      const label = track.label
      // Deliberate: the chosen lens must be visible in the console during phone testing.
      console.info(`[camera] using "${label}"`)
      const settings = track.getSettings()
      return {
        label,
        frameSize: this.frameSize ?? { width: settings.width ?? 0, height: settings.height ?? 0 },
      }
    } catch (error) {
      this.stop()
      throw mapCameraError(error)
    }
  }

  /** Release the camera. Safe to call at any time. */
  stop(): void {
    this.removeVideoListener?.()
    this.removeTrackListener?.()
    this.removeVideoListener = null
    this.removeTrackListener = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    const video = this.getVideo()
    if (video) video.srcObject = null
  }

  /** The remembered lens, opened directly, or null when there is none or it cannot be opened any more. */
  private async openRememberedLens(): Promise<MediaStream | null> {
    let deviceId: string | null = null
    try {
      deviceId = this.storage?.getItem(LENS_KEY) ?? null
    } catch {
      deviceId = null
    }
    if (!deviceId) return null
    try {
      return await open({ deviceId: { exact: deviceId } })
    } catch (error) {
      if (isRefusal(error)) throw error
      this.rememberLens(undefined)
      return null
    }
  }

  private rememberLens(deviceId: string | undefined): void {
    try {
      if (deviceId) this.storage?.setItem(LENS_KEY, deviceId)
      else this.storage?.removeItem(LENS_KEY)
    } catch {
      // Storage blocked: the lens is chosen again next time, which costs one more stream at start.
    }
  }

  /** Labels only appear after permission, so the lens is chosen after the first stream opens. */
  private async preferPlainBackCamera(stream: MediaStream): Promise<MediaStream> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const preferred = chooseBackCamera(devices)
    const current = stream.getVideoTracks()[0]?.getSettings().deviceId
    if (!preferred || preferred === current) return stream
    try {
      const better = await open({ deviceId: { exact: preferred } })
      stream.getTracks().forEach((track) => track.stop())
      return better
    } catch {
      // The preferred lens could not be opened; the stream we already have still works.
      return stream
    }
  }
}

function open(constraints: MediaTrackConstraints): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: { ideal: CONFIG.camera.width },
      height: { ideal: CONFIG.camera.height },
      ...constraints,
    },
  })
}
