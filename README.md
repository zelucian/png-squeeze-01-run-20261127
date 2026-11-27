# Lossless PNG compressor — 717,154/1,000,000 on the practice set

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/zelucian/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/zelucian/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

A lossless PNG compressor for 1280×720 screenshots, written as a single
`main.ts` (43,204 bytes) in Node 22 with only the standard library. It reads
each input PNG, re-encodes it as small as possible, and writes it back
pixel-exact — every pixel, including the RGB of fully transparent pixels,
round-trips unchanged.

## How it works

1. **Own PNG decoder.** Decodes the input to RGBA with a hand-written decoder
   (bit depth 8, non-interlaced, colour types 0, 2, 3, 4, 6), validating CRCs
   and chunk structure.
2. **Colour-form reduction.** Chooses the cheapest colour form per image:
   palette (≤256 colours, ordered by frequency or luminance), grey,
   grey+alpha, RGB/RGBA, or a `tRNS` transparency key when every non-opaque
   pixel is the same fully-transparent value.
3. **Per-row filter screening.** Tries all five PNG filters per scanline and
   picks per row with fixed, minimum-sum, fewest-pairs, and brute-force
   (true deflate cost with dictionary context) heuristics, screened by a full
   zlib level-6 run of each candidate.
4. **Pure-JS deflate.** Hash-chain LZ77 matching (found once per block and
   shared), a lazy parse for the first Huffman table, then one optimal parse
   — shortest path over length-code boundaries with length-limited dynamic
   Huffman codes and block splitting — with a zlib level-9 fallback (plain
   and filtered strategy) whenever it is smaller.
5. **Safety net.** Emits only IHDR / PLTE / tRNS / IDAT / IEND, bit depth 8,
   non-interlaced, and never emits more bytes than the stored input itself
   (4 MiB cap per answer file).

Budgeting is by work, never by the clock: fixed chain limits, fixed block
sizes, fixed iteration counts — so two runs are byte-identical.

## Measured results

`grade-local` on the practice set, `--driver process`:

- **Score: 717,154 / 1,000,000** vs baseline fixed-paeth **420,399** — **+70.6%**
- **8/8 instances answered**
- Per-instance points: 720.8 / 700.4 / 702.3 / 720.5 / 757.5 / 706.2 / 701.9 / 727.7
- Two runs byte-identical (deterministic)

## How to run

```sh
# main.ts is the whole entry: it reads /input/<id>/image.png
# and writes /output/<id>/image.png for every instance.
# Node 22, no dependencies, no network.
node --experimental-strip-types main.ts
```

Runtime is ~31 s for the 8 practice instances, against the 60 s wall.

## Edge cases

The pipeline is lossless by construction, and these degenerate inputs are
handled explicitly rather than by luck:

- **True noise** — no repeated structure; the pure-JS deflate falls back to
  zlib level 9, and the stored-input safety net caps the output at the input
  size, so a noisy image can never come out larger than it went in.
- **Single colour** — one palette entry (or a single grey value); the filter
  and deflate stages collapse every row to a handful of bytes.
- **All-transparent varied RGB** — pixels that are fully transparent keep
  their RGB values exactly; a `tRNS` key is used only when every
  non-opaque pixel shares one transparent value that no opaque pixel uses,
  otherwise the image stays RGBA.
- **Exactly 257 colours** — just over the palette limit, so the palette form
  is skipped and the image falls through to grey/RGB/RGBA; no colour is
  ever dropped or quantised.
- **Grey + partial alpha** — grey+alpha (colour type 4) keeps the grey
  channel and per-pixel alpha without expanding to RGBA.
- **Gradient** — smooth ramps compress through per-row Paeth filtering and
  long LZ77 matches; the brute-force filter choice picks the filter with the
  lowest true deflate cost per row.

In every case the output is pixel-exact: the decoded RGBA of the output
equals the decoded RGBA of the input, including fully transparent pixels.

## License

MIT — see [LICENSE](LICENSE).

*Built with Muse. [?ref=182mp9cr](https://make.fun/bounty/png-squeeze-01-run-20261127?ref=182mp9cr)*
