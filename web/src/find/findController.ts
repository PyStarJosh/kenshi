// The Find controller (R4, FR-21 to FR-25): a pure reducer. It takes the current context and one event and returns the
// new context plus a list of effects (things to say, a locate call to make, a sweep frame to capture). The adapter in
// app/findRunner.ts feeds it events and carries the effects out; nothing here touches a clock, a sensor, or the
// network, so every transition is tested with plain objects.
//
//   idle -> checking -> guiding -> arrived -> idle
//              |           |
//              v           v (two failed re-checks, or a stale memory)
//          sweeping      lost -> sweeping
//              |
//              v
//        sweepChecking -> guiding, or notFound -> idle;   every look failed -> error -> idle;   cancel -> idle
//
// While sweeping, each frame taken about every 45 degrees is sent on its own as soon as it is captured, so the first
// look that finds the target ends the search (guiding). sweepChecking only waits for the looks still out.
//
// A target the on-device detector already sees skips the network: request -> guiding with source 'yolo'.
// All thresholds are in CONFIG.find. Nothing here says the way is clear or safe (SR-2), and "not found" is only ever
// a limit of the search (SR-11).
import { CONFIG } from '../core/config'
import type { FindSnapshot, FindStateName, LocateResult } from '../core/types'
import { roundDistance } from '../geometry/geometry'
import type { FrameDims } from '../geometry/geometry'
import {
  arrivedPhrase,
  classifyDirection,
  directionPhrase,
  FIND_PHRASES,
  foundPhrase,
  lookingFor,
  lostPhrase,
  notFoundPhrase,
} from './phrases'
import type { Direction } from './phrases'
import { FIND_MESSAGES } from './messages'
import type { LocateClientErrorCode } from './locateClient'
import { bearing, boxCenterX, estimateTargetDistance, inView, isStale, observe, remember } from './targetMemory'
import type { TargetMemory } from './targetMemory'
import { cleanTarget } from './targets'

type FindConfig = typeof CONFIG.find

export interface FindContext {
  state: FindStateName
  /** The thing being looked for, as the user named it (cleaned). */
  target: string
  /** The phone gave no heading when the search began: single-frame search only, no sweep and no guiding. */
  noHeading: boolean
  /** The privacy notice was spoken in this session; it is never spoken twice. */
  privacyAnnounced: boolean
  memory: TargetMemory | null
  /** Sign text Gemini read that may point toward the target. */
  signHint: string | null
  /** When the current state began (performance.now()). */
  enteredAt: number
  /** The last time the controller said something; a search never waits silently for long. */
  lastFeedbackAt: number
  /** The id of the locate call whose answer is awaited; an answer with another id is old and ignored. */
  pending: number | null
  nextId: number
  // Sweep
  sweepFrames: number
  sweepLastHeading: number | null
  sweepTurned: number
  sweepSeenHeading: number | null
  sweepProgressAt: number
  sweepReminded: boolean
  /** The heading at the last look (the first check or a pause check), so a pause check needs a real turn since. */
  sweepCheckHeading: number | null
  /** A pause check was made during this stillness; the next one waits for the user to move again. */
  sweepDwellChecked: boolean
  /** Ids of the per-frame looks still out; every sweep frame is its own request. */
  sweepPending: number[]
  /** How many of those looks came back without the target, and how many failed (and the last failure's code). */
  sweepAnswered: number
  sweepFailures: number
  sweepLastCode: LocateClientErrorCode | null
  // Guiding
  rechecking: boolean
  failedRechecks: number
  lastRecheckAt: number
  lastSpokenDirection: Direction | null
  lastDirectionAt: number
}

export function initialContext(): FindContext {
  return {
    state: 'idle',
    target: '',
    noHeading: false,
    privacyAnnounced: false,
    memory: null,
    signHint: null,
    enteredAt: 0,
    lastFeedbackAt: 0,
    pending: null,
    nextId: 0,
    sweepFrames: 0,
    sweepLastHeading: null,
    sweepTurned: 0,
    sweepSeenHeading: null,
    sweepProgressAt: 0,
    sweepReminded: false,
    sweepCheckHeading: null,
    sweepDwellChecked: false,
    sweepPending: [],
    sweepAnswered: 0,
    sweepFailures: 0,
    sweepLastCode: null,
    rechecking: false,
    failedRechecks: 0,
    lastRecheckAt: 0,
    lastSpokenDirection: null,
    lastDirectionAt: 0,
  }
}

/** A target the on-device detector sees right now: its bearing from straight ahead (positive right) and distance. */
export interface YoloSighting {
  angleDeg: number
  distanceM: number | null
}

