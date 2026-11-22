// The toolbar, Markdown shortcuts, links and footnotes.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { openText, expectFile, cursorAtEnd, cursorInCell, settle, chooseFromMenu, clickMenu, clipboardHoldsText, selectText, captureClipboardWrites, paste, EDITOR } from "./helpers";

const DOC = "# Plan\n\nFirst point here.\n\nSecond point here.\n";

test("the toolbar is always there, with the usual buttons", async () => {
  const run = await openText(DOC);
  for (const name of ["Undo", "Redo", "Bold", "Italic", "Strikethrough", "Link", "Bulleted list", "Numbered list", "Quote", "Code block", "Insert", "Table"]) {
    await expect(run.page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(run.page.getByRole("combobox", { name: "Paragraph style" })).toBeVisible();
  await expect(run.page.getByRole("button", { name: "Formatted" })).toHaveAttribute("aria-pressed", "true");
  await run.app.close();
});

test("the style menu shows and changes the paragraph style", async () => {
  const run = await openText(DOC);
  const style = run.page.getByRole("combobox", { name: "Paragraph style" });
  await cursorAtEnd(run.page, "Plan", "h1");
  await expect(style).toHaveValue("h1");
  await cursorAtEnd(run.page, "First point");
  await expect(style).toHaveValue("paragraph");
  await style.selectOption({ label: "Heading 2" });
  await expectFile(run, "# Plan\n\n## First point here.\n\nSecond point here.\n");
  await run.app.close();
});

test("Bold lights up in bold text, and the button makes text bold", async () => {
  const run = await openText(DOC);
  const bold = run.page.getByRole("button", { name: "Bold", exact: true });
  await cursorAtEnd(run.page, "Second point");
  await expect(bold).toHaveAttribute("aria-pressed", "false");
  await run.page.keyboard.press("Shift+Alt+ArrowLeft"); // select the last word and its full stop
  await run.page.keyboard.press("Shift+Alt+ArrowLeft");
  await settle(run.page);
  await bold.click();
  await expectFile(run, "# Plan\n\nFirst point here.\n\nSecond point **here.**\n");
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await run.app.close();
});

test("list buttons make, switch and remove lists", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "First point");
  await run.page.getByRole("button", { name: "Bulleted list" }).click();
  await expectFile(run, "# Plan\n\n- First point here.\n\nSecond point here.\n");
  await run.page.getByRole("button", { name: "Numbered list" }).click();
  await expectFile(run, "# Plan\n\n1. First point here.\n\nSecond point here.\n");
  await expect(run.page.getByRole("button", { name: "Numbered list" })).toHaveAttribute("aria-pressed", "true");
  await run.page.getByRole("button", { name: "Numbered list" }).click();
  await expectFile(run, DOC);
  await run.app.close();
});

test("lists of the same kind that come to touch are one list on the page straight away, in one Undo step that leaves the cursor where it was", async () => {
  const BETWEEN = "- one\n- two\n\nBetween.\n\n- three\n- four\n\nAnd.\n\n* five\n\n1. six\n\nThen.\n\n1. seven\n";
  const run = await openText(BETWEEN);
  const { page } = run;
  const lists = () =>
    page.locator(`${EDITOR} .ProseMirror > ul, ${EDITOR} .ProseMirror > ol`).evaluateAll((els) => els.map((e) => [...e.children].map((li) => li.textContent).join(",")));
  expect(await lists()).toEqual(["one,two", "three,four", "five", "six", "seven"]);
  // The paragraph between two bulleted lists made a bulleted item: the three are one list.
  await selectText(page, "Between.");
  await page.getByRole("button", { name: "Bulleted list" }).click();
  await expect.poll(lists).toEqual(["one,two,Between.,three,four", "five", "six", "seven"]);
  expect(await page.evaluate(() => getSelection()!.toString())).toBe("Between.");
  await expectFile(run, "- one\n- two\n- Between.\n- three\n- four\n\nAnd.\n\n* five\n\n1. six\n\nThen.\n\n1. seven\n");
  // One Undo takes back both.
  await page.keyboard.press("Meta+z");
  await expect.poll(lists).toEqual(["one,two", "three,four", "five", "six", "seven"]);
  await expectFile(run, BETWEEN);
  // A bulleted list with other bullets (*) stays apart, as in the file.
  await selectText(page, "And.");
  await page.getByRole("button", { name: "Bulleted list" }).click();
  await expect.poll(lists).toEqual(["one,two", "three,four,And.", "five", "six", "seven"]);
  // Numbered lists too.
  await selectText(page, "Then.");
  await page.getByRole("button", { name: "Numbered list" }).click();
  await expect.poll(lists).toEqual(["one,two", "three,four,And.", "five", "six,Then.,seven"]);
  await expectFile(run, "- one\n- two\n\nBetween.\n\n- three\n- four\n- And.\n\n* five\n\n1. six\n2. Then.\n3. seven\n");
  // The cursor is where it was: typing goes on in the same words.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type(" Now");
  await expectFile(run, "- one\n- two\n\nBetween.\n\n- three\n- four\n- And.\n\n* five\n\n1. six\n2. Then. Now\n3. seven\n");
  await run.app.close();
});

