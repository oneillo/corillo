// What an agent waiting for the person's review is told when the wait ends without one, for both ends: Corillo and its connector (G21-15).

/** How each such ending finishes: the agent stops for good. */
export const DONT_CALL_AGAIN = "don't call wait_for_review again unless they ask.";
/** Corillo is closing (Corillo says it). */
export const WAIT_QUIT = `Corillo is closing, so you've stopped listening for the person's review. Say so once in the chat; ${DONT_CALL_AGAIN}`;
/** Corillo was closed during a wait (the connector says it, once Corillo is gone). Once, never called again. */
export const WAIT_GONE = `Corillo was closed, so you've stopped listening for the person's review. Say so once in the chat; ${DONT_CALL_AGAIN}`;