/** The heading and pitch a sent frame was taken at; null where the phone gave none. */
export interface FrameMeta {
  heading: number | null
  pitch: number | null
}

export type FindEvent =
  | { type: 'request'; target: string; nowMs: number; heading: number | null; yolo: YoloSighting | null }
  | { type: 'cancel' }
  | {
      type: 'tick'
      nowMs: number
      heading: number | null
      yolo: YoloSighting | null
      /** A paced call (the first check, a guiding re-check) would be allowed now. */
      canLocate: boolean
      /** An unpaced look (a pause look) would be allowed now: under the per-minute and concurrency caps. */
      canLook: boolean
    }
  | { type: 'located'; id: number; nowMs: number; heading: number | null; result: LocateResult; frames: FrameMeta[] }
  | { type: 'failed'; id: number; nowMs: number; code: LocateClientErrorCode }

export type FindEffect =
  | { type: 'speak'; text: string }
  /** Look for the target in the current frame. A paced call waits for the gap since the last call; a pause look does not. */
  | { type: 'locate'; id: number; paced: boolean }
  /** Capture one sweep frame now, with a soft tick, and send it on its own as a look with this id (no gap). */
  | { type: 'capture'; id: number }

export interface FindEnv {
  hfovDeg: number
  eyeHeightM: number
  /** The shape of the frames sent (only the aspect matters). */
  frame: FrameDims
}

export interface FindStep {
  ctx: FindContext
  effects: FindEffect[]
}

interface Draft {
  c: FindContext
  effects: FindEffect[]
  env: FindEnv
  cfg: FindConfig
}

function say(d: Draft, nowMs: number, ...parts: string[]): void {
  const text = parts.filter((part) => part.length > 0).join(' ')
  if (text.length === 0) return
  d.effects.push({ type: 'speak', text })
  d.c.lastFeedbackAt = nowMs
}

function toIdle(d: Draft): void {
  const { privacyAnnounced, nextId } = d.c
  Object.assign(d.c, initialContext(), { privacyAnnounced, nextId })
}

function issueLocate(d: Draft, paced: boolean): void {
  d.c.nextId += 1
  d.c.pending = d.c.nextId
  d.effects.push({ type: 'locate', id: d.c.nextId, paced })
}

function startChecking(d: Draft, nowMs: number): void {
  const { c } = d
  const parts: string[] = []
  if (!c.privacyAnnounced) {
    parts.push(FIND_PHRASES.privacy)
    c.privacyAnnounced = true
  }
  parts.push(lookingFor(c.target))
  if (c.noHeading) parts.push(FIND_PHRASES.noHeading)
  say(d, nowMs, ...parts)
  c.state = 'checking'
  c.enteredAt = nowMs
  issueLocate(d, true)
}

function beginSweep(d: Draft, heading: number | null, nowMs: number): void {
  const { c } = d
  c.state = 'sweeping'
  c.enteredAt = nowMs
  c.sweepFrames = 0
  c.sweepLastHeading = heading
  c.sweepTurned = 0
  c.sweepSeenHeading = heading
  c.sweepProgressAt = nowMs
  c.sweepReminded = false
  c.sweepCheckHeading = heading
  c.sweepDwellChecked = false
  c.sweepPending = []
  c.sweepAnswered = 0
  c.sweepFailures = 0
  c.sweepLastCode = null
}

function enterGuiding(d: Draft, memory: TargetMemory, bearingDeg: number, nowMs: number): void {
  const { c } = d
  const direction = classifyDirection(bearingDeg, d.cfg)
  c.state = 'guiding'
  c.enteredAt = nowMs
  c.memory = memory
  c.failedRechecks = 0
  c.rechecking = false
  c.lastRecheckAt = nowMs
  c.lastSpokenDirection = direction
  c.lastDirectionAt = nowMs
  c.pending = null
  c.sweepPending = []
  say(d, nowMs, foundPhrase(c.target, direction))
}

function toNotFound(d: Draft, nowMs: number): void {
  const { c } = d
  say(d, nowMs, notFoundPhrase(c.target, c.signHint))
  c.state = 'notFound'
  c.enteredAt = nowMs
  c.pending = null
  c.sweepPending = []
}

function toError(d: Draft, code: LocateClientErrorCode, nowMs: number): void {
  const { c } = d
  // The two local rate-limit codes have a more helpful sentence; every real failure is just "not available".
  say(d, nowMs, code === 'too_soon' || code === 'limit' ? FIND_MESSAGES[code] : FIND_PHRASES.unavailable)
  c.state = 'error'
  c.enteredAt = nowMs
  c.pending = null
  c.sweepPending = []
}

