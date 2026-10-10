import { expect, test } from 'vitest'
import { computeLetterbox } from './postprocess'
import { rgbaToTensor } from './preprocess'

test('writes planar RGB in 0..1 and averages brightness over the picture area only', () => {
  const lb = computeLetterbox(4, 2, 4) // picture 4 x 2, one padding row above and below
  const rgba = new Uint8ClampedArray(4 * 4 * 4)
  for (let p = 0; p < 16; p++) {
    const inPicture = p >= 4 && p < 12
    const [r, g, b] = inPicture ? [255, 255, 255] : [0, 0, 0]
    rgba.set([r, g, b, 255], p * 4)
  }
  const out = new Float32Array(3 * 16)

  const meanLuma = rgbaToTensor(rgba, lb, out)

  expect(meanLuma).toBeCloseTo(1, 6)
  expect(out[0]).toBe(0) // red plane, padding pixel
  expect(out[4]).toBe(1) // red plane, picture pixel
  expect(out[16 + 4]).toBe(1) // green plane
  expect(out[32 + 4]).toBe(1) // blue plane
})

test('a dark picture has a low mean brightness', () => {
  const lb = computeLetterbox(2, 2, 2)
  const rgba = new Uint8ClampedArray(2 * 2 * 4)
  for (let p = 0; p < 4; p++) rgba.set([20, 20, 20, 255], p * 4)
  expect(rgbaToTensor(rgba, lb, new Float32Array(12))).toBeCloseTo(20 / 255, 6)
})