test("lists joined on the page are spaced out if either was", async () => {
  const run = await openText("- one\n\n- two\n\nBetween.\n\n- three\n- four\n");
  await selectText(run.page, "Between.");
  await run.page.getByRole("button", { name: "Bulleted list" }).click();
  await expectFile(run, "- one\n\n- two\n\n- Between.\n\n- three\n\n- four\n");
  await expect(run.page.locator(`${EDITOR} .ProseMirror > ul`)).toHaveCount(1);
  await run.app.close();
});

test("typing - or 1. at the start of a line starts a list, as in Word", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Second point");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.type("- one");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.type("two");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.type("1. first");
  await expectFile(run, "# Plan\n\nFirst point here.\n\nSecond point here.\n\n- one\n- two\n\n1. first\n");
  await run.app.close();
});

test("typing [ ] or [x] at the start of a bulleted item makes it a task, saved as one", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Second point");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.type("- [ ] Call Ana");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.type("Send notes");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.type("- [x] Book the room");
  await expectFile(run, "# Plan\n\nFirst point here.\n\nSecond point here.\n\n- [ ] Call Ana\n- [ ] Send notes\n- [x] Book the room\n");
  await expect(run.page.locator(`${EDITOR} li.task`)).toHaveCount(3);
  // In a numbered list it stays as typed (a numbered task shows as written, as in Word).
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.type("1. [ ] Ask Ben");
  await expect.poll(run.text).toContain("\n\n1. \\[ \\] Ask Ben\n");
  await expect(run.page.locator(`${EDITOR} li.task`)).toHaveCount(3);
  // Backspace straight after takes it back to the brackets, as after "- ".
  await cursorAtEnd(run.page, "Send notes");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.type("- [ ] ");
  await run.page.keyboard.press("Backspace");
  await run.page.keyboard.type("not a task");
  await expect.poll(run.text).toContain("- \\[ \\] not a task\n");
  // Brackets typed anywhere else stay as they are.
  await cursorAtEnd(run.page, "First point here.");
  await run.page.keyboard.type(" [ ] ok");
  await expect.poll(run.text).toContain("First point here. \\[ \\] ok\n");
  await run.app.close();
});

test("Tab outside a list or table keeps the cursor in the document, so what's typed next isn't lost", async () => {
  const run = await openText("# Plan\n\nFirst point here.\n\n```\ncode here\n```\n\n- one\n- two\n");
  const inDocument = () =>
    run.page.evaluate(() => !!document.activeElement?.closest(".doc:not([hidden]) .page.editor .ProseMirror"));
  for (const [text, selector] of [["First point", "p"], ["Plan", "h1"]] as const) {
    await cursorAtEnd(run.page, text, selector);
    await run.page.keyboard.press("Tab");
    await settle(run.page);
    expect(await inDocument()).toBe(true);
    await run.page.keyboard.press("Shift+Tab");
    await settle(run.page);
    expect(await inDocument()).toBe(true);
  }
  await cursorAtEnd(run.page, "First point");
  await run.page.keyboard.press("Tab");
  await run.page.keyboard.type(" Typed after Tab.");
  // In a list, Tab still indents the item.
  await cursorAtEnd(run.page, "two", "li");
  await run.page.keyboard.press("Tab");
  await expectFile(run, "# Plan\n\nFirst point here. Typed after Tab.\n\n```\ncode here\n```\n\n- one\n  - two\n");
  await run.app.close();
});

