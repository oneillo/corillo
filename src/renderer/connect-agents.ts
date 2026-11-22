// The "Connect your agents" screen: the agent tools found on this Mac, each
// with one button to connect it to Corillo (or disconnect it again).
//
// Connecting writes the tool's settings; the tool only sees Corillo once it
// starts again, and its agent reaches Corillo the first time it uses it. So a
// row just connected says "Ready" and what to do now (quit and reopen the
// app, or start a new session), offers a first request to try, and turns
// "Connected" the moment one of the tool's sessions reaches Corillo. If none
// has after a while, it says what else to try (roadmap Batch 5, item 2, P-5).
// What a row waits for goes when the screen closes: its timers with it.
import type { ToolStatus } from "../main/agent-tools";
import type { ConnectScreenState } from "../main/connect-agents";
import type { CorilloApi } from "../preload/preload";

interface Note {
  text: string;
  problem: boolean;
}

/** A tool connected from the screen while it's open: waiting for its first session, then connected. */
interface Fresh {
  connected: boolean;
  /** No session yet, a while after Connect: the row says what else to try. */
  late: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * What to do after Connect so the tool sees Corillo (`now`), and what else
 * to try if none of its sessions has come a while later (`still`). An app is
 * quit and opened again (closing its window leaves it running); a tool in
 * the terminal starts a new session.
 */
export function nextSteps(tool: Pick<ToolStatus, "id" | "name">): { now: string; still: string } {
  const app = (name: string) => ({
    now: `Now quit ${name} (Command-Q) and open it again.`,
    still: `Still waiting? Quit ${name} completely with Command-Q, not just its window. Then open it again and paste the request in a new chat.`,
  });
  const session = (name: string) => ({
    now: `Now start a new ${name} session.`,
    still: `Still waiting? A ${name} session started before you connected can't see Corillo. Start a new one and paste the request there.`,
  });
  switch (tool.id) {
    case "claude-desktop":
    case "cursor":
    case "vscode":
      return app(tool.name);
    case "codex":
      return {
        now: "Now quit Codex or the ChatGPT app (Command-Q) and open it again, or start a new Codex session.",
        still: "Still waiting? Quit Codex or the ChatGPT app completely with Command-Q, not just its window, or start a new Codex session. Then paste the request in a new chat.",
      };
    case "copilot-cli":
      return session("Copilot");
    default:
      return session(tool.name);
  }
}

/** `keyboardHome`: put the keyboard where it belongs in the window (the page, or the start screen's first stop). */
export function setUpConnectScreen(api: CorilloApi, keyboardHome: () => void = () => undefined): void {
  const dialog = el("dialog", "connect-agents");
  dialog.setAttribute("aria-labelledby", "connect-agents-title");
  const title = el("h2", "connect-title", "Connect your agents");
  title.id = "connect-agents-title";
  const intro = el(
    "p",
    "connect-intro",
    "Corillo works with the AI agents you already use. Connect one here, then ask it to open a document in Corillo.",
  );
  // Agents can't reach Corillo at all right now: connecting more won't help until that's put right.
  const problem = el("p", "connect-problem");
  problem.setAttribute("role", "alert");
  // Before anything is connected: Corillo must be somewhere it will stay.
  const moveFirst = el("p", "connect-move", "Move Corillo to your Applications folder first, and open it from there. Agents connected to it here wouldn't find it later.");
  moveFirst.setAttribute("role", "status");
  const list = el("ul", "agent-list");
  list.setAttribute("aria-label", "Agents on this Mac");
  const missing = el("p", "agent-missing");
  // No agent tool on this Mac: what's missing, then Claude Desktop named first with what to do, and the
  // rest under Other tools (roadmap Batch 25, item 2). Names and words only: nothing here connects anything.
  const none = el("div", "agent-none");
  const othersList = el("p", "agent-others");
  none.append(
    el("p", "agent-none-what", "To work with an AI agent, Corillo needs an agent tool: an app where you chat with the agent. There isn't one on this Mac yet."),
    el("h3", "agent-first-title", "Claude Desktop"),
    el("p", "agent-first-what", "The Claude app for Mac. Install it and sign in."),
    el("h3", "agent-others-title", "Other tools"),
    othersList,
    el(
      "p",
      "agent-none-then",
      "Once you've installed one, open Connect your agents again, on the start screen or with Help > Connect Agents…, to connect it. Using a different agent tool? Connect it by hand.",
    ),
  );
  // Corillo's connector runs on this Mac, so Claude in a web browser can't use it (person quick win 6).
  const browser = el("p", "connect-browser", "Use Claude in a web browser? Corillo works with the Claude app for Mac.");
  const actions = el("div", "connect-actions");
  const byHand = el("button", "", "Connect by hand…");
  byHand.type = "button";
  byHand.addEventListener("click", () => void api.help.open("manual"));
  const done = el("button", "primary", "Done");
  done.type = "button";
  // The main action once nothing is left to connect (render), and where the keyboard starts (roadmap Batch 11, F-20): focused once the
  // box is open (show), without scrolling the box's title out of sight (review of Batch 11, B11R-5).
  done.addEventListener("click", () => dialog.close());
  actions.append(byHand, el("span", "connect-spacer"), done);
  dialog.append(title, intro, problem, moveFirst, list, none, missing, browser, actions);
  document.body.append(dialog);

  // What to tell the person under a tool, after they press its button.
  const notes = new Map<string, Note>();
  const fresh = new Map<string, Fresh>();
  /** Rows whose request to try was copied: their button says so. */
  const copied = new Set<string>();
  let busy = false;
  let state: ConnectScreenState = { tools: [], moveFirst: false, problem: null, live: [], tryIt: "", stillMs: 120_000 };
  let live = new Set<string>();

  function forget(id: string): void {
    const f = fresh.get(id);
    if (f?.timer) clearTimeout(f.timer);
    fresh.delete(id);
    copied.delete(id);
  }

  /** Connected just now: wait for the tool's first session, and say what else to try if it doesn't come. */
  function waitFor(id: string): void {
    forget(id);
    const f: Fresh = { connected: live.has(id), late: false, timer: null };
    if (!f.connected) {
      f.timer = setTimeout(() => {
        f.timer = null;
        f.late = true;
        render();
      }, state.stillMs);
    }
    fresh.set(id, f);
  }

  async function change(tool: ToolStatus, action: "connect" | "disconnect"): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const { result, tools } = await (action === "connect" ? api.agents.connect(tool.id) : api.agents.disconnect(tool.id));
      notes.delete(tool.id);
      forget(tool.id);
      if (!result.ok) notes.set(tool.id, { text: result.message, problem: true });
      else if (action === "connect" && dialog.open) waitFor(tool.id);
      state = { ...state, tools };
      render();
    } finally {
      busy = false;
    }
  }

  function button(label: string, aria: string, kind: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", kind, label);
    b.type = "button";
    b.setAttribute("aria-label", aria);
    b.addEventListener("click", onClick);
    return b;
  }

  function note(text: string, kind = ""): HTMLParagraphElement {
    const p = el("p", kind ? `agent-note ${kind}` : "agent-note", text);
    p.setAttribute("role", "status");
    return p;
  }

  /** The request to try, quoted, with a button to copy it. */
  function tryIt(tool: ToolStatus, connected: boolean): HTMLParagraphElement {
    const p = el("p", "agent-note agent-try");
    p.append(`${connected ? "Try it" : "Then try it"}: paste this in a new chat. “${state.tryIt}” `);
    const copy = button(copied.has(tool.id) ? "Copied" : "Copy", "Copy the request to try", "agent-try-copy", () => {
      void api.agents.copyTryIt().then(() => {
        copied.add(tool.id);
        copy.textContent = "Copied";
      });
    });
    p.append(copy);
    return p;
  }

  function row(tool: ToolStatus): HTMLLIElement {
    const li = el("li", "agent-row");
    li.dataset.tool = tool.id;
    const name = el("div", "agent-name");
    name.append(el("span", "agent-title", tool.name));
    if (tool.detail) name.append(el("span", "agent-detail", tool.detail));
    const state_ = el("div", "agent-state");
    if (tool.state === "connected") {
      // Connected only while one of its sessions is: before that, its settings are just set up.
      // "Ready", a state, where "Set up" read like a button to press (roadmap Batch 24, row 20: N-8).
      const mark = live.has(tool.id) ? el("span", "agent-connected", "Connected") : el("span", "agent-set-up", "Ready");
      state_.append(mark, button("Disconnect", `Disconnect ${tool.name}`, "agent-button", () => void change(tool, "disconnect")));
    } else if (tool.state === "outdated") {
      state_.append(el("span", "agent-outdated", "Needs updating"));
      if (!state.moveFirst) state_.append(button("Update", `Update ${tool.name}`, "agent-button primary", () => void change(tool, "connect")));
    } else if (tool.state === "unreadable") {
      state_.append(el("span", "agent-outdated", "Can't read its settings"));
    } else if (!state.moveFirst) {
      state_.append(button("Connect", `Connect ${tool.name}`, "agent-button primary", () => void change(tool, "connect")));
    }
    li.append(name, state_);
    const told =
      notes.get(tool.id) ??
      (tool.state === "unreadable"
        ? { text: `Corillo couldn't read ${tool.name}'s settings, so it left them as they were. You can connect it by hand.`, problem: true }
        : undefined);
    if (told) li.append(note(told.text, told.problem ? "problem" : ""));
    const f = tool.state === "connected" || tool.state === "outdated" ? fresh.get(tool.id) : undefined;
    if (f) {
      const steps = nextSteps(tool);
      if (f.connected) li.append(note(`${tool.name} is connected.`, "connected"));
      else {
        li.append(note(steps.now));
        if (f.late) li.append(note(steps.still, "still"));
      }
      li.append(tryIt(tool, f.connected));
    }
    return li;
  }

  function render(): void {
    const { tools } = state;
    moveFirst.hidden = !state.moveFirst;
    problem.textContent = state.problem ?? "";
    problem.hidden = !state.problem;
    // A tool that's connected counts as found, even if its app has since moved.
    const found = tools.filter((t) => t.installed || t.state === "connected" || t.state === "outdated");
    const others = tools.filter((t) => !found.includes(t));
    list.replaceChildren(...found.map(row));
    list.hidden = found.length === 0;
    // The main button is what's left to do: Connect (or Update) while a tool is left, then Done (roadmap Batch 24, row 20: N-8).
    // One main button: with several tools left, only the first one's is filled (review of Batch 24, R24-3).
    for (const later of [...list.querySelectorAll(".agent-button.primary")].slice(1)) later.classList.remove("primary");
    done.classList.toggle("primary", !list.querySelector(".agent-button.primary"));
    // None found: Claude Desktop first, the others under Other tools (roadmap Batch 25, item 2; Batch 24 put no one tool first).
    none.hidden = found.length > 0;
    othersList.textContent = `${tools.filter((t) => t.id !== "claude-desktop").map((t) => t.name).join(", ")}.`;
    if (!found.length) {
      missing.textContent = "";
    } else if (others.length) {
      missing.textContent = `Not found on this Mac: ${others.map((t) => t.name).join(", ")}.`;
    } else missing.textContent = "";
    missing.hidden = !missing.textContent;
  }

  /**
   * One of the tools' sessions reached Corillo, or one ended. A row waiting
   * for its tool's first session turns Connected, and stays so; the others
   * say Connected while a session is there.
   */
  api.agents.onLive((tools) => {
    live = new Set(tools);
    if (!dialog.open) return;
    for (const [id, f] of fresh) {
      if (f.connected || !live.has(id)) continue;
      f.connected = true;
      if (f.timer) clearTimeout(f.timer);
      f.timer = null;
    }
    render();
  });

  /**
   * With no document open, the box sits under the start screen's name and
   * its line on what Corillo is, so a first launch isn't an empty grey window
   * (P-5); over a document, it's in the middle as before. Where it fits there,
   * nothing on the start screen moves (roadmap Batch 11, F-27); in a window too
   * short for that, the name rises to the top first, so the whole box shows
   * (review of Batch 11, B11R-5). Placed when it opens and when the window is
   * resized, never as it changes while open, so it doesn't jump under the pointer.
   */
  function placeOverStart(): void {
    const overStart = !document.body.classList.contains("has-docs");
    dialog.classList.toggle("over-start", overStart);
    document.body.classList.toggle("connect-over-start", overStart);
    document.body.classList.remove("connect-rise");
    if (!overStart) return;
    const below = () => {
      const line = document.querySelector(".start-what");
      return line ? Math.round(line.getBoundingClientRect().bottom + 24) : 160;
    };
    dialog.style.setProperty("--below-start", `${below()}px`);
    // The box's whole height, scrolled part and edges included.
    const whole = dialog.scrollHeight + dialog.offsetHeight - dialog.clientHeight;
    if (below() + whole + 16 <= window.innerHeight) return;
    document.body.classList.add("connect-rise");
    dialog.style.setProperty("--below-start", `${below()}px`);
  }
  window.addEventListener("resize", () => {
    if (dialog.open) placeOverStart();
  });

  /** Where the keyboard was when the screen opened, to go back to on Done. */
  let keyboardWas: HTMLElement | null = null;

  async function show(): Promise<void> {
    const opening = !dialog.open;
    if (opening) {
      notes.clear();
      for (const id of [...fresh.keys()]) forget(id);
    }
    state = await api.agents.list();
    live = new Set(state.live);
    render();
    if (dialog.open) return;
    const at = document.activeElement;
    keyboardWas = at instanceof HTMLElement && at !== document.body ? at : null;
    dialog.showModal();
    placeOverStart(); // open, so its height can be measured; nothing is drawn in between
    done.focus({ preventScroll: true });
    dialog.scrollTop = 0;
  }

  // Closed: nothing waits on, and the start screen is as ever.
  dialog.addEventListener("close", () => {
    for (const id of [...fresh.keys()]) forget(id);
    notes.clear();
    dialog.classList.remove("over-start");
    document.body.classList.remove("connect-over-start", "connect-rise");
    // Back where it was (the link that opened it, say); with nothing there before, as at first launch, where it
    // belongs, not nowhere (last look of Batch 12, L-5).
    const at = document.activeElement;
    const was = keyboardWas;
    keyboardWas = null;
    if (at && at !== document.body && !dialog.contains(at)) return;
    if (was?.isConnected && was.checkVisibility()) was.focus({ preventScroll: true });
    else keyboardHome();
  });

  api.agents.onShowConnect(() => void show());
  document.getElementById("connect-agents-link")?.addEventListener("click", () => void show());
}
