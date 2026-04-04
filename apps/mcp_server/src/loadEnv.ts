import * as path from "path";

/**
 * Load repo-root `.env` into `process.env` for CLI / dev runs.
 * When Electron spawns this process with `ELECTRON_RUN_AS_NODE=1`, skip loading so we
 * never `require("dotenv")` (packaged `mcp-server` may not ship that module).
 */
if (process.env.ELECTRON_RUN_AS_NODE !== "1") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional load path for non-Electron
  require("dotenv").config({
    path: path.join(__dirname, "../../../.env"),
  });
}