test("in a code block, Tab indents and Shift-Tab outdents, a line or every selected line", async () => {
  const CODE = "Intro.\n\n```\nif ready:\nstart()\nstop()\n```\n";
  const run = await openText(CODE);
  const atStartOf = async (text: string) => {
    await selectText(run.page, text);
    await run.page.keyboard.press("ArrowLeft");
    await settle(run.page);
  };
  // At the start of a line, Tab puts in a tab; the cursor stays in the code.
  await atStartOf("start()");
  await run.page.keyboard.press("Tab");
  await run.page.keyboard.type("go");
  await expectFile(run, CODE.replace("start()", "\tgostart()"));
  await run.page.keyboard.press("Meta+z");
  await run.page.keyboard.press("Meta+z");
  await expectFile(run, CODE);
  // With two lines selected, Tab indents both and Shift-Tab takes it back off.
  await selectText(run.page, "start()\nstop()");
  await run.page.keyboard.press("Tab");
  await expectFile(run, CODE.replace("start()\nstop()", "\tstart()\n\tstop()"));
  await run.page.keyboard.press("Shift+Tab");
  await expectFile(run, CODE);
  // Four spaces count as one step out too, and a line with none is left alone.
  await atStartOf("start()");
  await run.page.keyboard.type("    ");
  await run.page.keyboard.press("Shift+Tab");
  await run.page.keyboard.press("Shift+Tab");
  await expectFile(run, CODE);
  await run.app.close();
});

test("quote and code block buttons", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "First point");
  await run.page.getByRole("button", { name: "Quote" }).click();
  await cursorAtEnd(run.page, "Second point");
  await run.page.getByRole("button", { name: "Code block" }).click();
  await expectFile(run, "# Plan\n\n> First point here.\n\n```\nSecond point here.\n```\n");
  await run.app.close();
});

test("Cmd+K links the selected words, and typing a bare address works", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "First point");
  await run.page.keyboard.press("Shift+Alt+ArrowLeft");
  await run.page.keyboard.press("Shift+Alt+ArrowLeft");
  await settle(run.page);
  await run.page.keyboard.press("Meta+k");
  await expect(run.page.locator(".link-editor")).toBeVisible();
  await run.page.keyboard.type("example.com/plan");
  await run.page.keyboard.press("Enter");
  await expectFile(run, "# Plan\n\nFirst point [here.](https://example.com/plan)\n\nSecond point here.\n");
  await expect(run.page.locator(".link-editor")).toBeHidden();
  // With the cursor in the link, Cmd+K edits it; Remove link takes it off.
  await cursorAtEnd(run.page, "First point");
  await run.page.keyboard.press("ArrowLeft");
  await settle(run.page);
  await run.page.keyboard.press("Meta+k");
  await expect(run.page.locator('.link-editor input[name="href"]')).toHaveValue("https://example.com/plan");
  await run.page.getByRole("button", { name: "Remove link" }).click();
  await expectFile(run, DOC);
  await run.app.close();
});

test("the style menu always names what the cursor is in, never an empty box", async () => {
  const run = await openText("##### Small print\n\nText.\n\n```\nlet a = 1;\n```\n\n```mermaid\ngraph LR\n  Ask --> Draft\n```\n");
  const style = run.page.getByRole("combobox", { name: "Paragraph style" });
  const shown = style.locator("option:checked");
  // A heading smaller than the menu lists.
  await run.page.locator(`${EDITOR} h5`).click();
  await settle(run.page);
  await expect(shown).toHaveText("Heading 5");
  await expect(style).toBeEnabled();
  // A code block.
  await run.page.locator(`${EDITOR} pre`, { hasText: "let a = 1;" }).click();
  await settle(run.page);
  await expect(shown).toHaveText("Code block");
  // A diagram's code.
  await expect(run.page.locator(".ProseMirror .diagram-picture svg")).toBeVisible({ timeout: 15000 });
  await run.page.locator(".ProseMirror .diagram").hover();
  await run.page.getByRole("button", { name: "Edit diagram code" }).click();
  await settle(run.page);
  await expect(shown).toHaveText("Diagram");
  // Nothing to style (the Markdown view): the greyed-out menu still says what it's for.
  await run.page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(style).toBeDisabled();
  await expect(shown).toHaveText("Style");
  await run.app.close();
});

test("buttons that don't apply are greyed out inside a table cell", async () => {
  const run = await openText("| a | b |\n|---|---|\n| 1 | 2 |\n");
  await cursorInCell(run.page, "1");
  await expect(run.page.getByRole("combobox", { name: "Paragraph style" })).toBeDisabled();
  await expect(run.page.getByRole("button", { name: "Bulleted list" })).toBeDisabled();
  await expect(run.page.getByRole("button", { name: "Bold", exact: true })).toBeEnabled();
  await expect(run.page.getByRole("button", { name: "Table", exact: true })).toBeEnabled();
  await run.app.close();
});

