import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FREE_SPACE_CONFIG,
  computeFreeSpacePath,
  horizonRow,
  majorityDecision,
  rgbaToGray,
  type GrayFrame,
} from './freeSpacePath';

const W = 320;
const H = 240;

/** Plain floor with a wall above 45% of the height. */
function hallway(floor = 128, wall = 170): GrayFrame {
  const data = new Uint8Array(W * H).fill(floor);
  data.fill(wall, 0, Math.floor(H * 0.45) * W);
  return { data, width: W, height: H };
}

function fillRect(f: GrayFrame, x1: number, y1: number, x2: number, y2: number, value: number): void {
  for (let y = y1; y <= y2; y++) f.data.fill(value, y * f.width + x1, y * f.width + x2 + 1);
}

/** Frame pixel position of a normalised path point. */
function px(p: { x: number; y: number }): { x: number; y: number } {
  return { x: p.x * W - 0.5, y: p.y * H - 0.5 };
}

describe('computeFreeSpacePath', () => {
  it('goes around an obstacle, never through it', () => {
    const f = hallway();
    fillRect(f, 125, 150, 195, 210, 40);
    const res = computeFreeSpacePath(f);
    expect(res.points.length).toBeGreaterThan(5);
    for (const p of res.points.map(px)) {
      expect(p.x >= 125 && p.x <= 195 && p.y >= 150 && p.y <= 210).toBe(false);
    }
  });

  it("says 'straight' for an open corridor, with no pull toward the left at either end", () => {
    const res = computeFreeSpacePath(hallway());
    expect(res.decision).toBe('straight');
    expect(res.points.length).toBeGreaterThan(5);
    for (const p of res.points) expect(Math.abs(p.x - 0.5)).toBeLessThan(0.01);
  });

  it('takes the side of an obstacle that leads toward the target', () => {
    const f = hallway();
    fillRect(f, 125, 150, 195, 210, 40);
    for (const [targetX, expected] of [
      [0.1, 'left'],
      [0.9, 'right'],
    ] as const) {
      const res = computeFreeSpacePath(f, DEFAULT_FREE_SPACE_CONFIG, { targetX });
      expect(res.decision).toBe(expected);
      for (const p of res.points.map(px)) {
        expect(p.x >= 125 && p.x <= 195 && p.y >= 150 && p.y <= 210).toBe(false);
      }
    }
  });

  it('stops where its channel ends instead of jumping to an unconnected gap', () => {
    const f = hallway();
    fillRect(f, 150, 110, 230, 200, 40); // central obstacle: wide left channel, narrower right channel
    fillRect(f, 0, 110, 135, 150, 40); // the left channel narrows below the minimum gap near the top
    const res = computeFreeSpacePath(f);
    expect(res.points.length).toBeGreaterThan(3);
    for (const p of res.points.map(px)) {
      expect(p.x >= 150 && p.x <= 230 && p.y >= 110 && p.y <= 200).toBe(false); // never inside the obstacle
      if (p.y < 200) expect(p.x).toBeLessThan(150); // above the obstacle's bottom edge, stays in the left channel
    }
  });

  it('starts the analysed region at the horizon when one is given', () => {
    const res = computeFreeSpacePath(hallway(), DEFAULT_FREE_SPACE_CONFIG, { horizonRow: 60 });
    expect(res.roiStartRow).toBe(Math.round(60 + DEFAULT_FREE_SPACE_CONFIG.horizonMarginFrac * H));
    expect(res.freeMask.length).toBe(W * (H - res.roiStartRow));
    for (const p of res.points.map(px)) expect(p.y).toBeGreaterThanOrEqual(res.roiStartRow);
  });

  it("returns 'none' when there is no open floor", () => {
    const f = hallway();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) f.data[y * W + x] = ((x >> 2) + (y >> 2)) % 2 === 1 ? 230 : 20;
    }
    const res = computeFreeSpacePath(f);
    expect(res.decision).toBe('none');
    expect(res.points).toEqual([]);
    expect(res.lookahead).toBeNull();
  });

  it("returns 'none' when the horizon is below the frame", () => {
    const res = computeFreeSpacePath(hallway(), DEFAULT_FREE_SPACE_CONFIG, { horizonRow: H + 50 });
    expect(res.decision).toBe('none');
    expect(res.roiStartRow).toBe(H);
    expect(res.freeMask.length).toBe(0);
  });

  it('rejects a frame whose buffer is smaller than width × height', () => {
    expect(() => computeFreeSpacePath({ data: new Uint8Array(10), width: W, height: H })).toThrow(RangeError);
  });
});

describe('horizonRow', () => {
  const vfov = (50 * Math.PI) / 180;

  it('is the middle row when the camera is level', () => {
    expect(horizonRow(0, vfov, 480)).toBeCloseTo(240);
  });

  it('is the top row when the camera tilts down by half the vertical field of view', () => {
    expect(horizonRow(vfov / 2, vfov, 480)).toBeCloseTo(0);
  });

  it('moves below the middle when the camera tilts up', () => {
    expect(horizonRow(-0.1, vfov, 480)).toBeGreaterThan(240);
  });
});

describe('rgbaToGray', () => {
  it("uses OpenCV's weights", () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    expect(Array.from(rgbaToGray(rgba, 4, 1))).toEqual([255, 76, 150, 29]);
  });

  it('rejects buffers that are too small', () => {
    expect(() => rgbaToGray(new Uint8ClampedArray(4), 2, 1)).toThrow(RangeError);
  });
});

describe('majorityDecision', () => {
  it('returns the most common decision', () => {
    expect(majorityDecision(['left', 'straight', 'straight', 'right', 'straight'])).toBe('straight');
  });

  it("returns 'none' for an empty history", () => {
    expect(majorityDecision([])).toBe('none');
  });
});