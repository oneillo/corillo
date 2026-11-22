// The diagram drawing engine (mermaid), built as its own file and loaded only
// when a document has a diagram, so other documents open fast.
import mermaid, { type MermaidConfig } from "mermaid";

// A page can ask for settings of its own: export always uses the light look,
// and plain text labels for pictures (a browser won't make a picture of HTML labels).
const overrides = (window as unknown as { corilloDiagramOptions?: MermaidConfig }).corilloDiagramOptions ?? {};

// On screen, diagrams take Corillo's own colours (from style.css), light or
// dark: blue-grey boxes on the page, soft lines, coral for a second kind of box.
// They're read again when the Mac switches between light and dark.
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
const isDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const onScreen = (): MermaidConfig => ({
  theme: "base",
  themeVariables: {
    darkMode: isDark(),
    background: token("page"),
    primaryColor: token("accent-tint"),
    primaryBorderColor: token("accent"),
    primaryTextColor: token("ink"),
    secondaryColor: token("coral-tint"),
    secondaryBorderColor: token("coral-line"),
    secondaryTextColor: token("ink"),
    tertiaryColor: token("panel"),
    tertiaryBorderColor: token("chrome-line"),
    tertiaryTextColor: token("ink"),
    lineColor: token("ink-soft"),
    textColor: token("ink"),
    edgeLabelBackground: token("page"),
    // Flat boxes with solid borders: no shadow (only things that float cast
    // one), and no gradient from one border colour to the other.
    dropShadow: "none",
    useGradient: false,
  },
});

/** Set the engine up, in the colours of the appearance the Mac has now. */
function setUp(): boolean {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    ...(overrides.theme ? {} : onScreen()),
    // Mermaid's default layout library (ELK) is left out for its licence; this
    // is mermaid's other built-in layout.
    layout: "dagre",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
    // A mistake is said in Corillo's own words beside the diagram's code; the
    // engine's own error drawing would otherwise be left in the window.
    suppressErrorRendering: true,
    ...overrides,
  });
  return isDark();
}

let setUpDark = setUp();

let count = 0;

/**
 * Draw in a box of Corillo's own, laid out (so the engine can measure the
 * words) but out of sight and out of the window's flow, and taken away once
 * the drawing is done, whether it worked or not.
 */
async function render(code: string): Promise<string> {
  const box = document.createElement("div");
  box.className = "diagram-workspace";
  box.setAttribute("aria-hidden", "true");
  document.body.append(box);
  // A page with a look of its own (export) keeps it; the window follows the Mac.
  if (!overrides.theme && isDark() !== setUpDark) setUpDark = setUp();
  try {
    const { svg } = await mermaid.render(`corillo-diagram-${++count}`, code, box);
    return svg;
  } finally {
    box.remove();
  }
}

(window as unknown as { corilloDiagrams: { render: typeof render } }).corilloDiagrams = { render };
