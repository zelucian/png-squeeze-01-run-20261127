// png-squeeze-01: squeeze 1280x720 screenshots into the smallest lossless PNG.
//
// Strategy (all in this file, Node 22 stdlib only, deterministic):
//   1. Decode the input PNG to RGBA with our own decoder.
//   2. Reduce the colour form: palette (<=256 colours), grey / grey+alpha, RGB / RGBA,
//      or a tRNS key when every non-opaque pixel is one fully-transparent value.
//   3. Choose filters per row: fixed filters, min-sum, fewest-pairs and a per-row
//      brute-force (true deflate cost with dictionary context), screened by a full
//      zlib level-6 run of each candidate.
//   4. Compress the winner with a pure-JS deflate: hash-chain matching found
//      once per block, a lazy parse for the first Huffman table, then one
//      optimal parse (shortest path over length-code boundaries, dynamic
//      Huffman costs), length-limited Huffman codes, block splitting;
//      fall back to zlib level 9 when it is smaller.
//   5. Emit only IHDR / PLTE / tRNS / IDAT / IEND, bit depth 8, non-interlaced.
//
// Budgeting is by work, never by the clock: fixed chain limits, fixed block sizes,
// fixed iteration counts, so two runs are byte-identical.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const MAX_OUT = 4194304; // 4 MiB per answer file

