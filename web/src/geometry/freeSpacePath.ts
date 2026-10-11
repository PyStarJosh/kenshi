/**
 * Free-space path: a walking line through open floor in one camera frame.
 *
 * Ported from path_estimation_opencv.py in our teammate's MedTech-Hack repo
 * (github.com/TarunM78/medtech-hack). Same pipeline: blur, Canny edges, thicken the
 * edges into obstacles, treat everything else as open floor, keep the open floor that
 * touches the bottom of the frame, then walk up it row by row.
 *
 * Changes from the original:
 * - Smoothing averages only real neighbours. The original zero-padded, which dragged
 *   both ends of the line toward the left edge, so "left" was the usual answer.
 * - The turn decision uses a point part-way up the path, not the bottom-most point.
 * - The line follows one connected channel and stops where it ends, instead of
 *   jumping across an obstacle to another gap.
 * - With a target (Find mode), forks go toward the target and the line leans toward it.
 * - The analysed region can start at the horizon (from device pitch) instead of a fixed 40%.
 *
 * Pure functions only: no DOM or canvas. The caller passes a grayscale frame.
 * This is an image-space guide, not a map. It has no depth and never means "clear".
 */

import { CONFIG } from '../core/config';

export interface FreeSpaceConfig {
  /** Start of the analysed region as a fraction of frame height, used when no horizon is given. */
  roiStartFrac: number;
  /** Rows below the horizon to skip, as a fraction of frame height. */
  horizonMarginFrac: number;
  /** Canny hysteresis thresholds on the L1 Sobel gradient magnitude. */
  cannyLow: number;
  cannyHigh: number;
  /** Frame width the pixel sizes below were tuned at. They scale with the actual width. */
  referenceWidth: number;
  /** Kernel diameters in pixels at referenceWidth: thicken edges, close gaps, clean open floor. */
  dilateKernel: number;
  closeKernel: number;
  openKernel: number;
  /** Pixels between scanlines at referenceWidth. */
  rowStep: number;
  /** Bottom rows (pixels at referenceWidth) that count as touching the user. */
  bottomBandRows: number;
  /** Ignore gaps narrower than this fraction of frame width. */
  minGapFrac: number;
  /** Moving-average window, in path points, for smoothing the line. */
  smoothWindow: number;
  /** Position along the path (0 = bottom, 1 = top) of the point used for the turn decision. */
  lookaheadFrac: number;
  /** Within plus or minus this fraction of frame width from centre counts as straight. */
  turnDeadbandFrac: number;
  /** With a target, keep at least this fraction of a gap's width (0 to 0.5) between the line and the gap's edges. */
  targetClearanceFrac: number;
}

/** Values from the original script (tuned at 640 px wide); they live in config.ts as CONFIG.freeSpace.path. */
export const DEFAULT_FREE_SPACE_CONFIG: Readonly<FreeSpaceConfig> = CONFIG.freeSpace.path;

