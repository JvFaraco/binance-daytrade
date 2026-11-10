// random.Random do CPython: Mersenne Twister MT19937 com a mesma semeadura (init_by_array)
// e o mesmo choice() (_randbelow por rejeição com getrandbits). Com isso os replays do
// Time Machine sorteiam exatamente os mesmos candles que o timemachine.py para uma seed.

const N = 624;
const M = 397;

export class PyRandom {
  private mt = new Uint32Array(N);
  private idx = N + 1;

  constructor(seed: number) {
    this.seed(seed);
  }

  /** seed(int): usa o valor absoluto, em pedaços de 32 bits, como o CPython. */
  seed(seed: number): void {
    if (!Number.isSafeInteger(seed)) throw new RangeError("seed precisa ser um inteiro seguro");
    let s = Math.abs(seed);
    const key: number[] = [];
    do {
      key.push(s % 4294967296);
      s = Math.floor(s / 4294967296);
    } while (s > 0);
    this.initGenrand(19650218);
    const mt = this.mt;
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1];
      mt[i] = ((mt[i] ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1];
      mt[i] = ((mt[i] ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
    this.idx = N;
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1];
      mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.idx = N;
  }

  private twist(): void {
    const mt = this.mt;
    let kk = 0;
    for (; kk < N - M; kk++) {
      const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
      mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
    }
    for (; kk < N - 1; kk++) {
      const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
      mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
    }
    const y = (mt[N - 1] & 0x80000000) | (mt[0] & 0x7fffffff);
    mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
    this.idx = 0;
  }

  /** 32 bits sem sinal. */
  uint32(): number {
    if (this.idx >= N) this.twist();
    let y = this.mt[this.idx++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** random(): 53 bits em [0, 1). */
  random(): number {
    const a = this.uint32() >>> 5;
    const b = this.uint32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** getrandbits(k) para 1 <= k <= 32. */
  getrandbits(k: number): number {
    return this.uint32() >>> (32 - k);
  }

  /** _randbelow(n) para 1 <= n < 2**32: o índice que choice() usa. */
  randbelow(n: number): number {
    const k = 32 - Math.clz32(n); // n.bit_length()
    let r = this.uint32() >>> (32 - k);
    while (r >= n) r = this.uint32() >>> (32 - k);
    return r;
  }
}
