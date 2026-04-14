import type { ContextScope } from "./types";

/** Default scopes for the local MCP client when no grant exists in `mcp-grants.json` yet. */
export const DEFAULT_LOCAL_SCOPES: ContextScope[] = ["context:metadata", "context:ocr"];