export interface GrayFrame {
  /** One byte per pixel, row-major, at least width × height long. */
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export interface PathOptions {
  /** Horizon row in this frame's pixels. May be negative or past the bottom. See horizonRow(). */
  horizonRow?: number;
  /** Target column from 0 (left edge) to 1 (right edge). Steers forks and leans the line toward it. */
  targetX?: number;
}

export type TurnDecision = 'left' | 'right' | 'straight' | 'none';

/** Normalised full-frame coordinates: x and y from 0 to 1, y pointing down. */
export interface PathPoint {
  x: number;
  y: number;
}

export interface FreeSpacePath {
  /** Bottom to top, smoothed. Empty when no path was found. */
  points: PathPoint[];
  /** The point used for the turn decision, or null when there is no path. */
  lookahead: PathPoint | null;
  decision: TurnDecision;
  /** First analysed row, in frame pixels. */
  roiStartRow: number;
  /** Open floor connected to the user (1) or not (0). Size: width × (height − roiStartRow). */
  freeMask: Uint8Array;
}

/** Fewest rows the 3×3 and 5×5 filters can work with. */
const MIN_ROI_ROWS = 3;

/**
 * Find a walking line through open floor.
 * Throws RangeError for a malformed frame. Returns decision 'none' when there is no open path.
 */
export function computeFreeSpacePath(
  frame: GrayFrame,
  config: Readonly<FreeSpaceConfig> = DEFAULT_FREE_SPACE_CONFIG,
  options: PathOptions = {},
): FreeSpacePath {
  const { data, width: w, height: frameHeight } = frame;
  if (!Number.isInteger(w) || !Number.isInteger(frameHeight) || w < 3 || frameHeight < 3 || data.length < w * frameHeight) {
    throw new RangeError(`computeFreeSpacePath: bad frame ${w}x${frameHeight} with ${data.length} bytes`);
  }

  const y0 = roiStartRow(frameHeight, config, options.horizonRow);
  const h = frameHeight - y0;
  if (h < MIN_ROI_ROWS) {
    return { points: [], lookahead: null, decision: 'none', roiStartRow: y0, freeMask: new Uint8Array(w * h) };
  }

  // 1) Obstacles from edges.
  const roi = data.subarray(y0 * w, frameHeight * w);
  const edges = canny(gaussian5(roi, w, h), w, h, config.cannyLow, config.cannyHigh);
  const thick = dilate(edges, w, h, oddKernel(config.dilateKernel, w, config));
  const closeK = oddKernel(config.closeKernel, w, config);
  const obstacles = erode(dilate(thick, w, h, closeK), w, h, closeK);

  // 2) Open floor is everything else, cleaned up.
  const openK = oddKernel(config.openKernel, w, config);
  const open = dilate(erode(invert(obstacles), w, h, openK), w, h, openK);

  // 3) Keep only the open floor connected to the user.
  const freeMask = bottomComponent(open, w, h, scaledPx(config.bottomBandRows, w, config));

  // 4) Walk up the open floor.
  const target =
    options.targetX !== undefined && Number.isFinite(options.targetX)
      ? clamp(options.targetX, 0, 1) * w - 0.5
      : null;
  const raw = tracePath(
    freeMask,
    w,
    h,
    Math.max(1, Math.floor(w * config.minGapFrac)),
    scaledPx(config.rowStep, w, config),
    target,
    clamp(config.targetClearanceFrac, 0, 0.5),
  );
  const xs = smooth(raw.map((p) => p.x), config.smoothWindow);
  const points = raw.map((p, i) => ({ x: (xs[i]! + 0.5) / w, y: (y0 + p.y + 0.5) / frameHeight }));

  return { points, ...turnFrom(points, config), roiStartRow: y0, freeMask };
}

/**
 * Row where the horizon falls in the frame, assuming the phone is not rolled.
 * pitchDownRad > 0 means the camera points below horizontal, which moves the horizon up.
 * The result can be negative (horizon above the frame) or past the bottom.
 */
export function horizonRow(pitchDownRad: number, verticalFovRad: number, height: number): number {
  const focal = height / 2 / Math.tan(verticalFovRad / 2);
  return height / 2 - focal * Math.tan(pitchDownRad);
}

/** Canvas RGBA to grayscale with OpenCV's weights (0.299 R + 0.587 G + 0.114 B). */
export function rgbaToGray(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  out: Uint8Array = new Uint8Array(width * height),
): Uint8Array {
  const n = width * height;
  if (rgba.length < n * 4 || out.length < n) {
    throw new RangeError(`rgbaToGray: buffers too small for ${width}x${height}`);
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (rgba[j]! * 4899 + rgba[j + 1]! * 9617 + rgba[j + 2]! * 1868 + 8192) >> 14;
  }
  return out;
}

/** Most common decision in a short history. Ties go to whichever tied value reached the count last. */
export function majorityDecision(history: readonly TurnDecision[]): TurnDecision {
  const counts = new Map<TurnDecision, number>();
  let best: TurnDecision = 'none';
  let bestCount = 0;
  for (const d of history) {
    const c = (counts.get(d) ?? 0) + 1;
    counts.set(d, c);
    if (c >= bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------- helpers

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function roiStartRow(height: number, config: Readonly<FreeSpaceConfig>, horizon: number | undefined): number {
  if (horizon !== undefined && Number.isFinite(horizon)) {
    return clamp(Math.round(horizon + config.horizonMarginFrac * height), 0, height);
  }
  return clamp(Math.floor(height * config.roiStartFrac), 0, height);
}

/** A pixel size tuned at referenceWidth, scaled to this width, as an odd kernel diameter of at least 1. */
function oddKernel(size: number, width: number, config: Readonly<FreeSpaceConfig>): number {
  const scaled = (size * width) / config.referenceWidth;
  return Math.max(1, 2 * Math.round((scaled - 1) / 2) + 1);
}

function scaledPx(size: number, width: number, config: Readonly<FreeSpaceConfig>): number {
  return Math.max(1, Math.round((size * width) / config.referenceWidth));
}

function turnFrom(
  points: readonly PathPoint[],
  config: Readonly<FreeSpaceConfig>,
): { lookahead: PathPoint | null; decision: TurnDecision } {
  if (points.length < 2) return { lookahead: null, decision: 'none' };
  const lookahead = points[Math.round(clamp(config.lookaheadFrac, 0, 1) * (points.length - 1))]!;
  const dx = lookahead.x - 0.5;
  const decision = dx < -config.turnDeadbandFrac ? 'left' : dx > config.turnDeadbandFrac ? 'right' : 'straight';
  return { lookahead, decision };
}

/** Moving average over real neighbours only, so the ends are not pulled toward zero. */
function smooth(xs: readonly number[], window: number): number[] {
  const half = Math.floor((window - 1) / 2);
  if (xs.length < 3 || half < 1) return xs.slice();
  return xs.map((_, i) => {
    const a = Math.max(0, i - half);
    const b = Math.min(xs.length - 1, i + half);
    let sum = 0;
    for (let j = a; j <= b; j++) sum += xs[j]!;
    return sum / (b - a + 1);
  });
}

// ------------------------------------------------------------ path tracing

interface Gap {
  x1: number;
  x2: number;
}

function gapsInRow(mask: Uint8Array, w: number, y: number, minWidth: number): Gap[] {
  const gaps: Gap[] = [];
  const row = y * w;
  let x = 0;
  while (x < w) {
    while (x < w && mask[row + x] === 0) x++;
    const x1 = x;
    while (x < w && mask[row + x] !== 0) x++;
    if (x > x1 && x - x1 >= minWidth) gaps.push({ x1, x2: x - 1 });
  }
  return gaps;
}

function distanceToGap(x: number, g: Gap): number {
  return x < g.x1 ? g.x1 - x : x > g.x2 ? x - g.x2 : 0;
}

/** Nearest the target (if any), then the gap that continues the line, then the widest. */
function pickGap(gaps: readonly Gap[], prevX: number, target: number | null): Gap | undefined {
  let best: Gap | undefined;
  let bestKey: readonly number[] = [];
  for (const g of gaps) {
    const key = [
      target === null ? 0 : distanceToGap(target, g),
      distanceToGap(prevX, g) === 0 ? 0 : 1,
      -(g.x2 - g.x1),
    ];
    if (best === undefined || isLess(key, bestKey)) {
      best = g;
      bestKey = key;
    }
  }
  return best;
}

function isLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

/** Scan from the bottom up, following one open channel. Returns region pixel coordinates. */
function tracePath(
  mask: Uint8Array,
  w: number,
  h: number,
  minWidth: number,
  step: number,
  target: number | null,
  clearanceFrac: number,
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  let prevGap: Gap | null = null;
  let prevX = (w - 1) / 2;
  for (let y = h - 1; y > 0; y -= step) {
    let gaps = gapsInRow(mask, w, y, minWidth);
    if (prevGap !== null) {
      const pg: Gap = prevGap;
      gaps = gaps.filter((g) => g.x1 <= pg.x2 && g.x2 >= pg.x1);
    }
    const gap = pickGap(gaps, prevX, target);
    if (gap === undefined) {
      if (prevGap !== null) break; // the open channel ends here; do not jump to another gap
      continue; // nothing wide enough yet near the bottom; keep looking upward
    }
    let x = (gap.x1 + gap.x2) / 2;
    if (target !== null) {
      const margin = clearanceFrac * (gap.x2 - gap.x1);
      x = clamp(target, gap.x1 + margin, gap.x2 - margin);
    }
    out.push({ x, y });
    prevGap = gap;
    prevX = x;
  }
  return out;
}

// ------------------------------------------------------- image operations
// Binary masks hold 0 or 1. Border rules follow OpenCV so results match the original.

/** Index table mapping k − pad to a reflect-101 index (OpenCV's default blur border). */
function reflectTable(n: number, pad: number): Int32Array {
  const t = new Int32Array(n + 2 * pad);
  for (let k = 0; k < t.length; k++) {
    let i = k - pad;
    if (n === 1) i = 0;
    while (i < 0 || i >= n) i = i < 0 ? -i : 2 * n - 2 - i;
    t[k] = i;
  }
  return t;
}

/** OpenCV GaussianBlur with a 5×5 kernel and automatic sigma: [1 4 6 4 1] / 16 in each direction. */
function gaussian5(src: Uint8Array | Uint8ClampedArray, w: number, h: number): Uint8Array {
  const tmp = new Uint16Array(w * h);
  const out = new Uint8Array(w * h);
  const xi = reflectTable(w, 2);
  const yi = reflectTable(h, 2);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      tmp[r + x] =
        src[r + xi[x]!]! + 4 * src[r + xi[x + 1]!]! + 6 * src[r + x]! + 4 * src[r + xi[x + 3]!]! + src[r + xi[x + 4]!]!;
    }
  }
  for (let y = 0; y < h; y++) {
    const r0 = yi[y]! * w;
    const r1 = yi[y + 1]! * w;
    const r2 = y * w;
    const r3 = yi[y + 3]! * w;
    const r4 = yi[y + 4]! * w;
    for (let x = 0; x < w; x++) {
      const s = tmp[r0 + x]! + 4 * tmp[r1 + x]! + 6 * tmp[r2 + x]! + 4 * tmp[r3 + x]! + tmp[r4 + x]!;
      out[r2 + x] = (s + 128) >> 8;
    }
  }
  return out;
}

/** OpenCV Canny: 3×3 Sobel (replicated border), L1 magnitude, non-maximum suppression, hysteresis. */
function canny(src: Uint8Array, w: number, h: number, low: number, high: number): Uint8Array {
  const n = w * h;
  const pw = w + 2; // magnitude has a zero border so neighbour lookups never go out of range
  const mag = new Int32Array(pw * (h + 2));
  const gx = new Int16Array(n);
  const gy = new Int16Array(n);

  for (let y = 0; y < h; y++) {
    const up = Math.max(y - 1, 0) * w;
    const mid = y * w;
    const dn = Math.min(y + 1, h - 1) * w;
    for (let x = 0; x < w; x++) {
      const xl = Math.max(x - 1, 0);
      const xr = Math.min(x + 1, w - 1);
      const a = src[up + xl]!;
      const b = src[up + x]!;
      const c = src[up + xr]!;
      const d = src[mid + xl]!;
      const f = src[mid + xr]!;
      const g = src[dn + xl]!;
      const k = src[dn + x]!;
      const m = src[dn + xr]!;
      const dx = c + 2 * f + m - (a + 2 * d + g);
      const dy = g + 2 * k + m - (a + 2 * b + c);
      gx[mid + x] = dx;
      gy[mid + x] = dy;
      mag[(y + 1) * pw + x + 1] = Math.abs(dx) + Math.abs(dy);
    }
  }

  const TAN22 = 0.41421356237309503; // tan(22.5°); tan(67.5°) = TAN22 + 2
  const state = new Uint8Array(n); // 0 = not an edge, 1 = weak, 2 = edge
  const stack = new Int32Array(n);
  let top = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mi = (y + 1) * pw + x + 1;
      const m = mag[mi]!;
      if (m <= low) continue;
      const i = y * w + x;
      const dx = gx[i]!;
      const dy = gy[i]!;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      let isMax: boolean;
      if (ay < ax * TAN22) {
        isMax = m > mag[mi - 1]! && m >= mag[mi + 1]!;
      } else if (ay > ax * (TAN22 + 2)) {
        isMax = m > mag[mi - pw]! && m >= mag[mi + pw]!;
      } else {
        const s = (dx ^ dy) < 0 ? -1 : 1;
        isMax = m > mag[mi - pw - s]! && m > mag[mi + pw + s]!;
      }
      if (!isMax) continue;
      if (m > high) {
        state[i] = 2;
        stack[top++] = i;
      } else {
        state[i] = 1;
      }
    }
  }