function toLost(d: Draft, nowMs: number): void {
  const { c } = d
  say(d, nowMs, lostPhrase(c.target))
  c.state = 'lost'
  c.enteredAt = nowMs
  c.memory = null
  c.rechecking = false
  c.pending = null
  c.sweepPending = []
}

/** Where a found result puts the target: its memory, from the frame's own heading and pitch. Null if it cannot be placed. */
function memoryFrom(d: Draft, result: LocateResult, meta: FrameMeta | undefined, nowMs: number): TargetMemory | null {
  if (!result.found || result.box === null || meta === undefined || meta.heading === null) return null
  const { env } = d
  const distance = estimateTargetDistance({
    box: result.box,
    frame: env.frame,
    onFloor: result.onFloor,
    geminiDistanceM: result.distanceM,
    pitchDeg: meta.pitch,
    eyeHeightM: env.eyeHeightM,
    horizontalFovDeg: env.hfovDeg,
  }).distanceM
  return remember({
    label: d.c.target,
    frameHeading: meta.heading,
    box: result.box,
    hfovDeg: env.hfovDeg,
    distanceM: distance,
    nowMs,
    source: 'gemini',
  })
}

/** The detector sees the target: place it from the track and start guiding, with no network. */
function guideFromYolo(d: Draft, yolo: YoloSighting, heading: number, nowMs: number): void {
  const memory: TargetMemory = {
    label: d.c.target,
    heading: heading + yolo.angleDeg,
    distanceM: yolo.distanceM === null ? null : roundDistance(yolo.distanceM),
    seenAt: nowMs,
    source: 'yolo',
  }
  enterGuiding(d, memory, bearing(memory, heading), nowMs)
}

function onRequest(d: Draft, e: Extract<FindEvent, { type: 'request' }>): void {
  const target = cleanTarget(e.target)
  if (target.length === 0) return
  toIdle(d)
  const { c } = d
  c.target = target
  c.noHeading = e.heading === null
  c.enteredAt = e.nowMs
  c.lastFeedbackAt = e.nowMs

  if (e.yolo === null) {
    startChecking(d, e.nowMs)
    return
  }
  // The detector already sees it: no network. Without a heading, say where it is once and stop.
  if (e.heading === null) {
    say(d, e.nowMs, foundPhrase(target, classifyDirection(e.yolo.angleDeg, d.cfg)))
    toIdle(d)
    return
  }
  guideFromYolo(d, e.yolo, e.heading, e.nowMs)
}

function onLocated(d: Draft, e: Extract<FindEvent, { type: 'located' }>): void {
  const { c } = d
  const sweepFrame = c.sweepPending.includes(e.id)
  if (!sweepFrame && e.id !== c.pending) return // an answer to a search that was cancelled or replaced
  if (sweepFrame) c.sweepPending = c.sweepPending.filter((id) => id !== e.id)
  else c.pending = null
  const found = e.result.found && e.result.frameIndex !== null
  if (e.result.signHint) c.signHint = e.result.signHint

  if (c.state === 'checking') {
    if (found) {
      const meta = e.frames[e.result.frameIndex as number]
      if (c.noHeading && e.result.box !== null) {
        // No heading: the box position is all there is. Say where it is, once, and stop.
        const angle = observe(0, boxCenterX(e.result.box), d.env.hfovDeg)
        say(d, e.nowMs, foundPhrase(c.target, classifyDirection(angle, d.cfg)))
        toIdle(d)
        return
      }
      const memory = memoryFrom(d, e.result, meta, e.nowMs)
      if (memory !== null) {
        const now = e.heading ?? meta.heading ?? memory.heading
        enterGuiding(d, memory, bearing(memory, now), e.nowMs)
        return
      }
    }
    if (!c.noHeading) {
      say(d, e.nowMs, FIND_PHRASES.notInView)
      beginSweep(d, e.heading, e.nowMs)
    } else {
      toNotFound(d, e.nowMs)
    }
    return
  }

  if (c.state === 'sweeping' || c.state === 'sweepChecking') {
    // A per-frame look, or a look taken while the user paused. Finding the target ends the search; a miss is counted,
    // and once every look is back after the turn, the sweep is over.
    const memory = found ? memoryFrom(d, e.result, e.frames[e.result.frameIndex as number], e.nowMs) : null
    if (memory !== null) {
      enterGuiding(d, memory, bearing(memory, e.heading ?? memory.heading), e.nowMs)
      return
    }
    if (sweepFrame) c.sweepAnswered += 1
    if (c.state === 'sweepChecking' && c.sweepPending.length === 0) resolveSweep(d, e.nowMs)
    return
  }

  if (c.state === 'guiding') {
    c.rechecking = false
    c.lastRecheckAt = e.nowMs
    const memory = found ? memoryFrom(d, e.result, e.frames[e.result.frameIndex as number], e.nowMs) : null
    if (memory !== null) {
      c.memory = memory
      c.failedRechecks = 0
      return
    }
    failRecheck(d, e.nowMs)
  }
}

