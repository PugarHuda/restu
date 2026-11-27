// node --experimental-strip-types --no-warnings --test src/nod.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNodDetector, type Sample } from './nod.ts'

const calm = (t0: number, n: number): Sample[] =>
  Array.from({ length: n }, (_, i) => ({ x: 0.01 * Math.sin(i), y: 1 + 0.01 * Math.cos(i), z: 0.02 * Math.sin(i * 2), t: t0 + i * 100 }))

test('a pitch nod (y swings out and back) is detected once', () => {
  const d = createNodDetector()
  for (const s of calm(0, 20)) assert.equal(d.push(s), false)
  const nod = [1, 0.85, 0.7, 0.62, 0.72, 0.9, 1, 1].map((y, i) => ({ x: 0.01, y, z: 0.02, t: 2000 + i * 100 }))
  const hits = nod.map(s => d.push(s)).filter(Boolean).length
  assert.equal(hits, 1)
})

test('calm wearing never fires', () => {
  const d = createNodDetector()
  assert.equal(calm(0, 100).some(s => d.push(s)), false)
})

test('a jolt on every axis is not a nod', () => {
  const d = createNodDetector()
  for (const s of calm(0, 20)) d.push(s)
  const jolt = [0, 0.4, 0.5, 0.3, 0].map((v, i) => ({ x: v, y: 1 - v, z: v, t: 2000 + i * 100 }))
  assert.equal(jolt.some(s => d.push(s)), false)
})

test('looking down and staying there is not a nod', () => {
  const d = createNodDetector()
  for (const s of calm(0, 20)) d.push(s)
  const down = [1, 0.8, 0.6, 0.55, 0.55, 0.55, 0.55].map((y, i) => ({ x: 0.01, y, z: 0.02, t: 2000 + i * 100 }))
  assert.equal(down.some(s => d.push(s)), false)
})