test("undo and redo buttons", async () => {
  const run = await openText(DOC);
  await expect(run.page.getByRole("button", { name: "Undo" })).toBeDisabled();
  await cursorAtEnd(run.page, "Second point");
  await run.page.keyboard.type(" More.");
  await expectFile(run, DOC.replace("Second point here.", "Second point here. More."));
  await run.page.getByRole("button", { name: "Undo" }).click();
  await expectFile(run, DOC);
  await run.page.getByRole("button", { name: "Redo" }).click();
  await expectFile(run, DOC.replace("Second point here.", "Second point here. More."));
  await run.app.close();
});

test("Undo in a comment box or the find field, pressed once too often, never takes back the document's typing, in either view (W-1)", async () => {
  const run = await openText(DOC);
  const { page } = run;
  const source = page.locator(".doc:not([hidden]) textarea.source");
  let typed = DOC;
  for (const view of ["Formatted", "Markdown"] as const) {
    // The person types in the document, and it's saved.
    if (view === "Markdown") {
      await page.getByRole("button", { name: "Markdown" }).click();
      await source.evaluate((a: HTMLTextAreaElement) => {
        const at = a.value.indexOf("Second point here.") + "Second point here.".length;
        a.focus();
        a.setSelectionRange(at, at);
      });
    } else await cursorAtEnd(page, "Second point here.");
    const words = view === "Markdown" ? " Ours." : " Mine.";
    await page.keyboard.type(words);
    typed = typed.replace("Second point here.", `Second point here.${words}`);
    await expectFile(run, typed);
    await settle(page);
    // Then two letters in a box beside it, taken back with one Undo too many (each letter a step, as a test types).
    for (const box of ["comment", "find"] as const) {
      const field = box === "find" ? page.locator('.find-bar input[name="find"]') : page.getByRole("textbox", { name: "New comment" });
      if (box === "find") await page.keyboard.press("Meta+f");
      else await page.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(field).toBeFocused();
      await page.keyboard.type("ab");
      for (let i = 0; i < 3; i++) await page.keyboard.press("Meta+z");
      await expect(field).toHaveValue("");
      expect(view === "Markdown" ? await source.inputValue() : await page.locator(EDITOR).innerText(), `${view}, ${box}`).toContain(words.trim());
      await expect(field).toBeFocused();
      await page.keyboard.press("Escape");
      if (view === "Markdown") await source.focus();
      else await cursorAtEnd(page, `Second point here. Mine.`);
    }
  }
  await page.waitForTimeout(1200); // longer than a save takes to start
  expect(run.text()).toBe(typed);
  // The other way round: Undo in the Markdown text leaves an open comment box's typing alone (it takes back the text's own, below).
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const box = page.getByRole("textbox", { name: "New comment" });
  await page.keyboard.type("ab");
  await source.focus();
  await page.keyboard.press("Meta+z");
  await settle(page);
  await expect(box).toHaveValue("ab");
  await expect(source).toBeFocused();
  await page.getByRole("button", { name: "Cancel" }).click();
  await run.app.close();
});

test("in the Markdown view, Undo and Redo in the text act on the text while a comment box with typing is open, and the box's own Undo still reaches its typing (W-1, roadmap Batch 10)", async () => {
  const run = await openText(DOC);
  const { page } = run;
  const source = page.locator(".doc:not([hidden]) textarea.source");
  await page.getByRole("button", { name: "Markdown" }).click();
  const typeAtEnd = async (of: string, words: string) => {
    await source.evaluate((a: HTMLTextAreaElement, at) => {
      a.focus();
      a.setSelectionRange(a.value.indexOf(at) + at.length, a.value.indexOf(at) + at.length);
    }, of);
    await page.keyboard.type(words);
  };
  await typeAtEnd("Second point here.", " Ours.");
  await expectFile(run, DOC.replace("Second point here.", "Second point here. Ours."));
  // A comment box with typing in it, left open.
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const box = page.getByRole("textbox", { name: "New comment" });
  await page.keyboard.type("ab");
  // Back in the text, Undo takes back the text's typing, and only that; the file follows.
  await source.focus();
  await page.keyboard.press("Meta+z");
  await expect(source).toHaveValue(DOC);
  await expect(box).toHaveValue("ab");
  await expect(source).toBeFocused();
  await expectFile(run, DOC);
  // Redo puts it back; once more does nothing.
  await page.keyboard.press("Meta+Shift+z");
  await page.keyboard.press("Meta+Shift+z");
  await expect(source).toHaveValue(DOC.replace("Second point here.", "Second point here. Ours."));
  await expect(box).toHaveValue("ab");
  await expectFile(run, DOC.replace("Second point here.", "Second point here. Ours."));
  // Edit > Undo (the Mac's own, sent to the page, where the box's typing is on top) takes back the text's too.
  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.undo());
  await expect(source).toHaveValue(DOC);
  await expect(box).toHaveValue("ab");
  await page.keyboard.press("Meta+Shift+z");
  await expect(source).toHaveValue(DOC.replace("Second point here.", "Second point here. Ours."));
  // More typing in the text, after the box's: Undo in the box still takes back the box's typing, and leaves the text's.
  await typeAtEnd("First point here.", " More.");
  const both = DOC.replace("Second point here.", "Second point here. Ours.").replace("First point here.", "First point here. More.");
  await expect(source).toHaveValue(both);
  await box.focus();
  await page.keyboard.press("Meta+z");
  await expect(box).toHaveValue("");
  await expect(box).toBeFocused();
  await page.keyboard.press("Meta+z");
  await settle(page);
  await expect(source).toHaveValue(both);
  // And the text's own Undo still goes back through its typing, one run at a time, as far as it goes.
  await source.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Meta+z");
  await expect(source).toHaveValue(DOC);
  await expectFile(run, DOC);
  await page.getByRole("button", { name: "Cancel" }).click();
  await run.app.close();
});

