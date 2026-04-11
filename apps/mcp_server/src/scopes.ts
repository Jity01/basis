import type { ContextScope } from "@context-manager/config";

/**
 * Which scope each tool requires. If not listed, defaults to "context:metadata".
 */
const TOOL_SCOPES: Record<string, ContextScope> = {
  // metadata (low sensitivity)
  "list_days": "context:metadata",
  "get_day_index": "context:metadata",
  "get_sessions": "context:metadata",
  "get_day_catalog": "context:metadata",
  "search_by_topic": "context:metadata",
  "search_by_app": "context:metadata",
  "search_by_entity": "context:metadata",
  "get_context": "context:metadata",

  // ocr (medium — screen text may contain passwords, private messages)
  "get_live_context": "context:ocr",

  // frames (high — actual screenshots)
  "get_chunk_context": "context:frames",
  "get_live_frame": "context:frames",
  "get_latest_snapshots": "context:frames",
};

/** Scope hierarchy: frames implies ocr implies metadata. */
const SCOPE_LEVEL: Record<ContextScope, number> = {
  "context:metadata": 0,
  "context:ocr": 1,
  "context:frames": 2,
};

/** Get the required scope for a tool. Defaults to metadata. */
export function requiredScope(toolName: string): ContextScope {
  return TOOL_SCOPES[toolName] || "context:metadata";
}

/** Check if a set of granted scopes covers the required scope. */
export function scopeCovers(granted: string[], required: ContextScope): boolean {
  const requiredLevel = SCOPE_LEVEL[required];
  for (const scope of granted) {
    const level = SCOPE_LEVEL[scope as ContextScope];
    if (level !== undefined && level >= requiredLevel) {
      return true;
    }
  }
  return false;
}

/** All supported scopes, ordered from least to most sensitive. */
export const ALL_SCOPES: ContextScope[] = ["context:metadata", "context:ocr", "context:frames"];

/** Expand a scope to include all implied lower scopes. */
export function expandScope(scope: ContextScope): ContextScope[] {
  const level = SCOPE_LEVEL[scope];
  return ALL_SCOPES.filter((s) => SCOPE_LEVEL[s] <= level);
}