function failRecheck(d: Draft, nowMs: number): void {
  d.c.failedRechecks += 1
  if (d.c.failedRechecks >= d.cfg.lostAfterFailedRechecks) toLost(d, nowMs)
}

function onFailed(d: Draft, e: Extract<FindEvent, { type: 'failed' }>): void {
  const { c } = d
  const sweepFrame = c.sweepPending.includes(e.id)
  if (!sweepFrame && e.id !== c.pending) return
  if (sweepFrame) c.sweepPending = c.sweepPending.filter((id) => id !== e.id)
  else c.pending = null
  if (c.state === 'checking') {
    toError(d, e.code, e.nowMs)
    return
  }
  if (c.state === 'sweeping' || c.state === 'sweepChecking') {
    // One failed look costs one frame (the next overlaps it). Only if every look failed is Find unavailable.
    if (sweepFrame) {
      c.sweepFailures += 1
      c.sweepLastCode = e.code
    }
    if (c.state === 'sweepChecking' && c.sweepPending.length === 0) resolveSweep(d, e.nowMs)
    return
  }
  if (c.state === 'guiding') {
    c.rechecking = false
    // Our own pacing limits say nothing about the target; try again later. Any other failure counts against it.
    if (e.code === 'too_soon' || e.code === 'limit') return
    c.lastRecheckAt = e.nowMs
    failRecheck(d, e.nowMs)
  }
}

function tickSweep(d: Draft, e: Extract<FindEvent, { type: 'tick' }>): void {
  const { c, cfg } = d
  const now = e.nowMs
  if (e.heading !== null) {
    if (c.sweepLastHeading === null || c.sweepSeenHeading === null) {
      c.sweepLastHeading = e.heading
      c.sweepSeenHeading = e.heading
    }
    if (Math.abs(e.heading - c.sweepSeenHeading) >= cfg.sweepProgressDeg) {
      c.sweepSeenHeading = e.heading
      c.sweepProgressAt = now
      c.sweepDwellChecked = false
    }
    const delta = Math.abs(e.heading - c.sweepLastHeading)
    if (delta >= cfg.sweepStepDeg) {
      c.sweepFrames += 1
      c.sweepTurned += delta
      c.sweepLastHeading = e.heading
      c.nextId += 1
      c.sweepPending = [...c.sweepPending, c.nextId]
      d.effects.push({ type: 'capture', id: c.nextId })
      if (c.sweepFrames >= cfg.maxFrames || c.sweepTurned >= cfg.sweepFullTurnDeg) {
        finishSweep(d, now)
        return
      }
    }
  }
  const idleMs = now - c.sweepProgressAt
  if (idleMs >= cfg.sweepGiveUpMs) {
    if (c.sweepFrames > 0) finishSweep(d, now)
    else toNotFound(d, now)
    return
  }
  if (idleMs >= cfg.sweepReminderMs && !c.sweepReminded) {
    c.sweepReminded = true
    say(d, now, FIND_PHRASES.keepTurning)
  }
  if (
    e.heading !== null &&
    c.sweepCheckHeading !== null &&
    !c.sweepDwellChecked &&
    c.pending === null &&
    e.canLook &&
    idleMs >= cfg.sweepDwellMs &&
    Math.abs(e.heading - c.sweepCheckHeading) >= cfg.sweepDwellMinTurnDeg
  ) {
    c.sweepDwellChecked = true
    c.sweepCheckHeading = e.heading
    say(d, now, FIND_PHRASES.checking)
    issueLocate(d, false)
  }
}

/** The turn is over (or the user stopped): wait for the looks still out, or finish at once if there are none. */
function finishSweep(d: Draft, nowMs: number): void {
  d.c.state = 'sweepChecking'
  d.c.enteredAt = nowMs
  if (d.c.sweepPending.length === 0) {
    resolveSweep(d, nowMs)
    return
  }
  say(d, nowMs, FIND_PHRASES.checking)
}