test("in the Markdown view, Paste and Match Style is an Undo step of its own: the typing before it and after it each stay when it's undone (B10-3)", async () => {
  const run = await openText(DOC);
  const { app, page } = run;
  const source = page.locator(".doc:not([hidden]) textarea.source");
  await page.getByRole("button", { name: "Markdown" }).click();
  await source.evaluate((a: HTMLTextAreaElement) => {
    a.focus();
    const at = a.value.indexOf("Second point here.") + "Second point here.".length;
    a.setSelectionRange(at, at);
  });
  await page.keyboard.type(" Hello ");
  await clipboardHoldsText(app, "Pasted.");
  await page.keyboard.press("Meta+Shift+V");
  await expect(source).toHaveValue(DOC.replace("Second point here.", "Second point here. Hello Pasted."));
  await page.keyboard.type(" After.");
  await expectFile(run, DOC.replace("Second point here.", "Second point here. Hello Pasted. After."));
  // One Undo at a time: the typing after, the paste, the typing before.
  await page.keyboard.press("Meta+z");
  await expect(source).toHaveValue(DOC.replace("Second point here.", "Second point here. Hello Pasted."));
  await page.keyboard.press("Meta+z");
  await expect(source).toHaveValue(DOC.replace("Second point here.", "Second point here. Hello "));
  await page.keyboard.press("Meta+z");
  await expect(source).toHaveValue(DOC);
  await expectFile(run, DOC);
  await run.app.close();
});

/** Edit > Undo or Edit > Redo chosen with the mouse, with this window in front (its page's file name): as the Mac's menu bar calls it. */
async function chooseUndo(app: ElectronApplication, id: "undo" | "redo", windowPage = "index.html"): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow, Menu }, [itemId, file]) => {
      const w = BrowserWindow.getAllWindows().find((b) => new URL(b.webContents.getURL()).pathname.endsWith(`/${file}`));
      if (!w) throw new Error(`No window showing ${file}`);
      Menu.getApplicationMenu()!.getMenuItemById(itemId)!.click({ triggeredByAccelerator: false }, w, w.webContents);
    },
    [id, windowPage] as const,
  );
}

