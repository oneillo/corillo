// The About Corillo window: fills in the version, the build and the licence texts.
import type { CorilloAboutApi } from "../preload/about-preload";

declare global {
  interface Window {
    corilloAbout: CorilloAboutApi;
  }
}

const api = window.corilloAbout;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function fill(): Promise<void> {
  const info = await api.info();
  $("about-version").textContent = `Version ${info.version}`;
  if (info.build) {
    $("about-build").textContent = info.build;
    $("about-build").hidden = false;
  }
  $("licence-text").textContent = info.licence;
  $("notices-text").textContent = info.notices;
  $("package-count").textContent = `${info.packageCount} packages, each listed with its licence.`;
  $("chromium").hidden = !info.hasChromiumNotices;
  if (info.pandoc) {
    $("pandoc").hidden = false;
    $("pandoc-name").textContent = `Pandoc ${info.pandoc.version}`;
    $("pandoc-text").textContent = info.pandoc.licence;
  }
  document.body.dataset.ready = "true";
}

$("open-chromium").addEventListener("click", () => void api.openChromiumNotices());
$("pandoc-source").addEventListener("click", () => void api.openPandocSource());
void fill();
