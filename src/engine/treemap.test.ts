import { test } from 'node:test'
import assert from 'node:assert/strict'
import { squarify } from '../../dist/engine/treemap.js'

const box = { x: 0, y: 0, w: 160, h: 100 }

test('every value gets a box whose area is its share of the whole', () => {
  const values = [500, 300, 120, 80, 40, 30, 20, 10]
  const total = values.reduce((a, b) => a + b, 0)
  const rects = squarify(values, box)
  assert.equal(rects.length, values.length)
  rects.forEach((r, i) => assert.ok(Math.abs(r.w * r.h - (values[i] / total) * 160 * 100) < 1e-6))
})

test('boxes stay inside the map and never overlap', () => {
  const rects = squarify([90, 70, 50, 33, 20, 20, 9, 5, 2, 1], box)
  for (const r of rects) {
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 160 + 1e-9 && r.y + r.h <= 100 + 1e-9)
  }
  for (const [i, a] of rects.entries()) for (const b of rects.slice(i + 1)) {
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    assert.ok(ox <= 1e-9 || oy <= 1e-9, 'overlap')
  }
})

test('boxes are close to square, not slivers', () => {
  const rects = squarify(Array.from({ length: 40 }, (_, i) => 40 - i), box)
  const worst = Math.max(...rects.map((r) => Math.max(r.w / r.h, r.h / r.w)))
  assert.ok(worst < 4, `worst aspect ${worst}`)
})

test('nothing to place gives nothing', () => {
  assert.deepEqual(squarify([], box), [])
  assert.deepEqual(squarify([0, 0], box), [])
})