  while (top > 0) {
    const i = stack[--top]!;
    const x = i % w;
    const y = (i - x) / w;
    for (let ny = Math.max(y - 1, 0); ny <= Math.min(y + 1, h - 1); ny++) {
      for (let nx = Math.max(x - 1, 0); nx <= Math.min(x + 1, w - 1); nx++) {
        const j = ny * w + nx;
        if (state[j] === 1) {
          state[j] = 2;
          stack[top++] = j;
        }
      }
    }
  }

  const edges = new Uint8Array(n);
  for (let i = 0; i < n; i++) edges[i] = state[i] === 2 ? 1 : 0;
  return edges;
}

/** Half-width of each row of OpenCV's elliptical structuring element of diameter k. */
function ellipseRows(k: number): Int32Array {
  const r = (k - 1) >> 1;
  const rows = new Int32Array(k);
  for (let i = 0; i < k; i++) {
    const dy = i - r;
    rows[i] = r === 0 ? 0 : Math.round(r * Math.sqrt((r * r - dy * dy) / (r * r)));
  }
  return rows;
}

/** Per-row prefix sums: p[y * (w + 1) + x] = count of set pixels in row y before column x. */
function rowPrefix(src: Uint8Array, w: number, h: number): Int32Array {
  const p = new Int32Array((w + 1) * h);
  for (let y = 0; y < h; y++) {
    const base = y * (w + 1);
    let run = 0;
    for (let x = 0; x < w; x++) {
      run += src[y * w + x]!;
      p[base + x + 1] = run;
    }
  }
  return p;
}

