// The sentences that end an agent's wait without a review, said by Corillo or
// by its connector, from one file both import (G21-15): word for word as before.
import { describe, expect, it } from "vitest";
import { DONT_CALL_AGAIN, WAIT_GONE, WAIT_QUIT } from "../../src/core/waiting-words";

describe("the words that end a wait", () => {
  it("are kept as they were", () => {
    expect(DONT_CALL_AGAIN).toBe("don't call wait_for_review again unless they ask.");
    expect(WAIT_QUIT).toBe("Corillo is closing, so you've stopped listening for the person's review. Say so once in the chat; don't call wait_for_review again unless they ask.");
    expect(WAIT_GONE).toBe("Corillo was closed, so you've stopped listening for the person's review. Say so once in the chat; don't call wait_for_review again unless they ask.");
  });
});
