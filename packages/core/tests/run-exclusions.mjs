import fs from "fs";
import os from "os";
import path from "path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "basis-exclusions-"));
process.env.HOME = tmpHome;

const {
  loadExclusions,
  updateExclusions,
  mergeWithDefaults,
  getExclusionsPath,
} = await import("../dist/index.js");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const first = loadExclusions();
assert(first.bundle_ids.length >= 6, "Expected default exclusions.");

const disabledDefault = first.bundle_ids.find((row) => row.bundle_id === "com.apple.keychainaccess");
assert(disabledDefault, "Expected Keychain Access default.");

const toggled = updateExclusions({
  bundle_ids: first.bundle_ids.map((row) =>
    row.bundle_id === "com.apple.keychainaccess" ? { ...row, enabled: false } : row
  ),
});
assert(toggled.requires_restart === true, "Expected restart flag after mutation.");

const merged = mergeWithDefaults({
  requires_restart: false,
  bundle_ids: toggled.bundle_ids.filter((row) => row.bundle_id !== "com.apple.systempreferences"),
});
const restoredDefault = merged.bundle_ids.find((row) => row.bundle_id === "com.apple.systempreferences");
const preservedDisabled = merged.bundle_ids.find((row) => row.bundle_id === "com.apple.keychainaccess");
assert(restoredDefault?.enabled === true, "Missing defaults should be restored enabled.");
assert(preservedDisabled?.enabled === false, "Disabled default should remain disabled.");

assert(fs.existsSync(getExclusionsPath()), "Expected exclusions file to exist.");
console.log("exclusions test passed");
