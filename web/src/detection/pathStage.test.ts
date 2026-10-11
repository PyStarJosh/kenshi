import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import { computeFreeSpacePath, rgbaToGray } from '../geometry/freeSpacePath'
import { PathStage } from './pathStage'

/** A hallway as the canvas would give it: gray floor with a brighter wall above 45 percent of the height. */
function hallwayRgba(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4)
  const wallRows = Math.floor(height * 0.45)
  for (let y = 0; y < height; y++) {
    const gray = y < wallRows ? 170 : 128
    for (let x = 0; x < width; x++) rgba.fill(gray, (y * width + x) * 4, (y * width + x) * 4 + 3)
    for (let x = 0; x < width; x++) rgba[(y * width + x) * 4 + 3] = 255
  }
  return rgba
}

/** The hallway with a dark box standing on the floor from column x0 to x1, from row y0 to the bottom of the picture. */
function withBox(width: number, height: number, x0: number, x1: number, y0: number): Uint8ClampedArray {
  const rgba = hallwayRgba(width, height)
  for (let y = y0; y < height; y++) {
    for (let x = x0; x <= x1; x++) rgba.fill(40, (y * width + x) * 4, (y * width + x) * 4 + 3)
  }
  return rgba
}

function setup(everyNthFrame = 3, picture: (w: number, h: number) => Uint8ClampedArray = hallwayRgba) {
  const reads: [number, number][] = []
  let clock = 0
  const stage = new PathStage({
    readRgba: (w, h) => {
      reads.push([w, h])
      return picture(w, h)
    },
    now: () => (clock += 2),
    everyNthFrame,
  })
  return { stage, reads }
}

const input = { pitchDeg: null, hfovDeg: 65, targetX: null }

describe('which frames get a path', () => {
  test('one in every N, starting with the first', () => {
    const { stage } = setup(3)
    const ran = Array.from({ length: 7 }, () => stage.run(1280, 720, input) !== null)
    expect(ran).toEqual([true, false, false, true, false, false, true])
  })

  test('every 5th frame is the same with a bigger N', () => {
    const { stage } = setup(5)
    const ran = Array.from({ length: 11 }, () => stage.run(1280, 720, input) !== null)
    expect(ran.map((r, i) => (r ? i : -1)).filter((i) => i >= 0)).toEqual([0, 5, 10])
  })

  test('the config says one in three', () => {
    expect(CONFIG.freeSpace.everyNthFrame).toBe(3)
    expect(CONFIG.freeSpace.processWidth).toBe(320)
  })

  test('a frame with no request is not counted and costs nothing', () => {
    const { stage, reads } = setup(3)
    expect(stage.run(1280, 720, undefined)).toBeNull()
    expect(stage.run(1280, 720, undefined)).toBeNull()
    expect(reads).toHaveLength(0)
    expect(stage.run(1280, 720, input)).not.toBeNull() // still the first counted frame
  })

  test('force runs on every frame (the benchmark)', () => {
    const { stage } = setup(3)
    expect([1, 2, 3, 4].map(() => stage.run(1280, 720, { ...input, force: true }) !== null)).toEqual([true, true, true, true])
  })
})

describe('the picture it analyses', () => {
  test('is read at processWidth with the aspect ratio kept, one read per path', () => {
    const { stage, reads } = setup(1)
    stage.run(1280, 720, input)
    stage.run(1920, 1080, input)
    expect(reads).toEqual([
      [320, 180],
      [320, 180],
    ])
  })

  test('a portrait frame keeps its shape', () => {
    const { stage, reads } = setup(1)
    stage.run(720, 1280, input)
    expect(reads).toEqual([[320, 569]])
  })

  test('the result describes the analysed size and carries a mask of exactly the analysed rows', () => {
    const { stage } = setup(1)
    const out = stage.run(1280, 720, input)
    expect(out).not.toBeNull()
    const { result, ms } = out!
    expect(result.processWidth).toBe(320)
    expect(result.processHeight).toBe(180)
    expect(result.roiStartRow).toBe(Math.floor(180 * CONFIG.freeSpace.path.roiStartFrac)) // no tilt: the fixed start
    expect(result.freeMask).toHaveLength(320 * (180 - result.roiStartRow))
    expect(ms).toBeGreaterThan(0)
  })

  test('on open floor it finds a line that climbs the picture, with points inside it', () => {
    const { stage } = setup(1)
    const { result } = stage.run(1280, 720, input)!
    expect(result.points.length).toBeGreaterThan(3)
    for (const p of result.points) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(1)
      expect(p.y).toBeGreaterThan(0)
      expect(p.y).toBeLessThan(1)
    }
    expect(result.points[0].y).toBeGreaterThan(result.points.at(-1)!.y) // bottom to top
    expect(result.decision).toBe('straight')
  })

  test('the tilt sets where the analysed region starts: level puts the horizon mid-picture, looking down raises it', () => {
    const { stage } = setup(1)
    const level = stage.run(1280, 720, { ...input, pitchDeg: 0 })!.result
    expect(level.roiStartRow).toBe(Math.round(90 + CONFIG.freeSpace.path.horizonMarginFrac * 180))
    const down = stage.run(1280, 720, { ...input, pitchDeg: -25 })!.result
    expect(down.roiStartRow).toBeLessThan(level.roiStartRow)
    expect(down.freeMask).toHaveLength(320 * (180 - down.roiStartRow))
  })
})

describe('the decision, steering to a target', () => {
  const input = { pitchDeg: null, hfovDeg: 65 }

  test('on open floor the line keeps to the target\'s column, so a target a little to the right is not a detour', () => {
    const { stage } = setup(1)
    const { result } = stage.run(1280, 720, { ...input, targetX: 0.7 })!
    expect(result.decision).toBe('straight')
    // the line's own decision, measured from the middle of the picture, would have said right
    const gray = rgbaToGray(hallwayRgba(320, 180), 320, 180)
    const raw = computeFreeSpacePath({ data: gray, width: 320, height: 180 }, CONFIG.freeSpace.path, { targetX: 0.7 })
    expect(raw.decision).toBe('right')
  })

  test('with something standing in the way the line goes around it, and the decision says which side', () => {
    const { stage } = setup(1, (w, h) => withBox(w, h, 190, 260, 110))
    const { result } = stage.run(1280, 720, { ...input, targetX: 0.7 })!
    expect(result.decision).toBe('left')
  })

  test('with no target the line\'s own decision is kept', () => {
    const { stage } = setup(1)
    expect(stage.run(1280, 720, { ...input, targetX: null })!.result.decision).toBe('straight')
  })
})
