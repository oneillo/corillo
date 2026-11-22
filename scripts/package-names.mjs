// Corillo's app ID and the names of its ready-made downloads, in one place,
// so the packaging script, the README and the tests always agree.

/**
 * Corillo's app ID: its own, so it never shares settings with another app.
 * Made from where it is published (2026-11-17), so no one's full name is in
 * every user's settings. Its data folder is named for the app (productName),
 * not for this ID.
 */
export const APP_ID = "io.github.oneillo.corillo";

/** The kinds of Mac a download is made for: Apple silicon and Intel. */
export const ARCHES = ["arm64", "x64"];

/** The disk image for one kind of Mac: "Corillo-0.1.0-arm64.dmg". */
export function dmgName(version, arch) {
  if (!ARCHES.includes(arch)) throw new Error(`Unknown kind of Mac: ${arch} (use ${ARCHES.join(" or ")})`);
  return `Corillo-${version}-${arch}.dmg`;
}
