// The kinds of picture Corillo copies into a document's pictures folder, for the window and the app alike (G21-12).

/** Each kind by its usual name, with the ending Corillo gives a file of it. */
export const PICTURE_ENDINGS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

/** The kinds, by their usual names. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set(Object.keys(PICTURE_ENDINGS));

/** The endings a picture file of those kinds may have (a JPEG's two). */
export const IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"];

/** Other names some apps give the same kinds. */
export const SAME_KIND: Readonly<Record<string, string>> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "image/x-png": "image/png" };