test("Edit > Undo and Edit > Redo chosen with the mouse act where the keyboard is, as their keys do: the Markdown text, the Formatted page, a comment box, the find field, Help and About (W-1's menu Undo)", async () => {
  const run = await openText(DOC);
  const { app, page } = run;
  const source = page.locator(".doc:not([hidden]) textarea.source");
  const box = page.getByRole("textbox", { name: "New comment" });
  const ours = DOC.replace("Second point here.", "Second point here. Ours.");

  // The Markdown text: typed in, then a comment written and posted, then back in the text (the page's own list is empty there now).
  await page.getByRole("button", { name: "Markdown" }).click();
  await source.evaluate((a: HTMLTextAreaElement) => {
    a.focus();
    const at = a.value.indexOf("Second point here.") + "Second point here.".length;
    a.setSelectionRange(at, at);
  });
  await page.keyboard.type(" Ours.");
  await expectFile(run, ours);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.keyboard.type("A note.");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(".comment-card:not(.draft)")).toHaveCount(1);
  await source.focus();
  await chooseUndo(app, "undo");
  await expect(source).toHaveValue(DOC);
  await expect(source).toBeFocused();
  await expectFile(run, DOC);
  await chooseUndo(app, "redo");
  await expect(source).toHaveValue(ours);
  await expectFile(run, ours);

  // A comment box: its own typing, and only that, as its keys do.
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(box).toBeFocused();
  await page.keyboard.type("ab");
  await chooseUndo(app, "undo");
  await expect(box).not.toHaveValue("ab");
  for (let i = 0; i < 3; i++) await chooseUndo(app, "undo"); // the rest of its typing, then once too often: never the text's
  await expect(box).toHaveValue("");
  await settle(page);
  await expect(source).toHaveValue(ours);
  await page.getByRole("button", { name: "Cancel" }).click();

  // The Formatted page: Bold, which the page's own list never holds.
  await page.getByRole("button", { name: "Formatted" }).click();
  await selectText(page, "First");
  await page.keyboard.press("Meta+b");
  await expectFile(run, ours.replace("First", "**First**"));
  await chooseUndo(app, "undo");
  await expectFile(run, ours);
  await chooseUndo(app, "redo");
  await expectFile(run, ours.replace("First", "**First**"));

  // The find field (which starts with the words selected): its own typing, and the document stays as it is.
  await page.keyboard.press("Meta+f");
  const find = page.getByRole("textbox", { name: "Find", exact: true });
  await expect(find).toBeFocused();
  await expect(find).toHaveValue("First");
  await page.keyboard.type("point");
  await chooseUndo(app, "undo");
  await expect(find).not.toHaveValue("point");
  for (let i = 0; i < 6; i++) await chooseUndo(app, "undo"); // the rest of its typing, then once too often
  await expect(find).toHaveValue("First");
  await settle(page);
  await expectFile(run, ours.replace("First", "**First**"));
  await page.keyboard.press("Escape");

  // Help, in front: its search field's typing, never the document's.
  const [help] = await Promise.all([app.waitForEvent("window"), clickMenu(app, "corillo-help")]);
  await help.locator("#help-search").focus();
  await help.keyboard.type("tabs");
  await chooseUndo(app, "undo", "help.html");
  await expect(help.locator("#help-search")).not.toHaveValue("tabs");
  for (let i = 0; i < 5; i++) await chooseUndo(app, "undo", "help.html"); // the rest of its typing, then once too often
  await expect(help.locator("#help-search")).toHaveValue("");
  await settle(page);
  await expectFile(run, ours.replace("First", "**First**"));
  await help.close();

  // About, in front: nothing in it to undo, and the document stays as it is.
  const [about] = await Promise.all([app.waitForEvent("window"), clickMenu(app, "about")]);
  await about.waitForLoadState();
  await chooseUndo(app, "undo", "about.html");
  await chooseUndo(app, "redo", "about.html");
  await settle(page);
  await expectFile(run, ours.replace("First", "**First**"));
  await run.app.close();
});

test("Insert, Footnote adds a numbered note and puts the cursor in it", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "First point");
  await chooseFromMenu(run.page, "Insert", "Footnote");
  await run.page.keyboard.type("Source: the survey.");
  await expect(run.page.locator(".ProseMirror sup.footnote-ref")).toHaveAttribute("data-number", "1");
  await expectFile(run, "# Plan\n\nFirst point here.[^1]\n\nSecond point here.\n\n[^1]: Source: the survey.\n");
  // A second note before the first is numbered 1, and the first becomes 2.
  await cursorAtEnd(run.page, "Plan", "h1");
  await chooseFromMenu(run.page, "Insert", "Footnote");
  await run.page.keyboard.type("Draft.");
  await expect(run.page.locator(".ProseMirror sup.footnote-ref").first()).toHaveAttribute("data-number", "1");
  await expect(run.page.locator(".ProseMirror sup.footnote-ref").nth(1)).toHaveAttribute("data-number", "2");
  await expectFile(
    run,
    "# Plan[^2]\n\nFirst point here.[^1]\n\nSecond point here.\n\n[^1]: Source: the survey.\n\n[^2]: Draft.\n",
  );
  await run.app.close();
});

