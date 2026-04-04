import * as path from "path";

/**
 * Load repo-root `.env` when running from compiled `packages/core/dist/`.
 * Skip when MCP is spawned by Electron so `dotenv` is never required in packaged bundles.
 */
if (process.env.ELECTRON_RUN_AS_NODE !== "1") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv").config({
    path: path.join(__dirname, "../../../.env"),
  });
}
