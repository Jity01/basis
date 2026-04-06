/**
 * Smoke-test: build a temp context tree and verify deterministic browse helpers.
 *
 * Usage (from repo root):
 *   pnpm --filter @context-manager/core build
 *   pnpm --filter @context-manager/core search-test
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getChunkContext, getDayIndex, listDays } from "../dist/index.js";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "context-manager-searcher-"));

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

try {
  await writeText(
    path.join(tmpRoot, "2026", "04", "01", "09-30", "summary.txt"),
    `Working on the remote MCP connector approval flow.
`
  );
  await writeText(
    path.join(tmpRoot, "2026", "04", "01", "16-35", "summary.txt"),
    `Refining search replacement tools for day listing and chunk context retrieval.
`
  );
  await writeJson(path.join(tmpRoot, "2026", "04", "01", "09-30", "meta.json"), {
    source: "manual-test",
    frames_stored: 2,
  });
  await writeJson(path.join(tmpRoot, "2026", "04", "01", "16-35", "meta.json"), {
    source: "manual-test",
    frames_stored: 2,
  });
  await writeText(
    path.join(tmpRoot, "2026", "04", "01", "16-35", "frames", "001.jpg"),
    "frame-one"
  );
  await writeText(
    path.join(tmpRoot, "2026", "04", "01", "16-35", "frames", "002.jpg"),
    "frame-two"
  );

  await writeText(
    path.join(tmpRoot, "2026", "03", "31", "11-00", "summary.txt"),
    `Reviewing Electron recording behavior and chunk rotation.
`
  );
  await writeJson(path.join(tmpRoot, "2026", "03", "31", "11-00", "meta.json"), {
    source: "manual-test",
    frames_stored: 0,
  });

  const days = await listDays(tmpRoot, 10);
  assert.equal(days.length, 2);
  assert.equal(days[0].date, "2026-04-01");
  assert.equal(days[0].chunkCount, 2);
  assert.equal(days[0].firstChunkTime, "09:30");
  assert.equal(days[0].lastChunkTime, "16:35");
  assert.equal(days[0].hasIndex, true);

  const dayIndex = await getDayIndex("2026-04-01", tmpRoot);
  assert.equal(dayIndex.date, "2026-04-01");
  assert.deepEqual(dayIndex.chunkKeys, ["2026-04-01/09-30", "2026-04-01/16-35"]);
  assert.match(dayIndex.indexText, /search replacement tools/);

  const chunk = await getChunkContext("2026-04-01/16-35", tmpRoot);
  assert.equal(chunk.chunkKey, "2026-04-01/16-35");
  assert.equal(chunk.time, "16:35");
  assert.match(chunk.summaryText, /chunk context retrieval/);
  assert.deepEqual(chunk.meta, { source: "manual-test", frames_stored: 2 });
  assert.equal(chunk.frames.length, 2);
  assert.equal(chunk.frames[0].name, "001.jpg");
  assert.equal(chunk.frames[0].mimeType, "image/jpeg");
  assert.equal(chunk.frames[0].data, Buffer.from("frame-one").toString("base64"));

  await assert.rejects(() => getDayIndex("2026/04/01", tmpRoot), /Expected YYYY-MM-DD/);
  await assert.rejects(
    () => getChunkContext("2026-04-01 16:35", tmpRoot),
    /Expected YYYY-MM-DD\/HH-MM/
  );

  console.log("Deterministic browse helper smoke test passed.");
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