test("deleting a footnote's number takes its note away too, as in Word; Undo brings both back, and a number cut and pasted keeps its note", async () => {
  const NOTED = "First point here.[^1]\n\nSecond point here.\n\n[^1]: Source: the survey.\n";
  const run = await openText(NOTED);
  const written = await captureClipboardWrites(run.app);
  await cursorAtEnd(run.page, "First point");
  await run.page.keyboard.press("Backspace");
  await expectFile(run, "First point here.\n\nSecond point here.\n");
  await run.page.keyboard.press("Meta+z");
  await expectFile(run, NOTED);
  // Cut (the whole line, number and all), the note stays (numbered "?") until the number is pasted again.
  // The paragraph cut empty stays, an empty line at the top of the file.
  await run.page.evaluate((editor) => {
    const line = [...document.querySelectorAll(`${editor} p`)].find((p) => p.textContent!.startsWith("First point"))!;
    const range = document.createRange();
    range.selectNodeContents(line);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  }, EDITOR);
  await settle(run.page);
  await run.page.evaluate(() =>
    document.querySelector(".doc:not([hidden]) .ProseMirror")!.dispatchEvent(new ClipboardEvent("cut", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })),
  );
  await expectFile(run, "\nSecond point here.\n\n[^1]: Source: the survey.\n");
  await expect(run.page.locator(`${EDITOR} .footnote-def`)).toHaveAttribute("data-number", "?");
  await cursorAtEnd(run.page, "Second point");
  await expect.poll(written).not.toBeNull();
  await paste(run.page, (await written())!);
  await expectFile(run, "\nSecond point here.First point here.[^1]\n\n[^1]: Source: the survey.\n");
  await expect(run.page.locator(`${EDITOR} .footnote-def`)).toHaveAttribute("data-number", "1");
  // In the Markdown view the text is as typed: a marker deleted there leaves its note.
  await run.page.getByRole("button", { name: "Markdown" }).click();
  await run.page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>(".doc:not([hidden]) textarea.source")!;
    const at = area.value.indexOf("[^1]");
    area.focus();
    area.setSelectionRange(at, at + 4);
  });
  await run.page.keyboard.press("Backspace");
  await expectFile(run, "\nSecond point here.First point here.\n\n[^1]: Source: the survey.\n");
  // Back in the Formatted view, the next key typed keeps the note.
  await run.page.getByRole("button", { name: "Formatted" }).click();
  await cursorAtEnd(run.page, "Second point");
  await run.page.keyboard.type("x");
  await expectFile(run, "\nSecond point here.First point here.x\n\n[^1]: Source: the survey.\n");
  await run.app.close();
});

test("a footnote's note stays when its number is only moved or rewritten: Code block, and Undo or Redo of a cut", async () => {
  const NOTED = "First point here.[^1]\n\nSecond point here.\n\n[^1]: Source: the survey.\n";
  const run = await openText(NOTED);
  const written = await captureClipboardWrites(run.app);
  // Code block writes the number as its Markdown text, and the note it points to stays.
  await cursorAtEnd(run.page, "First point");
  await run.page.getByRole("button", { name: "Code block" }).click();
  await expectFile(run, "```\nFirst point here.[^1]\n```\n\nSecond point here.\n\n[^1]: Source: the survey.\n");
  await run.page.keyboard.press("Meta+z");
  await expectFile(run, NOTED);
  // The number cut, pasted after the second point, then both undone: as it was.
  await cursorAtEnd(run.page, "First point");
  await run.page.keyboard.press("Shift+ArrowLeft");
  await settle(run.page);
  await run.page.evaluate(() =>
    document.querySelector(".doc:not([hidden]) .ProseMirror")!.dispatchEvent(new ClipboardEvent("cut", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })),
  );
  await expectFile(run, "First point here.\n\nSecond point here.\n\n[^1]: Source: the survey.\n");
  await cursorAtEnd(run.page, "Second point");
  await expect.poll(written).not.toBeNull();
  await paste(run.page, (await written())!);
  await expectFile(run, "First point here.\n\nSecond point here.[^1]\n\n[^1]: Source: the survey.\n");
  await run.page.keyboard.press("Meta+z");
  await expectFile(run, "First point here.\n\nSecond point here.\n\n[^1]: Source: the survey.\n");
  await run.page.keyboard.press("Meta+z");
  await expectFile(run, NOTED);
  // Cut, undone, redone: the note stays.
  await run.page.keyboard.press("Shift+Meta+z");
  await expectFile(run, "First point here.\n\nSecond point here.\n\n[^1]: Source: the survey.\n");
  await run.app.close();
});

test("clicking a footnote number goes to its note", async () => {
  const run = await openText("Claim.[^a]\n\n" + "Filler paragraph.\n\n".repeat(40) + "[^a]: The note.\n");
  await run.page.locator(".ProseMirror sup.footnote-ref").click();
  await expect(run.page.locator(".ProseMirror .footnote-def")).toBeInViewport();
  await run.app.close();
});

const WITH_DETAILS = "---\ntitle: Plan\ntags: [work]\n---\n\n# Plan\n\nFirst point here.\n";

test("a document opens with the cursor at its first text, past the details at the top", async () => {
  const run = await openText(WITH_DETAILS);
  await expect(run.page.getByRole("combobox", { name: "Paragraph style" })).toHaveValue("h1");
  await run.page.keyboard.type("My ");
  await expectFile(run, "---\ntitle: Plan\ntags: [work]\n---\n\n# My Plan\n\nFirst point here.\n");
  await run.app.close();
});

