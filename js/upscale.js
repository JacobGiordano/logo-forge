// ── Perceptual upscaler (Scale2x / Scale3x family) ───────────────────────
//
// Edge-preserving integer upscaler for flat-color, sharp-edge pixel data —
// the Scale2x/AdvMAME2x and Scale3x/AdvMAME3x rules, well-documented
// algorithms originally built for pixel-art scaling in emulators. They look
// at a pixel's orthogonal neighbors and only "grow" an edge into the new
// sub-pixels when the neighbors agree on which side the edge is on;
// otherwise they fall back to the source pixel. That keeps diagonal edges
// looking like clean diagonals instead of blocky stairsteps or the blurry
// result a bicubic/bilinear resize would produce.
//
// This module works on a single-channel Uint8Array (row-major, one byte per
// pixel) — deliberately generic over what those byte values mean, but in
// this app it is fed the binary (0/1) mask, not the raw RGBA source image.
// Pure JS, zero dependencies.
//
// Exposed as `Upscale` on window/globalThis, loaded via <script> tag like
// the other vendored libs (imagetracer.js, zip.js).

(function (global) {
  'use strict';

  function at(src, w, h, x, y) {
    if (x < 0) x = 0; else if (x >= w) x = w - 1;
    if (y < 0) y = 0; else if (y >= h) y = h - 1;
    return src[y * w + x];
  }

  // Scale2x / AdvMAME2x: doubles each source pixel into a 2x2 block.
  //
  //      B
  //   D  E  F      ->   E0 E1
  //      H               E2 E3
  //
  // E0 = (D==B && B!=F && D!=H) ? D : E   (and so on for the other corners)
  function scale2x(src, w, h) {
    const dw = w * 2;
    const dh = h * 2;
    const dst = new Uint8Array(dw * dh);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const E = at(src, w, h, x, y);
        const B = at(src, w, h, x, y - 1);
        const D = at(src, w, h, x - 1, y);
        const F = at(src, w, h, x + 1, y);
        const H = at(src, w, h, x, y + 1);

        let E0 = E, E1 = E, E2 = E, E3 = E;
        if (B !== H && D !== F) {
          E0 = D === B ? D : E;
          E1 = B === F ? F : E;
          E2 = D === H ? D : E;
          E3 = H === F ? F : E;
        }

        const ox = x * 2;
        const oy = y * 2;
        dst[oy * dw + ox] = E0;
        dst[oy * dw + ox + 1] = E1;
        dst[(oy + 1) * dw + ox] = E2;
        dst[(oy + 1) * dw + ox + 1] = E3;
      }
    }

    return { data: dst, width: dw, height: dh };
  }

  // Scale3x / AdvMAME3x: triples each source pixel into a 3x3 block using
  // the full 3x3 neighborhood. Same "only grow into a corner if the
  // neighbors agree" principle as Scale2x, extended with corner checks
  // against the diagonal neighbors (A, C, G, I) to avoid eating into
  // adjacent shapes.
  //
  //   A B C        E0 E1 E2
  //   D E F   ->   E3 E4 E5
  //   G H I        E6 E7 E8
  function scale3x(src, w, h) {
    const dw = w * 3;
    const dh = h * 3;
    const dst = new Uint8Array(dw * dh);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const A = at(src, w, h, x - 1, y - 1);
        const B = at(src, w, h, x, y - 1);
        const C = at(src, w, h, x + 1, y - 1);
        const D = at(src, w, h, x - 1, y);
        const E = at(src, w, h, x, y);
        const F = at(src, w, h, x + 1, y);
        const G = at(src, w, h, x - 1, y + 1);
        const H = at(src, w, h, x, y + 1);
        const I = at(src, w, h, x + 1, y + 1);

        let E0 = E, E1 = E, E2 = E, E3 = E, E4 = E, E5 = E, E6 = E, E7 = E, E8 = E;

        if (B !== H && D !== F) {
          E0 = D === B ? D : E;
          E1 = (D === B && E !== C) || (B === F && E !== A) ? B : E;
          E2 = B === F ? F : E;
          E3 = (D === B && E !== G) || (D === H && E !== A) ? D : E;
          E4 = E;
          E5 = (B === F && E !== I) || (H === F && E !== C) ? F : E;
          E6 = D === H ? D : E;
          E7 = (D === H && E !== I) || (H === F && E !== G) ? H : E;
          E8 = H === F ? F : E;
        }

        const ox = x * 3;
        const oy = y * 3;
        dst[oy * dw + ox] = E0;
        dst[oy * dw + ox + 1] = E1;
        dst[oy * dw + ox + 2] = E2;
        dst[(oy + 1) * dw + ox] = E3;
        dst[(oy + 1) * dw + ox + 1] = E4;
        dst[(oy + 1) * dw + ox + 2] = E5;
        dst[(oy + 2) * dw + ox] = E6;
        dst[(oy + 2) * dw + ox + 1] = E7;
        dst[(oy + 2) * dw + ox + 2] = E8;
      }
    }

    return { data: dst, width: dw, height: dh };
  }

  // Upscale a flat, single-channel mask by an integer factor.
  //   1 -> no-op (returns the source unchanged, no copy)
  //   2 -> scale2x
  //   3 -> scale3x
  //   4 -> scale2x applied twice (2x -> 2x), which composes cleanly since
  //        4 = 2*2; there is no separate "Scale4x" rule in this family.
  function upscaleMask(mask, width, height, factor) {
    if (!factor || factor <= 1) {
      return { data: mask, width, height };
    }
    if (factor === 2) return scale2x(mask, width, height);
    if (factor === 3) return scale3x(mask, width, height);
    if (factor === 4) {
      const once = scale2x(mask, width, height);
      return scale2x(once.data, once.width, once.height);
    }
    throw new Error('Unsupported upscale factor: ' + factor + ' (supported: 1, 2, 3, 4)');
  }

  global.Upscale = { upscaleMask, scale2x, scale3x };
})(typeof window !== 'undefined' ? window : globalThis);
