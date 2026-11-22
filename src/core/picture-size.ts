// How big a picture is in a Word document, and so on the page (Orlando,
// 2026-11-09): never bigger than its own size, and made smaller, keeping its
// shape, to fit the width of the page's text and half its height.
//
// Its own size is Pandoc's: a picture that says how many dots per inch it was
// made at is that many inches across; one that doesn't is a point (1/72 inch)
// per pixel. A Mac screenshot says 144, two pixels to each point of the
// screen, so it is half its pixel size (a Retina screenshot at 2x; Pandoc
// reads 143, a hair over half). Corillo's Lua filter for Word (wordFilter in
// src/main/export-prep.ts) follows the same rule, and the page shows each
// picture at the same share of the text's width (images.ts); a test checks
// that Word and this agree.

/** Points, 72 to the inch. */
export interface Size {
  width: number;
  height: number;
}

/** The text area of a US Letter page with 1 inch margins (Corillo's Word style), in points. */
export const LETTER_TEXT: Size = { width: 468, height: 648 };

/** A picture is never taller than this share of the text area's height. */
export const TALLEST = 0.5;

/** A picture's own size, in points, from its size in pixels and its dots per inch (if it says). */
export function ownSize(pixels: Size, dpi: { x: number; y: number } | null): Size {
  const x = dpi?.x && dpi.x > 0 ? dpi.x : 72;
  const y = dpi?.y && dpi.y > 0 ? dpi.y : 72;
  return { width: (pixels.width * 72) / x, height: (pixels.height * 72) / y };
}

/** The size a picture is shown at: its size, made smaller to fit the text area's width and part of its height. */
export function fitPicture(size: Size, area: Size = LETTER_TEXT): Size {
  if (!(size.width > 0 && size.height > 0)) return size;
  const scale = Math.min(1, area.width / size.width, (area.height * TALLEST) / size.height);
  return { width: size.width * scale, height: size.height * scale };
}

/**
 * The dots per inch a PNG or JPEG picture says it was made at, or null if it
 * doesn't say. Worked out as Pandoc does, rounding down (a Mac screenshot's
 * 5669 dots per metre is 143 to the inch), so the page and Word agree.
 */
export function pictureDpi(bytes: Uint8Array): { x: number; y: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    // A PNG's pHYs chunk (before its picture data): dots across and down, per metre if the unit is 1.
    for (let at = 8; at + 12 <= bytes.length; ) {
      const length = view.getUint32(at);
      const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
      if (type === "pHYs" && length >= 9 && at + 17 <= bytes.length) {
        if (bytes[at + 16] !== 1) return null;
        const x = Math.floor(view.getUint32(at + 8) * 0.0254);
        const y = Math.floor(view.getUint32(at + 12) * 0.0254);
        return x > 0 && y > 0 ? { x, y } : null;
      }
      if (type === "IDAT" || type === "IEND") return null;
      at += 12 + length;
    }
    return null;
  }
  // A JPEG's JFIF header: units (1 per inch, 2 per centimetre) and the dots across and down.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[3] === 0xe0) {
    const jfif = String.fromCharCode(...bytes.subarray(6, 11));
    if (jfif !== "JFIF\0") return null;
    const units = bytes[13];
    const x = view.getUint16(14);
    const y = view.getUint16(16);
    if (!x || !y || (units !== 1 && units !== 2)) return null;
    return units === 1 ? { x, y } : { x: Math.floor(x * 2.54), y: Math.floor(y * 2.54) };
  }
  return null;
}
