// Two of Orlando's calls on the window's look (roadmap Batch 22, item 5; review of Batch 21, E21-15 and E21-16):
// the messages a missing or waiting picture, a diagram that can't be drawn and a damaged version show are on the
// one type scale (13 pixels on 18-pixel lines), and the small main button (Post, Reply, Save, Send to Claude)
// looks pressed while pressed, as the big one does.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openText, selectText } from "./helpers";
import { tidyRuns } from "./tidy";

const tidy = tidyRuns();

const TEXT = "# Volunteer help desk\n\nRequests reach us through four inboxes and two group chats.\n";

/** A colour token as the window draws it, in light or dark as the page stands. */
function token(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const probe = document.createElement("div");
    probe.style.color = `var(--${n})`;
    document.body.append(probe);
    const drawn = getComputedStyle(probe).color;
    probe.remove();
    return drawn;
  }, name);
}

/** A button's colours as drawn now. */
function pressedLook(button: Locator): Promise<{ background: string; edge: string; words: string }> {
  return button.evaluate((b) => {
    const s = getComputedStyle(b);
    return { background: s.backgroundColor, edge: s.borderTopColor, words: s.color };
  });
}

test("a missing or waiting picture's box, a diagram's error and a damaged version's words are 13 pixels on 18-pixel lines", async () => {
  const { page } = tidy.keep(await openText(TEXT, { name: "Help desk.md" }));
  // Each message built as Corillo builds it (images.ts, diagrams.ts, history.ts), in the place it shows; the states
  // themselves are reached by pictures-diagrams, copied-picture and the versions tests. This pins their look.
  const drawn = await page.evaluate(() => {
    const page = document.createElement("div");
    page.className = "ProseMirror";
    page.innerHTML = `
      <span class="picture missing"><span class="picture-missing-text">Picture not found: chart.png</span><button>Find it…</button></span>
      <span class="picture waiting"><span class="picture-waiting-text">Picture from the web, not shown: example.org/chart.png</span><button>Show picture</button></span>
      <p class="diagram-error">This diagram can't be drawn.</p>`;
    const history = document.createElement("div");
    history.innerHTML = `<p class="version-missing">This version can't be shown: part of the history was damaged.</p>`;
    document.body.append(page, history);
    const found: Record<string, string> = {};
    for (const what of [".picture.missing .picture-missing-text", ".picture.waiting .picture-waiting-text", ".diagram-error", ".version-missing"]) {
      const style = getComputedStyle(document.querySelector(what)!);
      found[what] = `${style.fontSize}/${style.lineHeight} ${style.fontFamily.split(",")[0]}`;
    }
    page.remove();
    history.remove();
    return found;
  });
  expect(drawn).toEqual({
    ".picture.missing .picture-missing-text": "13px/18px -apple-system",
    ".picture.waiting .picture-waiting-text": "13px/18px -apple-system",
    ".diagram-error": "13px/18px -apple-system",
    ".version-missing": "13px/18px -apple-system",
  });
});

test("the small main button looks pressed while pressed, as the big one does, in light and dark", async () => {
  const { page } = tidy.keep(await openText(TEXT, { name: "Help desk.md" }));
  await selectText(page, "four inboxes");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("Which inboxes?");
  const post = page.getByRole("button", { name: "Post" });
  await expect(post).toHaveClass(/primary-small/);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const box = (await post.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Pressed with the pointer on it (it showed only its hover look), and still pressed once the pointer slips off
    // (it turned light grey under white words).
    const looks = [await pressedLook(post)];
    await page.mouse.move(2, 2);
    looks.push(await pressedLook(post));
    // Let go off the button, so the press is never a click: nothing is posted.
    await page.mouse.up();
    const ink = await token(page, "accent-ink");
    const want = { background: ink, edge: ink, words: await token(page, "on-accent") };
    expect(looks, scheme).toEqual([want, want]);
  }
  await expect(page.locator(".doc:not([hidden]) .comment-card:not(.draft)")).toHaveCount(0);
});
