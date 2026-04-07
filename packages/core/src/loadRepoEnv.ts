import * as path from "path";

/**
 * Load repo-root `.env` when running from compiled `packages/core/dist/`.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("dotenv").config({
  path: path.join(__dirname, "../../../.env"),
});
