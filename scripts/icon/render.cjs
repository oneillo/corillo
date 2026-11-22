// Draws SVG files as PNG pictures at exact sizes, using Electron's own
// browser engine, so making the app icon needs no other drawing tool.
// Run with Electron: electron scripts/icon/render.cjs <jobs.json>
// where jobs.json is a list of { svg, out, size }.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const jobList = process.argv[process.argv.length - 1];
app.dock?.hide();
app.disableHardwareAcceleration();
// Chromium's own files go in the throwaway folder holding the job list, which
// is removed afterwards, not in ~/Library/Application Support/Electron.
app.setPath("userData", path.join(path.dirname(jobList), "electron-data"));

async function main() {
  const jobs = JSON.parse(fs.readFileSync(jobList, "utf8"));
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true } });
  await win.loadURL("data:text/html;charset=utf-8,<!doctype html><title>render</title>");
  for (const job of jobs) {
    // Give the drawing its final size, so it's drawn sharp at that size rather than scaled.
    const svg = fs
      .readFileSync(job.svg, "utf8")
      .replace(/<svg\b([^>]*)>/, (_m, attrs) => {
        const rest = attrs.replace(/\s(width|height)="[^"]*"/g, "");
        return `<svg${rest} width="${job.size}" height="${job.size}">`;
      });
    const src = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
    const png = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(src)};
      await img.decode();
      const c = document.createElement("canvas");
      c.width = c.height = ${job.size};
      c.getContext("2d").drawImage(img, 0, 0, ${job.size}, ${job.size});
      return c.toDataURL("image/png");
    })()`);
    fs.writeFileSync(job.out, Buffer.from(png.split(",")[1], "base64"));
  }
  win.destroy();
}

app
  .whenReady()
  .then(main)
  .then(
    () => app.exit(0),
    (err) => {
      console.error(err);
      app.exit(1);
    },
  );