// ---------------------------------------------------------------------------
// CRC-32 (PNG's ISO 3309) and chunk writing.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function pngOf(chunks: Array<[string, Uint8Array]>): Uint8Array {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------------------------------------------------------------------------
// PNG decoding to RGBA (bit depth 8, non-interlaced, colour types 0,2,3,4,6).
// ---------------------------------------------------------------------------
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('truncated chunk');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) throw new Error('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (!['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) throw new Error(`chunk ${type} not accepted`);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(`${type} CRC mismatch`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      if (header !== null || len !== 13) throw new Error('bad IHDR');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
      if (data[8] !== 8 || !Object.hasOwn(CHANNELS, header.colourType) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error('unsupported IHDR');
      }
    } else if (type === 'PLTE') {
      if (palette !== null || header === null || header.colourType !== 3 || idat.length > 0 || len === 0 || len % 3 !== 0 || len > 768) {
        throw new Error('bad PLTE');
      }
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null || header === null || idat.length > 0) throw new Error('bad tRNS');
      const ct = header.colourType;
      if (ct === 3) {
        if (palette === null || len > palette.length / 3) throw new Error('bad tRNS for palette');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) throw new Error('bad tRNS length');
      } else throw new Error('tRNS with alpha colour type');
      trns = data;
    } else if (type === 'IDAT') {
      if (header === null || (header.colourType === 3 && palette === null)) throw new Error('bad IDAT');
      idat.push(data);
    } else {
      if (len !== 0) throw new Error('non-empty IEND');
      ended = true;
    }
  }
  if (!ended || !header || idat.length === 0) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('IDAT inflates to the wrong length');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error(`row ${y} has filter type ${ft}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = (palette as Uint8Array).length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = (palette as Uint8Array)[e * 3];
      lut[e * 4 + 1] = (palette as Uint8Array)[e * 3 + 1];
      lut[e * 4 + 2] = (palette as Uint8Array)[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error(`palette index ${e} out of range`);
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Image analysis: opacity, greyness, colour census (<=256), transparent key.
// ---------------------------------------------------------------------------
interface Colour { rgba: [number, number, number, number]; word: number; count: number }

function analyse(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: Colour[] | null } {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  if (many) return { opaque, grey, colours: null };
  const colours: Colour[] = [...counts.entries()].map(([word, count]) => ({
    rgba: [(word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff] as [number, number, number, number],
    word,
    count,
  }));
  return { opaque, grey, colours };
}

// One fully-transparent value (grey or RGB) every non-opaque pixel shares, which
// no opaque pixel uses, so a tRNS key can replace the alpha channel. Else null.
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

interface PaletteForm { plte: Uint8Array; trns: Uint8Array | null; indices: Uint8Array }

function paletteForm(rgba: Uint8Array, colours: Colour[], order: string): PaletteForm {
  const lum = (c: Colour): number => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    indices[i] = index.get((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) as number;
  }
  return { plte, trns, indices };
}

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: Array<number | string>;
}

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0]],
      ['luminance', [0, 'minsum', 'brute']],
    ] as Array<[string, Array<number | string>]>) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[ct] as number;
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    filters: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

// ---------------------------------------------------------------------------
// PNG row filters and filter-choice heuristics.
// ---------------------------------------------------------------------------
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 1;

// Filter every row of `samples` by every `choice` at once: the five trial rows
// are computed a single time per row and then scored by each heuristic, so the
// filter work is one pass instead of one per candidate.
function filterCandidates(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  choices: Array<number | string>,
): Array<{ choice: number | string; data: Uint8Array }> {
  const stride = width * bpp;
  const outs = choices.map(() => new Uint8Array(height * (stride + 1)));
  const trial = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  const needSums = choices.includes('minsum');
  const needPairs = choices.includes('pairs');
  const needBrute = choices.includes('brute');
  const bruteIdx = choices.indexOf('brute');
  // Only the filter types some choice actually needs are computed per row.
  const needType = [false, false, false, false, false];
  for (const c of choices) {
    if (typeof c === 'number') needType[c] = true;
    else needType.fill(true);
  }
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    for (let t = 0; t < 5; t++) if (needType[t]) filterRow(t, cur, prev, bpp, trial[t].subarray(1));
    const sums = needSums ? trial.map((r) => signedSum(r.subarray(1))) : null;
    const pairCounts = needPairs ? trial.map((r) => pairsOf(r.subarray(1), seen, ++stamp)) : null;
    // The brute cost of each trial row, weighed by deflate with the brute
    // stream's own bytes so far as its dictionary; only computed when asked for.
    const before =
      bruteIdx < 0 ? null : outs[bruteIdx].subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let bruteCosts: number[] | null = null;
    const picks = new Int8Array(choices.length);
    for (let c = 0; c < choices.length; c++) {
      const choice = choices[c];
      if (typeof choice === 'number') picks[c] = choice;
      else if (choice === 'minsum') picks[c] = argmin(sums as number[]);
      else if (choice === 'pairs') picks[c] = argmin(pairCounts as number[]);
      else {
        if (bruteCosts === null) {
          bruteCosts = trial.map((r) =>
            deflateSync(
              r,
              before === null || before.length === 0
                ? { level: BRUTE_LEVEL, memLevel: 9 }
                : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before },
            ).length,
          );
        }
        picks[c] = argmin(bruteCosts);
      }
    }
    for (let c = 0; c < choices.length; c++) outs[c].set(trial[picks[c]], at);
  }
  return choices.map((choice, c) => ({ choice, data: outs[c] }));
}

function argmin(xs: number[]): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] < xs[best]) best = i;
  return best;
}

// ---------------------------------------------------------------------------
// Pure-JS deflate: hash-chain LZ77, optimal parsing, length-limited Huffman.
// ---------------------------------------------------------------------------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Length-code boundaries plus every length that can be a DP candidate: the
// boundaries themselves and the longest match itself (handled per position).
// Only boundaries within 64 of the longest match are kept: ending a match
// much earlier than its longest length is never worth the extra token, and
// the shorter window makes the parse ~2x faster at identical output.
const LEN_CANDS: number[][] = (() => {
  const bounds = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const out: number[][] = [];
  for (let l = 0; l <= 258; l++) {
    const c = bounds.filter((b) => b <= l && b >= l - 64);
    if (l >= 3 && !c.includes(l)) c.push(l);
    out.push(c);
  }
  return out;
})();

function lenSym(len: number): number {
  // Length 258 is its own symbol (285): code 284 covers 227-257 only, even
  // though its 5 extra bits could express 258 — emitting 284+31 would waste
  // 5 bits per 258-byte match and hide full-length matches from the DP.
  if (len === 258) return 28;
  for (let s = 0; s < 28; s++) {
    if (len <= LEN_BASE[s] + (LEN_EXTRA[s] ? (1 << LEN_EXTRA[s]) - 1 : 0)) return s;
  }
  return 28;
}

function distSym(dist: number): number {
  for (let s = 0; s < 30; s++) {
    if (dist <= DIST_BASE[s] + (DIST_EXTRA[s] ? (1 << DIST_EXTRA[s]) - 1 : 0)) return s;
  }
  return 29;
}

// Lookup tables: length symbol and distance symbol for every value, so the
// optimal parse's inner loop is table reads, not scans.
const LEN_SYM: Uint8Array = (() => {
  const t = new Uint8Array(259);
  for (let l = 0; l <= 258; l++) t[l] = lenSym(l);
  return t;
})();
const DIST_SYM: Uint8Array = (() => {
  const t = new Uint8Array(32769);
  for (let d = 0; d <= 32768; d++) t[d] = distSym(d);
  return t;
})();

function lenExtraVal(len: number, sym: number): number {
  return len - LEN_BASE[sym];
}

function distExtraVal(dist: number, sym: number): number {
  return dist - DIST_BASE[sym];
}

// Fixed Huffman tables (RFC 1951).
const FIXED_LIT_LEN = new Uint8Array(288);
const FIXED_DIST_LEN = new Uint8Array(30);
for (let i = 0; i < 288; i++) FIXED_LIT_LEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
for (let i = 0; i < 30; i++) FIXED_DIST_LEN[i] = 5;

// Length-limited Huffman lengths from frequencies (two-queue Huffman tree +
// zlib's overflow redistribution, then length assignment by frequency).
function huffmanLengths(freq: Uint32Array, maxLen: number): Uint8Array {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  const f = freq.slice();
  if (syms.length === 1) {
    const dummy = syms[0] === 0 ? 1 : 0;
    f[dummy] = 1;
    syms.push(dummy);
  }
  syms.sort((a, b) => f[a] - f[b] || a - b);
  const m = syms.length;
  const parent = new Int32Array(2 * m).fill(-1);
  const nodeFreq = new Float64Array(2 * m);
  for (let i = 0; i < m; i++) nodeFreq[i] = f[syms[i]];
  let next = m;
  let li = 0;
  let ii = m;
  const take = (): number => {
    if (li < m && (ii >= next || nodeFreq[li] <= nodeFreq[ii])) return li++;
    return ii++;
  };
  for (let k = 0; k < m - 1; k++) {
    const a = take();
    const b = take();
    nodeFreq[next] = nodeFreq[a] + nodeFreq[b];
    parent[a] = next;
    parent[b] = next;
    next++;
  }
  const blCount = new Int32Array(maxLen + 1);
  let overflow = 0;
  const depth = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    let d = 0;
    let x = i;
    while (parent[x] !== -1) {
      d++;
      x = parent[x];
    }
    depth[i] = d;
    if (d > maxLen) {
      overflow++;
      blCount[maxLen]++;
    } else blCount[d]++;
  }
  while (overflow > 0) {
    let bits = maxLen - 1;
    while (blCount[bits] === 0) bits--;
    blCount[bits]--;
    blCount[bits + 1] += 2;
    blCount[maxLen]--;
    overflow -= 2;
  }
  const order = [...syms].sort((a, b) => f[b] - f[a] || a - b);
  let idx = 0;
  for (let len = 1; len <= maxLen; len++) {
    for (let k = 0; k < blCount[len]; k++) lengths[order[idx++]] = len;
  }
  return lengths;
}

// Canonical codes from lengths, bit-reversed for LSB-first deflate output.
function canonicalCodes(lengths: Uint8Array): Uint16Array {
  const maxLen = Math.max(0, ...lengths);
  const blCount = new Int32Array(maxLen + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Int32Array(maxLen + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) {
    const l = lengths[sym];
    if (l === 0) continue;
    let c = nextCode[l]++;
    let rev = 0;
    for (let k = 0; k < l; k++) {
      rev = (rev << 1) | (c & 1);
      c >>>= 1;
    }
    codes[sym] = rev;
  }
  return codes;
}

class BitWriter {
  buf: Uint8Array;
  pos = 0;
  bitBuf = 0;
  bitCnt = 0;
  constructor(capacity: number) {
    this.buf = new Uint8Array(capacity);
  }
  grow(need: number): void {
    if (this.pos + need + 8 <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + need + 1024));
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  }
  writeBits(value: number, len: number): void {
    this.bitBuf |= value << this.bitCnt;
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      this.grow(1);
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  writeCode(code: number, len: number): void {
    this.writeBits(code, len);
  }
  finish(): Uint8Array {
    if (this.bitCnt > 0) {
      this.grow(1);
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
    return this.buf.subarray(0, this.pos);
  }
}

// One block's tokens as parallel arrays: literals in `lit`, matches flagged by
// `isMatch` with their length in `matchLen` and distance in `matchDist`.
interface Parse { lit: Uint8Array; isMatch: Uint8Array; matchLen: Uint16Array; matchDist: Uint32Array; count: number }

const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
// Chain limits by filtered size (a function of the input only, so the run
// stays deterministic): small streams get a deep search, which flips them
// past zlib level 9; large streams get a shallow search with the good-length
// cap, where depth costs far more than it saves.
const CHAIN_SMALL = 512;
const CHAIN_LARGE = 32;
const CHAIN_SMALL_MAX_BYTES = 1000000;
const MAX_MATCH = 258;
const MIN_MATCH = 3;
const BLOCK_BYTES = 400000;

function hash3(d0: number, d1: number, d2: number): number {
  return (Math.imul((d0 << 16) | (d1 << 8) | d2, 2654435761) >>> 17) & (HASH_SIZE - 1);
}

// Longest match at block-relative `pos` (data is the block slice). `prev`/`head`
// hold the hash chains of positions already inserted (< pos).
function longestMatch(
  data: Uint8Array,
  pos: number,
  head: Int32Array,
  prev: Int32Array,
  chainLimit: number,
  useCap: boolean,
): { len: number; dist: number } {
  const n = data.length;
  if (pos + MIN_MATCH > n) return { len: 0, dist: 0 };
  const maxLen = Math.min(MAX_MATCH, n - pos);
  let best = MIN_MATCH - 1;
  let bestDist = 0;
  let cand = head[hash3(data[pos], data[pos + 1], data[pos + 2])];
  let chain = chainLimit;
  const limit = chainLimit >> 2;
  while (cand >= 0 && chain > 0) {
    const dist = pos - cand;
    if (dist > 32768) break;
    if (data[cand + best] === data[pos + best]) {
      let len = 0;
      while (len < maxLen && data[cand + len] === data[pos + len]) len++;
      if (len > best) {
        best = len;
        bestDist = dist;
        if (len >= maxLen) break;
        if (useCap && len >= 32) chain = Math.min(chain, limit);
      }
    }
    cand = prev[cand];
    chain--;
  }
  return best >= MIN_MATCH ? { len: best, dist: bestDist } : { len: 0, dist: 0 };
}

// Longest match at every position of one block, found once and shared by the
// lazy pass and the optimal parse (the match search dominates the runtime).
function findMatches(data: Uint8Array, chainLimit: number, useCap: boolean): { mLen: Int16Array; mDist: Int32Array } {
  const n = data.length;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n);
  const mLen = new Int16Array(n);
  const mDist = new Int32Array(n);
  for (let p = 0; p < n; p++) {
    if (p + MIN_MATCH <= n) {
      const m = longestMatch(data, p, head, prev, chainLimit, useCap);
      mLen[p] = m.len;
      mDist[p] = m.dist;
    }
    if (p + MIN_MATCH <= n) {
      const h = hash3(data[p], data[p + 1], data[p + 2]);
      prev[p] = head[h];
      head[h] = p;
    } else prev[p] = -1;
  }
  return { mLen, mDist };
}

// Greedy parse with lazy evaluation over precomputed matches: at each position
// take the match unless the next position's match is longer. Cheap frequencies
// for the first Huffman table; the optimal parse below refines the tokens.
function lazyParse(data: Uint8Array, mLen: Int16Array, mDist: Int32Array): Parse {
  const n = data.length;
  const lit = new Uint8Array(n);
  const isMatch = new Uint8Array(n);
  const matchLen = new Uint16Array(n);
  const matchDist = new Uint32Array(n);
  let count = 0;
  let i = 0;
  while (i < n) {
    const L = mLen[i];
    if (L >= MIN_MATCH && mLen[i + 1] > L) {
      lit[count] = data[i];
      isMatch[count] = 0;
      count++;
      i++;
      continue;
    }
    if (L >= MIN_MATCH) {
      lit[count] = 0;
      isMatch[count] = 1;
      matchLen[count] = L;
      matchDist[count] = mDist[i];
      count++;
      i += L;
    } else {
      lit[count] = data[i];
      isMatch[count] = 0;
      count++;
      i++;
    }
  }
  return { lit, isMatch, matchLen, matchDist, count };
}

// Optimal parse of one block with the given per-symbol bit costs, over the
// precomputed matches: shortest path, match lengths restricted to length-code
// boundaries and the longest match itself. Backpointers (the step that ends at
// each position) drive the reconstruction: a forward choice per position would
// be overwritten by every later length that improves a different target.
function optimalParse(
  data: Uint8Array,
  mLen: Int16Array,
  mDist: Int32Array,
  litCost: Float64Array,
  lenCost: Float64Array,
  distCost: Float64Array,
): Parse {
  const n = data.length;
  const cost = new Float64Array(n + 1);
  cost.fill(Infinity);
  cost[0] = 0;
  const backLen = new Int32Array(n + 1);
  const backDist = new Int32Array(n + 1);
  // Per-length and per-distance step costs under this pass's tables, so the
  // inner loop is a few array reads.
  const lenStep = new Float64Array(259);
  for (let l = 3; l <= 258; l++) lenStep[l] = lenCost[LEN_SYM[l]] + LEN_EXTRA[LEN_SYM[l]];
  const distStep = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) distStep[d] = distCost[DIST_SYM[d]] + DIST_EXTRA[DIST_SYM[d]];
  for (let i = 0; i < n; i++) {
    const base = cost[i];
    if (base === Infinity) continue;
    const litC = base + litCost[data[i]];
    if (litC < cost[i + 1]) {
      cost[i + 1] = litC;
      backLen[i + 1] = 1;
      backDist[i + 1] = 0;
    }
    const L = mLen[i];
    if (L >= MIN_MATCH) {
      const dc = base + distStep[mDist[i]];
      const cands = LEN_CANDS[L];
      for (let k = 0; k < cands.length; k++) {
        const l = cands[k];
        const c = dc + lenStep[l];
        if (c < cost[i + l]) {
          cost[i + l] = c;
          backLen[i + l] = l;
          backDist[i + l] = mDist[i];
        }
      }
    }
  }
  // Reconstruct backwards from n, then reverse the tokens.
  const lit = new Uint8Array(n);
  const isMatch = new Uint8Array(n);
  const matchLen = new Uint16Array(n);
  const matchDist = new Uint32Array(n);
  let count = 0;
  let j = n;
  while (j > 0) {
    const l = backLen[j];
    const i = j - l;
    if (l <= 1) {
      lit[count] = data[i];
      isMatch[count] = 0;
    } else {
      lit[count] = 0;
      isMatch[count] = 1;
      matchLen[count] = l;
      matchDist[count] = backDist[j];
    }
    count++;
    j = i;
  }
  // Reverse in place.
  for (let a = 0, b = count - 1; a < b; a++, b--) {
    const tl = lit[a];
    lit[a] = lit[b];
    lit[b] = tl;
    const tm = isMatch[a];
    isMatch[a] = isMatch[b];
    isMatch[b] = tm;
    const tn = matchLen[a];
    matchLen[a] = matchLen[b];
    matchLen[b] = tn;
    const td = matchDist[a];
    matchDist[a] = matchDist[b];
    matchDist[b] = td;
  }
  return { lit, isMatch, matchLen, matchDist, count };
}

function countFrequencies(p: Parse): { litFreq: Uint32Array; distFreq: Uint32Array } {
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  for (let k = 0; k < p.count; k++) {
    if (p.isMatch[k] === 0) litFreq[p.lit[k]]++;
    else {
      litFreq[257 + lenSym(p.matchLen[k])]++;
      distFreq[distSym(p.matchDist[k])]++;
    }
  }
  litFreq[256]++; // end of block
  return { litFreq, distFreq };
}

// Cost tables from Huffman lengths: literal cost, length-symbol cost, distance cost.
function costTables(
  litLen: Uint8Array,
  distLen: Uint8Array,
): { litCost: Float64Array; lenCost: Float64Array; distCost: Float64Array } {
  const litCost = new Float64Array(256);
  for (let i = 0; i < 256; i++) litCost[i] = litLen[i];
  const lenCost = new Float64Array(29);
  for (let s = 0; s < 29; s++) lenCost[s] = litLen[257 + s];
  const distCost = new Float64Array(30);
  for (let s = 0; s < 30; s++) distCost[s] = distLen[s];
  return { litCost, lenCost, distCost };
}

// Emit one block's tokens with fixed or dynamic Huffman, whichever is smaller.
function emitBlock(p: Parse, isFinal: boolean, bw: BitWriter): void {
  const { litFreq, distFreq } = countFrequencies(p);
  const dynLitLen = huffmanLengths(litFreq, 15);
  const dynDistLen = huffmanLengths(distFreq, 15);
  // Trim trailing zero lengths for the header.
  let hlit = 29;
  while (hlit > 0 && dynLitLen[256 + hlit] === 0) hlit--;
  let hdist = 29;
  while (hdist > 0 && dynDistLen[hdist] === 0) hdist--;
  const litCount = 257 + hlit;
  const distCount = 1 + hdist;
  // RLE-encode the code-length sequence.
  const seqLen = litCount + distCount;
  const seq = new Uint8Array(seqLen);
  seq.set(dynLitLen.subarray(0, litCount), 0);
  seq.set(dynDistLen.subarray(0, distCount), litCount);
  const rleSyms: number[] = [];
  const rleExtra: number[] = [];
  let i = 0;
  while (i < seqLen) {
    const v = seq[i];
    let run = 1;
    while (i + run < seqLen && seq[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) {
        const take = Math.min(r, 138);
        rleSyms.push(18);
        rleExtra.push(take - 11);
        r -= take;
      }
      if (r >= 3) {
        rleSyms.push(17);
        rleExtra.push(r - 3);
        r = 0;
      }
      while (r > 0) {
        rleSyms.push(0);
        rleExtra.push(0);
        r--;
      }
    } else {
      rleSyms.push(v);
      rleExtra.push(0);
      let r = run - 1;
      while (r >= 3) {
        const take = Math.min(r, 6);
        rleSyms.push(16);
        rleExtra.push(take - 3);
        r -= take;
      }
      while (r > 0) {
        rleSyms.push(v);
        rleExtra.push(0);
        r--;
      }
    }
    i += run;
  }
  const clFreq = new Uint32Array(19);
  for (const s of rleSyms) clFreq[s]++;
  const clLen = huffmanLengths(clFreq, 7);
  const clCode = canonicalCodes(clLen);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  // Bit cost of the dynamic header.
  let dynHeaderBits = 14 + 3 * hclen;
  for (let k = 0; k < rleSyms.length; k++) {
    dynHeaderBits += clLen[rleSyms[k]];
    if (rleSyms[k] === 16) dynHeaderBits += 2;
    else if (rleSyms[k] === 17) dynHeaderBits += 3;
    else if (rleSyms[k] === 18) dynHeaderBits += 7;
  }
  let dynDataBits = 0;
  for (let s = 0; s < 288; s++) dynDataBits += litFreq[s] * dynLitLen[s];
  for (let s = 0; s < 30; s++) dynDataBits += distFreq[s] * dynDistLen[s];
  let fixedBits = 0;
  for (let s = 0; s < 288; s++) fixedBits += litFreq[s] * FIXED_LIT_LEN[s];
  for (let s = 0; s < 30; s++) fixedBits += distFreq[s] * FIXED_DIST_LEN[s];
  const useDynamic = dynHeaderBits + dynDataBits < fixedBits + 3;
  if (useDynamic) {
    const litCode = canonicalCodes(dynLitLen);
    const distCode = canonicalCodes(dynDistLen);
    bw.writeBits(isFinal ? 1 : 0, 1);
    bw.writeBits(2, 2);
    bw.writeBits(hlit, 5);
    bw.writeBits(hdist, 5);
    bw.writeBits(hclen - 4, 4);
    for (let k = 0; k < hclen; k++) bw.writeBits(clLen[CL_ORDER[k]], 3);
    for (let k = 0; k < rleSyms.length; k++) {
      bw.writeCode(clCode[rleSyms[k]], clLen[rleSyms[k]]);
      if (rleSyms[k] === 16) bw.writeBits(rleExtra[k], 2);
      else if (rleSyms[k] === 17) bw.writeBits(rleExtra[k], 3);
      else if (rleSyms[k] === 18) bw.writeBits(rleExtra[k], 7);
    }
    for (let k = 0; k < p.count; k++) {
      if (p.isMatch[k] === 0) {
        bw.writeCode(litCode[p.lit[k]], dynLitLen[p.lit[k]]);
      } else {
        const l = p.matchLen[k];
        const d = p.matchDist[k];
        const ls = lenSym(l);
        const ds = distSym(d);
        bw.writeCode(litCode[257 + ls], dynLitLen[257 + ls]);
        if (LEN_EXTRA[ls] > 0) bw.writeBits(lenExtraVal(l, ls), LEN_EXTRA[ls]);
        bw.writeCode(distCode[ds], dynDistLen[ds]);
        if (DIST_EXTRA[ds] > 0) bw.writeBits(distExtraVal(d, ds), DIST_EXTRA[ds]);
      }
    }
    bw.writeCode(litCode[256], dynLitLen[256]);
  } else {
    const litCode = canonicalCodes(FIXED_LIT_LEN);
    const distCode = canonicalCodes(FIXED_DIST_LEN);
    bw.writeBits(isFinal ? 1 : 0, 1);
    bw.writeBits(1, 2);
    for (let k = 0; k < p.count; k++) {
      if (p.isMatch[k] === 0) {
        bw.writeCode(litCode[p.lit[k]], FIXED_LIT_LEN[p.lit[k]]);
      } else {
        const l = p.matchLen[k];
        const d = p.matchDist[k];
        const ls = lenSym(l);
        const ds = distSym(d);
        bw.writeCode(litCode[257 + ls], FIXED_LIT_LEN[257 + ls]);
        if (LEN_EXTRA[ls] > 0) bw.writeBits(lenExtraVal(l, ls), LEN_EXTRA[ls]);
        bw.writeCode(distCode[ds], FIXED_DIST_LEN[ds]);
        if (DIST_EXTRA[ds] > 0) bw.writeBits(distExtraVal(d, ds), DIST_EXTRA[ds]);
      }
    }
    bw.writeCode(litCode[256], FIXED_LIT_LEN[256]);
  }
}

// Full custom deflate of `data`: blocks of <= BLOCK_BYTES, one match search per
// block shared by a lazy parse (first Huffman table) and one optimal parse
// (dynamic costs), zlib stream wrapper (adler-32).
function customDeflate(data: Uint8Array, chainLimit: number, useCap: boolean): Uint8Array {
  const bw = new BitWriter(data.length + 65536);
  const nBlocks = Math.max(1, Math.ceil(data.length / BLOCK_BYTES));
  for (let b = 0; b < nBlocks; b++) {
    const start = b * BLOCK_BYTES;
    const end = Math.min(data.length, start + BLOCK_BYTES);
    const block = data.subarray(start, end);
    const isFinal = b === nBlocks - 1;
    if (block.length === 0) {
      bw.writeBits(isFinal ? 1 : 0, 1);
      bw.writeBits(1, 2);
      bw.writeCode(canonicalCodes(FIXED_LIT_LEN)[256], FIXED_LIT_LEN[256]);
      continue;
    }
    const { mLen, mDist } = findMatches(block, chainLimit, useCap);
    const p1 = lazyParse(block, mLen, mDist);
    const f1 = countFrequencies(p1);
    const dynLit = huffmanLengths(f1.litFreq, 15);
    const dynDist = huffmanLengths(f1.distFreq, 15);
    const dyn = costTables(dynLit, dynDist);
    const p2 = optimalParse(block, mLen, mDist, dyn.litCost, dyn.lenCost, dyn.distCost);
    emitBlock(p2, isFinal, bw);
  }
  const raw = bw.finish();
  // Wrap in a zlib stream: header 0x78 0x9c, adler-32 trailer.
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; ) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  const adler = ((b << 16) | a) >>> 0;
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(raw, 2);
  const v = new DataView(out.buffer);
  v.setUint32(raw.length + 2, adler);
  return out;
}

// ---------------------------------------------------------------------------
// Per-image pipeline: pick the best form + filter by zlib-6 screening, then
// compress with the custom deflate (zlib-9 as a safety net), build the PNG.
// ---------------------------------------------------------------------------
const SCREEN = { level: 6, memLevel: 8 };

function chunkBytes(form: Form): number {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

function pngOfForm(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const chunks: Array<[string, Uint8Array]> = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

function squeeze(rgba: Uint8Array, width: number, height: number, inputBytes: Uint8Array): Uint8Array {
  let best: { form: Form; data: Uint8Array; bytes: number } | null = null;
  for (const form of formsOf(rgba)) {
    const chunks = chunkBytes(form);
    for (const { data } of filterCandidates(form.samples, width, height, form.bpp, form.filters)) {
      const bytes = deflateSync(data, SCREEN).length + chunks;
      if (best === null || bytes < best.bytes) best = { form, data, bytes };
    }
  }
  const { form, data } = best as { form: Form; data: Uint8Array; bytes: number };
  // Final deflate: our optimal parser, with zlib level 9 as a safety net.
  // Small streams get the deep chain search; large ones the capped shallow one.
  const small = data.length <= CHAIN_SMALL_MAX_BYTES;
  const chainLimit = small ? CHAIN_SMALL : CHAIN_LARGE;
  const useCap = !small;
  let idat = customDeflate(data, chainLimit, useCap);
  const z9 = deflateSync(data, { level: 9, memLevel: 9 });
  if (z9.length < idat.length) idat = new Uint8Array(z9.buffer, z9.byteOffset, z9.length);
  const z9f = deflateSync(data, { level: 9, memLevel: 9, strategy: 1 });
  if (z9f.length < idat.length) idat = new Uint8Array(z9f.buffer, z9f.byteOffset, z9f.length);
  const out = pngOfForm(width, height, form, idat);
  // Ultimate safety: never exceed the size cap, and never emit more bytes
  // than the stored input itself (which is already a valid answer).
  if (out.length > MAX_OUT || out.length > inputBytes.length) return inputBytes;
  return out;
}

// ---------------------------------------------------------------------------
// Driver: every instance under /input/<id>/image.png -> /output/<id>/image.png.
// ---------------------------------------------------------------------------
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const input = new Uint8Array(readFileSync(join(I, id, 'image.png')));
  const image = decodePng(input);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeeze(image.rgba, image.width, image.height, input));
}