test("in the details at the top, the style menu names them and nothing can restyle or wrap them", async () => {
  const run = await openText(WITH_DETAILS);
  const style = run.page.getByRole("combobox", { name: "Paragraph style" });
  await run.page.locator('pre.raw-block[data-kind="front-matter"]').click();
  await settle(run.page);
  await expect(style).toBeDisabled();
  await expect(style.locator("option:checked")).toHaveText("Document details");
  for (const name of ["Bulleted list", "Numbered list", "Quote", "Code block"]) {
    await expect(run.page.getByRole("button", { name, exact: true }), name).toBeDisabled();
  }
  // The heading shortcut does nothing there either.
  await run.page.keyboard.press("Meta+Alt+1");
  await settle(run.page);
  await expect(run.page.locator('pre.raw-block[data-kind="front-matter"]')).toContainText("title: Plan");
  // Selecting from the details into the text and choosing a style leaves both alone.
  await run.page.keyboard.press("Meta+Shift+ArrowDown");
  await settle(run.page);
  await run.page.keyboard.press("Meta+Alt+2");
  await settle(run.page);
  await expect(run.page.locator('pre.raw-block[data-kind="front-matter"]')).toContainText("title: Plan");
  // Back in ordinary text, the menu works as usual.
  await cursorAtEnd(run.page, "First point");
  await expect(style).toBeEnabled();
  await expect(style).toHaveValue("paragraph");
  await style.selectOption({ label: "Heading 2" });
  await expectFile(run, "---\ntitle: Plan\ntags: [work]\n---\n\n# Plan\n\n## First point here.\n");
  await run.app.close();
});

test("paragraphs dragged onto the details at the top, or into a block shown as Markdown, aren't dropped there: the file stays as it was (W-Q1)", async () => {
  const doc = "---\ntitle: Plan\ntags: [a, b]\n---\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph.\n\n<div>\nA box.\n</div>\n";
  const run = await openText(doc);
  const { page } = run;
  await expect(page.locator(EDITOR)).toContainText("Fourth paragraph.");
  /** Select from the start of `from` to the end of `to`, drag it, and drop it at a spot in a block shown as Markdown (at its first letter, or at its very top). */
  const dragOnto = (target: { kind: string; at: "letter" | "top" }) =>
    page.evaluate(
      ([editor, target]) => {
        const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
        const textOf = (wanted: string) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent!.includes(wanted)) return node as Text;
          throw new Error(`"${wanted}" isn't in the document`);
        };
        const from = textOf("Second paragraph.");
        const to = textOf("Fourth paragraph.");
        root.focus();
        const range = document.createRange();
        range.setStart(from, 0);
        range.setEnd(to, to.data.length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        const first = document.createRange();
        first.setStart(from, 0);
        first.setEnd(from, 1);
        const r = first.getBoundingClientRect();
        const block = root.querySelector<HTMLElement>(`pre.raw-block[data-kind="${target.kind}"]`)!;
        const letter = document.createRange();
        letter.setStart(block.querySelector("code")!.firstChild!, 0);
        letter.setEnd(block.querySelector("code")!.firstChild!, 1);
        const t = target.at === "letter" ? letter.getBoundingClientRect() : block.getBoundingClientRect();
        const end = { clientX: t.left + 1, clientY: target.at === "letter" ? t.top + t.height / 2 : t.top + 1 };
        return new Promise<void>((resolve) =>
          setTimeout(() => {
            const data = new DataTransfer();
            root.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: data, clientX: r.left + 1, clientY: r.top + r.height / 2 }));
            root.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data, ...end }));
            root.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data, ...end }));
            root.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: data, ...end }));
            resolve();
          }, 50),
        );
      },
      [EDITOR, target] as const,
    );
  for (const target of [{ kind: "front-matter", at: "letter" }, { kind: "front-matter", at: "top" }, { kind: "html", at: "letter" }] as const) {
    await dragOnto(target);
    await settle(page);
    await expect.soft(page.locator('pre.raw-block[data-kind="front-matter"]'), JSON.stringify(target)).toHaveText("---\ntitle: Plan\ntags: [a, b]\n---");
    await expect.soft(page.locator('pre.raw-block[data-kind="html"]'), JSON.stringify(target)).toHaveText("<div>\nA box.\n</div>");
  }
  await page.waitForTimeout(1200); // longer than a save takes to start
  expect(run.text()).toBe(doc);
  await run.app.close();
});
