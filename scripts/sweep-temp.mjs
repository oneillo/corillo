// The net for test runs killed outright. Each run keeps everything it makes
// in a folder of its own and removes it when it ends (tests/run-folder.ts),
// so nothing is normally left. A run killed before it could clean up leaves
// its folder, and the programs its tests started still running; this stops
// those and removes the folder once the run's process is gone, never a
// folder or program of a run still going (several agents test at once), nor
// the installed Corillo. It also clears loose
// corillo-… folders in the Mac's temporary folder older than half an hour
// (three hours for a trial's reports): from before run folders, when two
// days of runs once came to 285 GB, or from anything writing outside one;
// the work of a downloads or packaging run whose process is gone; and
// Playwright's compiled tests unused for a day.
// Every run sweeps as it starts; npm runs this before every build too.
import { sweep, swept } from "../tests/run-folder.ts";

const said = swept(sweep());
if (said) console.log(said);
