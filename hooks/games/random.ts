// The next random state. Games keep it as `seed` and read numbers from it
// with `pick`, which mixes all 32 bits (mulberry32): taking `seed % n` of a
// plain generator repeats in its low bits and left columns no rock reached.
export const rand = (seed: number) => (seed + 0x6d2b79f5) >>> 0

// A whole number from 0 to n - 1 drawn from `seed`, every value equally likely.
export const pick = (seed: number, n: number) => {
  let t = seed | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
}