/** Every look is back and none found the target: not found, unless every look failed, which is an error. */
function resolveSweep(d: Draft, nowMs: number): void {
  const { c } = d
  if (c.sweepAnswered === 0 && c.sweepFailures > 0 && c.sweepLastCode !== null) toError(d, c.sweepLastCode, nowMs)
  else toNotFound(d, nowMs)
}

function tickGuiding(d: Draft, e: Extract<FindEvent, { type: 'tick' }>): void {
  const { c, cfg, env } = d
  const now = e.nowMs
  if (c.memory === null || e.heading === null) return

  // The detector follows a target it can see, frame by frame, so bearing and distance stay smooth.
  if (c.memory.source === 'yolo' && e.yolo !== null) {
    c.memory = {
      ...c.memory,
      heading: e.heading + e.yolo.angleDeg,
      distanceM: e.yolo.distanceM === null ? c.memory.distanceM : roundDistance(e.yolo.distanceM),
      seenAt: now,
    }
    c.failedRechecks = 0
  }
  if (isStale(c.memory, now, cfg.memoryMaxAgeMs)) {
    toLost(d, now)
    return
  }

  const bearingDeg = bearing(c.memory, e.heading)
  if (c.memory.distanceM !== null && c.memory.distanceM <= cfg.arrivalDistanceM && Math.abs(bearingDeg) < cfg.arrivalAngleDeg) {
    c.state = 'arrived'
    c.enteredAt = now
    say(d, now, arrivedPhrase(c.target))
    return
  }

  const direction = classifyDirection(bearingDeg, cfg)
  if (direction !== c.lastSpokenDirection && now - c.lastDirectionAt >= cfg.guideSpeechCooldownMs) {
    c.lastSpokenDirection = direction
    c.lastDirectionAt = now
    say(d, now, directionPhrase(direction))
  }

  const followedByDetector = c.memory.source === 'yolo' && e.yolo !== null
  if (
    inView(bearingDeg, env.hfovDeg) &&
    !followedByDetector &&
    !c.rechecking &&
    e.canLocate &&
    now - c.lastRecheckAt >= cfg.recheckIntervalMs
  ) {
    c.rechecking = true
    c.lastRecheckAt = now
    issueLocate(d, true)
  }
}

function onTick(d: Draft, e: Extract<FindEvent, { type: 'tick' }>): void {
  const { c, cfg } = d
  const now = e.nowMs
  // The detector may see the target while a search is still looking (a chair that comes into view as you turn).
  const searching = c.state === 'checking' || c.state === 'sweeping' || c.state === 'sweepChecking' || c.state === 'lost'
  if (searching && e.yolo !== null && e.heading !== null) {
    guideFromYolo(d, e.yolo, e.heading, now)
    return
  }
  switch (c.state) {
    case 'checking':
    case 'sweepChecking':
      if (now - c.lastFeedbackAt >= cfg.feedbackMaxGapMs) say(d, now, FIND_PHRASES.stillSearching)
      return
    case 'sweeping':
      tickSweep(d, e)
      return
    case 'lost':
      beginSweep(d, e.heading, now)
      return
    case 'guiding':
      tickGuiding(d, e)
      return
    case 'arrived':
    case 'notFound':
    case 'error':
      if (now - c.enteredAt >= cfg.resultHoldMs) toIdle(d)
      return
    case 'idle':
      return
  }
}

/** One step of the Find controller. */
export function reduce(ctx: FindContext, event: FindEvent, env: FindEnv, cfg: FindConfig = CONFIG.find): FindStep {
  const d: Draft = { c: { ...ctx }, effects: [], env, cfg }
  switch (event.type) {
    case 'request':
      onRequest(d, event)
      break
    case 'cancel':
      if (ctx.state !== 'idle') {
        toIdle(d)
        d.effects.push({ type: 'speak', text: FIND_PHRASES.stopped })
      }
      break
    case 'tick':
      onTick(d, event)
      break
    case 'located':
      onLocated(d, event)
      break
    case 'failed':
      onFailed(d, event)
      break
  }
  return { ctx: d.c, effects: d.effects }
}

/** What the screen and the status line show for a context and the live heading. */
export function snapshotOf(ctx: FindContext, heading: number | null): FindSnapshot {
  const guiding = ctx.state === 'guiding' && ctx.memory !== null
  return {
    state: ctx.state,
    target: ctx.state === 'idle' ? null : ctx.target,
    bearingDeg: guiding && heading !== null ? bearing(ctx.memory as TargetMemory, heading) : null,
    distanceM: ctx.memory?.distanceM ?? null,
    source: ctx.memory?.source ?? null,
  }
}
