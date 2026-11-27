// Nod-to-approve. Pure detector over IMU samples (x, y, z, ms).
// The SDK does not document IMU units, so thresholds are relative: a nod is a clear
// swing on the dominant axis, out and back, within ~1.2 s, standing out from the
// recent calm noise, while the other axes stay comparatively still.
// ponytail: heuristic, untested on hardware; behind a toggle and always followed by the undo window.

export interface Sample { x: number; y: number; z: number; t: number }

const AXES = ['x', 'y', 'z'] as const

function median(a: number[]) { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)] ?? 0 }

export function createNodDetector(opts: { windowMs?: number; minSwing?: number; noiseFactor?: number; cooldownMs?: number } = {}) {
  const windowMs = opts.windowMs ?? 1200
  const minSwing = opts.minSwing ?? 0.15
  const noiseFactor = opts.noiseFactor ?? 6
  const cooldownMs = opts.cooldownMs ?? 2000
  let buf: Sample[] = []
  let calm: Sample[] = []      // samples older than the window, used as the noise baseline
  let lastNod = -Infinity

  return {
    // Returns true exactly once per detected nod.
    push(s: Sample): boolean {
      buf.push(s)
      while (buf.length && s.t - buf[0].t > windowMs) calm.push(buf.shift()!)
      if (calm.length > 40) calm = calm.slice(-40)
      if (s.t - lastNod < cooldownMs || buf.length < 4 || calm.length < 8) return false

      // noise level per axis from the calm baseline (median absolute deviation)
      const noise = Object.fromEntries(AXES.map(a => {
        const m = median(calm.map(c => c[a]))
        return [a, median(calm.map(c => Math.abs(c[a] - m)))]
      })) as Record<(typeof AXES)[number], number>

      const range = (a: (typeof AXES)[number]) => Math.max(...buf.map(b => b[a])) - Math.min(...buf.map(b => b[a]))
      const main = [...AXES].sort((a, b) => range(b) - range(a))[0]
      const swing = range(main)
      const threshold = Math.max(minSwing, noiseFactor * noise[main])
      if (swing < threshold) return false
      if (AXES.some(a => a !== main && range(a) > swing * 0.7)) return false // whole-head jolt, not a nod

      // out and back: the window starts and ends near the baseline, the extreme is in between
      const base = median(calm.map(c => c[main]))
      const first = buf[0][main], last = buf[buf.length - 1][main]
      const peakIdx = buf.reduce((bi, b, i) => (Math.abs(b[main] - base) > Math.abs(buf[bi][main] - base) ? i : bi), 0)
      const back = (v: number) => Math.abs(v - base) < swing * 0.35
      if (back(first) && back(last) && peakIdx > 0 && peakIdx < buf.length - 1) {
        lastNod = s.t
        buf = []
        return true
      }
      return false
    },
    reset() { buf = []; calm = []; lastNod = -Infinity },
  }
}
