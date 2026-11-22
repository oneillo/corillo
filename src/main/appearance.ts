// View > Appearance: Match the Mac, Light or Dark (Orlando, 2026-11-11: "I want
// to be able to flip between the two regardless of what the system is set
// to"). Electron's nativeTheme carries the choice to every window, so the
// page, the panels, diagrams, the start screen, Help, About and Connect follow
// it as they follow the Mac; exports stay light whatever it is (export.css).
// The same for every document, remembered between launches in view.json.
import { BrowserWindow, nativeTheme, type MenuItemConstructorOptions } from "electron";
import { readView, writeView } from "./view-settings";

export type Appearance = "system" | "light" | "dark";

const CHOICES: { value: Appearance; label: string }[] = [
  { value: "system", label: "Match the Mac" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The window's own colour behind the page, light and dark, as main.ts and connect-agents.ts set it. */
const BACKGROUND = { light: "#EAEDEC", dark: "#1B2023" };

let chosen: Appearance | null = null;

function current(): Appearance {
  // Read lazily: the data folder is only known once main.ts has set it.
  if (chosen === null) {
    const saved = readView().appearance;
    chosen = saved === "light" || saved === "dark" ? saved : "system";
  }
  return chosen;
}

/** The saved choice, put in place before the first window opens, so it opens in the right colours. */
export function applyAppearance(): void {
  nativeTheme.themeSource = current();
  // When the colours change (this menu, or the Mac's own setting), the window's colour behind the page follows,
  // so a resize never shows a strip of the other one. Windows with a colour of their own keep it.
  nativeTheme.on("updated", () => {
    const now = nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light;
    const was = nativeTheme.shouldUseDarkColors ? BACKGROUND.light : BACKGROUND.dark;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && w.getBackgroundColor().toUpperCase() === was) w.setBackgroundColor(now);
    }
  });
}

function setAppearance(next: Appearance): void {
  chosen = next;
  writeView({ appearance: next });
  nativeTheme.themeSource = next;
}

export function appearanceMenu(): MenuItemConstructorOptions {
  return {
    id: "appearance",
    label: "Appearance",
    submenu: CHOICES.map(({ value, label }) => ({
      id: `appearance-${value}`,
      label,
      type: "radio" as const,
      checked: current() === value,
      click: () => setAppearance(value),
    })),
  };
}
