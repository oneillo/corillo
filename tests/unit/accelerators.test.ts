// Menu shortcuts, as the menus write them, matched against the keys pressed:
// the window acts on the menus' shortcuts itself while it has the keyboard.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { canonicalAccelerator, findShortcut, matchesAccelerator, parseAccelerator, type KeyPress } from "../../src/core/accelerators";

const press = (key: string, code: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  code,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ctrlKey: false,
  ...mods,
});

const matches = (accelerator: string, e: KeyPress) => matchesAccelerator(parseAccelerator(accelerator)!, e);

describe("menu shortcuts", () => {
  it("match the keys with exactly their modifiers", () => {
    expect(matches("CmdOrCtrl+B", press("b", "KeyB", { metaKey: true }))).toBe(true);
    expect(matches("CmdOrCtrl+B", press("b", "KeyB", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(matches("CmdOrCtrl+B", press("b", "KeyB", { ctrlKey: true }))).toBe(false); // Command on a Mac, not Control
    expect(matches("Ctrl+Cmd+M", press("m", "KeyM", { metaKey: true, ctrlKey: true }))).toBe(true);
    expect(matches("Ctrl+Cmd+M", press("m", "KeyM", { metaKey: true }))).toBe(false);
  });

  it("go by the key's place, so Option (which changes the letter typed) doesn't matter", () => {
    expect(matches("CmdOrCtrl+Alt+M", press("µ", "KeyM", { metaKey: true, altKey: true }))).toBe(true);
    expect(matches("CmdOrCtrl+Alt+1", press("¡", "Digit1", { metaKey: true, altKey: true }))).toBe(true);
  });

  it("know arrows, Return, Tab, Escape and the punctuation keys", () => {
    expect(matches("CmdOrCtrl+Alt+Down", press("ArrowDown", "ArrowDown", { metaKey: true, altKey: true }))).toBe(true);
    expect(matches("CmdOrCtrl+Alt+Enter", press("Enter", "Enter", { metaKey: true, altKey: true }))).toBe(true);
    expect(matches("Ctrl+Shift+Tab", press("Tab", "Tab", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matches("Escape", press("Escape", "Escape"))).toBe(true);
    expect(matches("CmdOrCtrl+/", press("/", "Slash", { metaKey: true }))).toBe(true);
    expect(matches("CmdOrCtrl+Shift+8", press("*", "Digit8", { metaKey: true, shiftKey: true }))).toBe(true);
  });

  it("take Plus with or without Shift, as keyboards differ", () => {
    expect(matches("CmdOrCtrl+Plus", press("+", "Equal", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(matches("CmdOrCtrl++", press("=", "Equal", { metaKey: true }))).toBe(true);
    expect(matches("CmdOrCtrl+=", press("=", "Equal", { metaKey: true }))).toBe(true);
  });

  it("aren't read from nonsense", () => {
    expect(parseAccelerator("")).toBeNull();
    expect(parseAccelerator("Hyper+K")).toBeNull();
    expect(parseAccelerator("CmdOrCtrl+Banana")).toBeNull();
  });

  it("have one spelling each, so two items can't quietly share keys", () => {
    expect(canonicalAccelerator("Alt+CmdOrCtrl+M")).toBe(canonicalAccelerator("CmdOrCtrl+Option+M"));
    expect(canonicalAccelerator("Ctrl+Cmd+T")).toBe(canonicalAccelerator("Cmd+Control+T"));
    expect(canonicalAccelerator("CmdOrCtrl+=")).not.toBe(canonicalAccelerator("CmdOrCtrl+Plus")); // Plus is Shift-=
    expect(canonicalAccelerator("CmdOrCtrl+Shift+=")).toBe(canonicalAccelerator("CmdOrCtrl+Plus"));
  });
});

// Other keyboards ---------------------------------------------------------------------
// What each key types on its own and with Shift, by its place (KeyboardEvent.code),
// for the keys the menus use. A Mac gives the layout's own character with Command held.
type Layout = Record<string, [string, string]>;
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const us: Layout = {
  ...Object.fromEntries([...LETTERS].map((c) => [`Key${c.toUpperCase()}`, [c, c.toUpperCase()]])),
  ...Object.fromEntries([..."0123456789"].map((d, i) => [`Digit${d}`, [d, ")!@#$%^&*("[i]]])),
  Minus: ["-", "_"], Equal: ["=", "+"], Slash: ["/", "?"], Semicolon: [";", ":"], Comma: [",", "<"], Period: [".", ">"],
};
const swap = (base: Layout, pairs: Record<string, string>): Layout => {
  const out = { ...base };
  for (const [code, c] of Object.entries(pairs)) out[code] = [c, c.toUpperCase()];
  return out;
};
const LAYOUTS: Record<string, Layout> = {
  "French AZERTY": {
    ...swap(us, { KeyQ: "a", KeyA: "q", KeyW: "z", KeyZ: "w", Semicolon: "m", KeyM: "," }),
    ...Object.fromEntries([..."0123456789"].map((d, i) => [`Digit${d}`, [["à", "&", "é", '"', "'", "(", "§", "è", "!", "ç"][i], d]])),
    Minus: [")", "°"], Equal: ["-", "_"], Slash: ["=", "+"], Period: [":", "/"],
  },
  "German QWERTZ": {
    ...swap(us, { KeyY: "z", KeyZ: "y" }),
    ...Object.fromEntries([..."0123456789"].map((d, i) => [`Digit${d}`, [d, '=!"§$%&/()'[i]]])),
    Minus: ["ß", "?"], Equal: ["´", "`"], Slash: ["-", "_"], BracketRight: ["+", "*"],
  },
  "Spanish ISO": {
    ...us,
    ...Object.fromEntries([..."0123456789"].map((d, i) => [`Digit${d}`, [d, '=!"·$%&/()'[i]]])),
    Minus: ["'", "?"], Equal: ["¡", "¿"], Slash: ["-", "_"], BracketRight: ["+", "*"],
  },
  Dvorak: {
    ...swap(us, Object.fromEntries([..."',.pyfgcrlaoeuidhtns;qjkxbmwvz"].map((c, i) => [["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP", "KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM", "Comma", "Period", "Slash"][i], c]))),
    Minus: ["[", "{"], Equal: ["]", "}"], BracketLeft: ["/", "?"], BracketRight: ["=", "+"], Quote: ["-", "_"],
  },
};

// Every shortcut the window handles: those with Command, Control or Option.
const SHORTCUTS = [
  "CmdOrCtrl+N", "CmdOrCtrl+O", "CmdOrCtrl+W", "CmdOrCtrl+Shift+W", "CmdOrCtrl+Alt+C", "CmdOrCtrl+/", "Ctrl+Cmd+M", "Ctrl+Cmd+C",
  "Ctrl+Cmd+H", "Ctrl+Cmd+O", "CmdOrCtrl+Alt+M", "CmdOrCtrl+K", "CmdOrCtrl+Alt+0", "CmdOrCtrl+Alt+1", "CmdOrCtrl+Alt+2", "CmdOrCtrl+Alt+3",
  "CmdOrCtrl+Alt+4", "CmdOrCtrl+B", "CmdOrCtrl+I", "CmdOrCtrl+Shift+X", "CmdOrCtrl+E", "CmdOrCtrl+Shift+8", "CmdOrCtrl+Shift+7",
  "CmdOrCtrl+Alt+Down", "CmdOrCtrl+Alt+Up", "CmdOrCtrl+Alt+R", "CmdOrCtrl+Alt+Enter", "CmdOrCtrl+Shift+D", "Ctrl+Cmd+T", "Ctrl+Cmd+R", "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+Shift+Cmd+Left", "Ctrl+Shift+Cmd+Right", "CmdOrCtrl+0",
  "CmdOrCtrl+=", "CmdOrCtrl+Plus", "CmdOrCtrl+-", "CmdOrCtrl+Shift+V", "CmdOrCtrl+F", "CmdOrCtrl+Alt+F", "CmdOrCtrl+G", "CmdOrCtrl+Shift+G",
];
const shortcuts = SHORTCUTS.map((accelerator) => ({ accelerator, keys: parseAccelerator(accelerator)! }));
const NAMED_KEYS: Record<string, string> = { Down: "ArrowDown", Up: "ArrowUp", Left: "ArrowLeft", Right: "ArrowRight", Enter: "Enter", Tab: "Tab" };

/** The press a person makes on this keyboard for a shortcut as its menu prints it. */
function pressFor(layout: Layout, accelerator: string): KeyPress {
  const parts = accelerator.split("+");
  const name = parts.pop()!;
  const mods = {
    metaKey: parts.some((p) => /cmd/i.test(p)),
    ctrlKey: parts.includes("Ctrl"),
    altKey: parts.includes("Alt"),
    shiftKey: parts.includes("Shift"),
  };
  if (NAMED_KEYS[name]) return { key: NAMED_KEYS[name], code: NAMED_KEYS[name], ...mods };
  const char = name === "Plus" ? "+" : name.toLowerCase();
  const plain = Object.keys(layout).find((code) => layout[code][0] === char);
  const shifted = Object.keys(layout).find((code) => layout[code][1] === char);
  const code = (plain ?? shifted)!;
  // Option changes the character typed; with Shift and a number the press types the key's shifted sign.
  if (mods.altKey) return { key: "∂", code, ...mods };
  if (mods.shiftKey) return { key: layout[code][1], code, ...mods };
  return { key: char, code, ...mods, shiftKey: !plain };
}

describe("menu shortcuts on other keyboards", () => {
  it("lists every shortcut the menus have", () => {
    const written = ["menus", "zoom", "editing", "outline"].flatMap((f) =>
      [...readFileSync(`src/main/${f}.ts`, "utf8").matchAll(/accelerator: (?:inMarkdown \? undefined : |inMarkdown \? )?"([^"]+)"/g)].map((m) => m[1]),
    );
    const handled = written.filter((a) => /cmd|ctrl|alt/i.test(a));
    expect(handled.length).toBeGreaterThan(25);
    for (const a of handled) expect(SHORTCUTS, a).toContain(a);
  });

  for (const [name, layout] of Object.entries({ "US": us, ...LAYOUTS })) {
    // What each key types on its own, as the window learns it from the Mac (navigator.keyboard).
    const own = (code: string) => layout[code]?.[0];
    it(`match the shortcut the menu prints, and no other, on a ${name} keyboard`, () => {
      for (const { accelerator } of shortcuts) {
        const press = pressFor(layout, accelerator);
        let expected = accelerator;
        // Where / is Shift-7, Shift-Command-7 types Command-/ and switches views, as in a Mac app's menus.
        if (accelerator === "CmdOrCtrl+Shift+7" && layout.Digit7[1] === "/") expected = "CmdOrCtrl+/";
        expect(findShortcut(shortcuts, press, own)?.accelerator, `${accelerator} as ${JSON.stringify(press)}`).toBe(expected);
      }
    });

    it(`take each Option shortcut from the key the menu prints and no other on a ${name} keyboard`, () => {
      for (const code of Object.keys(layout)) {
        for (const shiftKey of [false, true]) {
          const hit = findShortcut(shortcuts, press("∂", code, { metaKey: true, altKey: true, shiftKey }), own);
          if (hit) expect(pressFor(layout, hit.accelerator).code, `Option-Command with ${code} is ${hit.accelerator}`).toBe(code);
        }
      }
    });
  }

  it("go by the key's place on an American keyboard with Option while the keyboard's layout isn't known", () => {
    expect(findShortcut(shortcuts, press("µ", "KeyM", { metaKey: true, altKey: true }))?.accelerator).toBe("CmdOrCtrl+Alt+M");
    expect(findShortcut(shortcuts, press("µ", "KeyM", { metaKey: true, altKey: true }), () => undefined)?.accelerator).toBe("CmdOrCtrl+Alt+M");
    // A key that types a letter of another alphabet (Russian, Greek) goes by its place too.
    expect(findShortcut(shortcuts, press("µ", "KeyM", { metaKey: true, altKey: true }), () => "ь")?.accelerator).toBe("CmdOrCtrl+Alt+M");
  });

  it("leave Undo, Copy and Cut to the Mac on French and Dvorak keyboards", () => {
    const fr = LAYOUTS["French AZERTY"];
    const dv = LAYOUTS.Dvorak;
    for (const [layout, letter] of [[fr, "z"], [dv, "c"], [dv, "x"], [dv, "v"], [fr, "q"], [fr, "a"]] as const) {
      const code = Object.keys(layout).find((c) => layout[c][0] === letter)!;
      expect(findShortcut(shortcuts, press(letter, code, { metaKey: true })), letter).toBeUndefined();
    }
  });

  it("take zoom from the keys as the keyboard has them", () => {
    const fr = LAYOUTS["French AZERTY"];
    expect(findShortcut(shortcuts, press("à", "Digit0", { metaKey: true }))?.accelerator).toBe("CmdOrCtrl+0"); // French Command-à, the 0 key
    expect(findShortcut(shortcuts, press("-", "Equal", { metaKey: true }))?.accelerator).toBe("CmdOrCtrl+-");
    expect(fr.Equal[0]).toBe("-");
    expect(findShortcut(shortcuts, press("-", "Slash", { metaKey: true }))?.accelerator).toBe("CmdOrCtrl+-"); // German, Spanish
    expect(findShortcut(shortcuts, press("+", "BracketRight", { metaKey: true }))?.accelerator).toBe("CmdOrCtrl+Plus");
    expect(findShortcut(shortcuts, press("'", "Minus", { metaKey: true }))).toBeUndefined(); // Spanish ', where - is in America
    expect(findShortcut(shortcuts, press("7", "Digit7", { metaKey: true }))).toBeUndefined(); // Command-7 isn't Shift-Command-7
    expect(findShortcut(shortcuts, press("0", "Digit0", { metaKey: true, shiftKey: true }))?.accelerator).toBe("CmdOrCtrl+0"); // French Shift-à types 0
  });
});
