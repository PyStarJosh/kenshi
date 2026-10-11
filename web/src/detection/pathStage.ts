// The free-space path stage of the detection worker (R7): every few frames, shrink the frame, make it gray, and run
// computeFreeSpacePath. The picture itself is read through a function the worker supplies (an OffscreenCanvas), so this
// file has no browser calls and the counting, the buffers, and the numbers passed on are tested.
import { CONFIG } from '../core/config'
import type { FreeSpaceResult } from '../core/types'
import { computeFreeSpacePath, rgbaToGray } from '../geometry/freeSpacePath'
import { detourDecision, pathOptionsFor, processSize } from '../geometry/pathInput'
import type { PathInput } from '../geometry/pathInput'

export interface PathStageDeps {
  /** Draw the frame at width x height and return its RGBA bytes. */
  readRgba: (width: number, height: number) => Uint8ClampedArray
  now: () => number
  /** Compute on one frame in this many. */
  everyNthFrame?: number
  processWidth?: number
}

export class PathStage {
  private readonly deps: PathStageDeps
  private gray = new Uint8Array(0)
  private seen = 0

  constructor(deps: PathStageDeps) {
    this.deps = deps
  }

  /**
   * Called once per frame the worker handles. Returns the path on the frames where it is due and was asked for, else null.
   * The first frame asked about is due, then every Nth after it.
   */
  run(frameWidth: number, frameHeight: number, input: PathInput | undefined): { result: FreeSpaceResult; ms: number } | null {
    if (input === undefined) return null
    const every = Math.max(1, this.deps.everyNthFrame ?? CONFIG.freeSpace.everyNthFrame)
    const due = input.force === true || this.seen % every === 0
    this.seen += 1
    if (!due) return null

    const t0 = this.deps.now()
    const { width, height } = processSize(frameWidth, frameHeight, this.deps.processWidth ?? CONFIG.freeSpace.processWidth)
    const rgba = this.deps.readRgba(width, height)
    if (this.gray.length < width * height) this.gray = new Uint8Array(width * height)
    rgbaToGray(rgba, width, height, this.gray)
    const options = pathOptionsFor(input, width, height)
    const path = computeFreeSpacePath({ data: this.gray, width, height }, CONFIG.freeSpace.path, options)
    // Steering to a target, the decision is whether the line leaves the target's column (goes around something), not
    // whether it is left or right of the middle of the picture.
    const decision =
      options.targetX === undefined
        ? path.decision
        : detourDecision(path.lookahead, options.targetX, CONFIG.freeSpace.path.turnDeadbandFrac)
    return {
      result: {
        points: path.points,
        lookahead: path.lookahead,
        decision,
        processWidth: width,
        processHeight: height,
        roiStartRow: path.roiStartRow,
        freeMask: path.freeMask,
      },
      ms: this.deps.now() - t0,
    }
  }
}
