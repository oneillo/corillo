// The Help window: a sidebar of pages, a search box, and the settings to paste
// for each agent tool, with Corillo's real locations filled in. The address
// after # names a page ("agents") or a section on one ("agents-take-over"),
// so links in the help and buttons in the app can open the right place.
import type { ManualEntry } from "../main/agent-tools";
import type { CorilloHelpApi } from "../preload/help-preload";

declare global {
  interface Window {
    corilloHelp: CorilloHelpApi;
  }
}

const api = window.corilloHelp;
const pages = [...document.querySelectorAll<HTMLElement>(".help-page")];
const links = [...document.querySelectorAll<HTMLAnchorElement>(".help-pages a")];
const main = document.querySelector<HTMLElement>(".help-main")!;

/** Show the page holding this page or section name, scrolled to the section. */
function show(target: string): void {
  const el = target ? document.getElementById(target) : null;
  const page = el?.closest<HTMLElement>(".help-page") ?? pages[0];
  for (const p of pages) p.hidden = p !== page;
  for (const a of links) {
    if (a.dataset.page === page.id) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (el && el !== page) el.scrollIntoView({ block: "start" });
  else main.scrollTo(0, 0);
}

const targetFromHash = () => decodeURIComponent(location.hash.replace(/^#/, ""));

/** Go to a page or section, even if it's where the address already points. */
function go(target: string): void {
  if (targetFromHash() === target) show(target);
  else location.hash = target;
}

window.addEventListener("hashchange", () => show(targetFromHash()));
api.help.onPage(go);
document.addEventListener("click", (e) => {
  const link = (e.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
  if (!link) return;
  e.preventDefault();
  go(link.getAttribute("href")!.slice(1));
});
show(targetFromHash());

// Search -------------------------------------------------------------------------------
// Each section (a heading and what follows it, up to the next heading) is one
// result. A section matches when it holds every word typed.

interface Section {
  id: string;
  title: string;
  page: string;
  text: string;
}

const searchBox = document.getElementById("help-search") as HTMLInputElement;
const results = document.getElementById("help-results")!;
const pageList = document.getElementById("help-pages")!;

function sections(): Section[] {
  const found: Section[] = [];
  for (const page of pages) {
    const pageTitle = page.querySelector("h1")?.textContent ?? "";
    let current: Section = { id: page.id, title: pageTitle, page: pageTitle, text: "" };
    found.push(current);
    for (const child of page.children) {
      if (child.tagName === "H2" && child.id) {
        current = { id: child.id, title: child.textContent ?? "", page: pageTitle, text: "" };
        found.push(current);
      }
      current.text += ` ${child.textContent ?? ""}`;
    }
  }
  return found;
}

const words = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").split(/[^\p{L}\p{N}'+-]+/u).filter(Boolean);

function search(query: string): Section[] {
  const wanted = words(query);
  if (!wanted.length) return [];
  return sections().filter((s) => {
    const have = ` ${words(`${s.title} ${s.text}`).join(" ")} `;
    return wanted.every((w) => have.includes(` ${w}`));
  });
}

function renderResults(): void {
  const query = searchBox.value.trim();
  pageList.hidden = !!query;
  results.hidden = !query;
  if (!query) return;
  const found = search(query);
  if (!found.length) {
    const none = document.createElement("p");
    none.className = "help-no-results";
    none.textContent = "Nothing found. Try other words.";
    results.replaceChildren(none);
    return;
  }
  results.replaceChildren(
    ...found.map((s) => {
      const a = document.createElement("a");
      a.href = `#${s.id}`;
      a.className = "help-result";
      const title = document.createElement("span");
      title.className = "help-result-title";
      title.textContent = s.title;
      a.append(title);
      if (s.title !== s.page) {
        const where = document.createElement("span");
        where.className = "help-result-page";
        where.textContent = s.page;
        a.append(where);
      }
      return a;
    }),
  );
}

searchBox.addEventListener("input", renderResults);
// Help opens with the keyboard in Search help, so typing searches; Tab goes on to the topics, then the text. Command-F
// comes back to it from anywhere in Help (roadmap Batch 12, G-17).
// Asked again as the window loads and comes forward: until then a focus can be lost.
const searchFirst = () => {
  if (!document.activeElement || document.activeElement === document.body) searchBox.focus();
};
searchFirst();
window.addEventListener("load", searchFirst);
window.addEventListener("focus", searchFirst);
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "f" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  e.preventDefault();
  searchBox.focus();
  searchBox.select();
});
searchBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const first = results.querySelector<HTMLAnchorElement>("a.help-result");
    if (first) first.click();
  } else if (e.key === "Escape" && searchBox.value) {
    e.preventDefault();
    searchBox.value = "";
    renderResults();
  }
});

// Copying settings for connecting by hand ------------------------------------------------

function copied(button: HTMLButtonElement): void {
  const label = button.textContent;
  button.textContent = "Copied";
  button.classList.add("done");
  setTimeout(() => {
    button.textContent = label;
    button.classList.remove("done");
  }, 1600);
}

function copyButton(label: string, aria: string, id: string, what: "snippet" | "where"): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "snippet-copy";
  b.textContent = label;
  b.setAttribute("aria-label", aria);
  b.addEventListener("click", async () => {
    if (await api.agents.copy(id, what)) copied(b);
  });
  return b;
}

function toolSection(entry: ManualEntry): HTMLElement {
  const section = document.createElement("section");
  section.className = "manual-tool";
  section.dataset.tool = entry.id;
  const h = document.createElement("h2");
  h.id = `manual-${entry.id}`;
  h.textContent = entry.name;
  const where = document.createElement("p");
  where.className = "manual-where";
  const code = document.createElement("code");
  code.textContent = entry.where;
  where.append("Settings file: ", code, " ", copyButton("Copy location", `Copy where ${entry.name} keeps its settings`, entry.id, "where"));
  const snippet = document.createElement("div");
  snippet.className = "snippet";
  const pre = document.createElement("pre");
  pre.className = "snippet-text";
  pre.textContent = entry.snippet;
  snippet.append(pre, copyButton("Copy", `Copy the ${entry.name} settings`, entry.id, "snippet"));
  const after = document.createElement("p");
  after.className = "manual-after";
  after.textContent = [entry.byHand, entry.restart].filter(Boolean).join(" ");
  section.append(h, where, snippet, after);
  return section;
}

/** In place of settings that would break: Corillo is running from its disk image or another place it's only passing through. */
function moveFirst(): HTMLElement {
  const p = document.createElement("p");
  p.className = "manual-move";
  p.textContent = "Move Corillo to your Applications folder first, and open it from there. Settings copied from here now would point at this copy of Corillo, which won't be there later.";
  return p;
}

void api.agents.manual().then(({ tools, other, moveFirst: passingThrough }) => {
  const otherBox = document.getElementById("other-box");
  if (passingThrough) {
    document.getElementById("manual-tools")?.replaceChildren(moveFirst());
    otherBox?.replaceWith(moveFirst());
  } else {
    document.getElementById("manual-tools")?.replaceChildren(...tools.map(toolSection));
    const otherEl = document.getElementById("other-snippet");
    if (otherEl) otherEl.textContent = other;
  }
  // A link straight to one tool's section can only scroll there now that it exists.
  const target = targetFromHash();
  if (target.startsWith("manual-")) show(target);
});

const otherCopy = document.querySelector<HTMLButtonElement>('[data-copy="other"]');
otherCopy?.addEventListener("click", async () => {
  if (await api.agents.copy("other")) copied(otherCopy);
});

document.querySelector('[data-action="connect"]')?.addEventListener("click", () => void api.agents.showConnect());
