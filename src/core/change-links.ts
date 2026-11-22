// Which text an agent changed for each comment. An agent says which comments
// an edit answers; Corillo works out what the edit changed in the document as
// it reads (not its Markdown signs) and keeps that with the comment, as spans
// anchored the way a comment is, so the person can see each comment's change
// and what the text said before. A comment keeps only its latest round: the
// pass that last changed text for it. Edits tied to no comment are the pass's
// "other changes", kept with its version in History. Plain logic, no app or
// window code.

// Done in the change-links-*.ts modules, which import one way only (see tests/unit/change-links-modules.test.ts).
export { forgetWords, plainText, reading, wordsKept } from "./change-links-readings";
export { changedPieces, sharedEnds } from "./change-links-changed";
export { OffsetMap, syncsFor } from "./change-links-follow";
export { remapSpans, type ChangeSpan } from "./change-links-place";
export { applyPlaced, placeEdits, type Placed } from "./text-changes";
export { carry } from "./change-links-carry";
export { OTHER, PassLinks, gapAfter, sameSpans, updateChanges, type ThreadChange } from "./change-links-pass";
