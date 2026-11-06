/**
 * SHA-256 in plain JavaScript, for pages where SubtleCrypto is missing (it is only exposed in
 * secure contexts), so a shard's hash is checked on plain-HTTP sites too.
 */

// The first 32 bits of the fractional parts of the cube roots (K) and square roots (H) of the
// first 64 primes, computed rather than listed: each lies at least 0.005 units from a rounding
// boundary, far more than Math.cbrt's error in any engine.
const PRIMES: number[] = [];
for (let n = 2; PRIMES.length < 64; n++) if (PRIMES.every((p) => n % p)) PRIMES.push(n);
const fraction = (x: number) => (x % 1) * 2 ** 32;
const K = Uint32Array.from(PRIMES, (p) => fraction(Math.cbrt(p)));
const H = Uint32Array.from(PRIMES.slice(0, 8), (p) => fraction(Math.sqrt(p)));

/** The SHA-256 of `bytes`, as 64 hex digits. */
export function sha256Hex(bytes: Uint8Array): string {
  const length = bytes.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);
  const h = H.slice();
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const t1 = (hh! + s1 + ((e! & f!) ^ (~e! & g!)) + K[i]! + w[i]!) | 0;
      const s0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const t2 = (s0 + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d! + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0]! += a!;
    h[1]! += b!;
    h[2]! += c!;
    h[3]! += d!;
    h[4]! += e!;
    h[5]! += f!;
    h[6]! += g!;
    h[7]! += hh!;
  }
  let hex = '';
  for (const word of h) hex += word.toString(16).padStart(8, '0');
  return hex;
}