/** Binary dilation with an elliptical kernel. Pixels outside the image count as unset (OpenCV default). */
function dilate(src: Uint8Array, w: number, h: number, k: number): Uint8Array {
  if (k <= 1) return src.slice();
  const half = ellipseRows(k);
  const r = (k - 1) >> 1;
  const pre = rowPrefix(src, w, h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let i = 0; i < k && on === 0; i++) {
        const yy = y + i - r;
        if (yy < 0 || yy >= h) continue;
        const hw = half[i]!;
        const base = yy * (w + 1);
        if (pre[base + Math.min(w - 1, x + hw) + 1]! - pre[base + Math.max(0, x - hw)]! > 0) on = 1;
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

/** Binary erosion with an elliptical kernel. Pixels outside the image count as set (OpenCV default). */
function erode(src: Uint8Array, w: number, h: number, k: number): Uint8Array {
  if (k <= 1) return src.slice();
  const half = ellipseRows(k);
  const r = (k - 1) >> 1;
  const pre = rowPrefix(src, w, h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 1;
      for (let i = 0; i < k && on === 1; i++) {
        const yy = y + i - r;
        if (yy < 0 || yy >= h) continue;
        const hw = half[i]!;
        const x0 = Math.max(0, x - hw);
        const x1 = Math.min(w - 1, x + hw);
        const base = yy * (w + 1);
        if (pre[base + x1 + 1]! - pre[base + x0]! < x1 - x0 + 1) on = 0;
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

function invert(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] === 0 ? 1 : 0;
  return out;
}

/** The largest 8-connected set region with a pixel in the bottom `band` rows; everything else cleared. */
function bottomComponent(src: Uint8Array, w: number, h: number, band: number): Uint8Array {
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let best = 0;
  let bestArea = 0;
  let next = 0;
  for (let y = Math.max(0, h - band); y < h; y++) {
    for (let x = 0; x < w; x++) {
      const seed = y * w + x;
      if (src[seed] === 0 || label[seed] !== 0) continue;
      next++;
      let head = 0;
      let tail = 0;
      queue[tail++] = seed;
      label[seed] = next;
      while (head < tail) {
        const p = queue[head++]!;
        const px = p % w;
        const py = (p - px) / w;
        for (let ny = Math.max(py - 1, 0); ny <= Math.min(py + 1, h - 1); ny++) {
          for (let nx = Math.max(px - 1, 0); nx <= Math.min(px + 1, w - 1); nx++) {
            const q = ny * w + nx;
            if (src[q] === 1 && label[q] === 0) {
              label[q] = next;
              queue[tail++] = q;
            }
          }
        }
      }
      if (tail > bestArea) {
        bestArea = tail;
        best = next;
      }
    }
  }
  const out = new Uint8Array(w * h);
  if (best !== 0) for (let i = 0; i < out.length; i++) out[i] = label[i] === best ? 1 : 0;
  return out;
}