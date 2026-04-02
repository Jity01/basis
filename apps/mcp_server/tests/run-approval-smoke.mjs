import assert from "node:assert/strict";
import {
  formatApprovalPayload,
  listPendingApprovals,
  requestApproval,
  resolveApproval,
  updateApprovalSettings,
} from "../dist/approval.js";

updateApprovalSettings({
  autoApproveAllRequests: false,
  timeoutMs: 5_000,
});

const originalPayload = {
  kind: "chunk_context",
  chunkKey: "2026-04-01/16-35",
  date: "2026-04-01",
  time: "16:35",
  summaryText: "Original summary",
  metaText: '{\n  "source": "smoke-test"\n}',
  frames: [
    {
      name: "001.jpg",
      mimeType: "image/jpeg",
      data: Buffer.from("frame-one").toString("base64"),
    },
    {
      name: "002.jpg",
      mimeType: "image/jpeg",
      data: Buffer.from("frame-two").toString("base64"),
    },
  ],
};

const pendingPromise = requestApproval({
  query: "Share chunk 2026-04-01/16-35",
  title: "Share chunk 2026-04-01/16-35",
  payload: originalPayload,
});

const pending = listPendingApprovals();
assert.equal(pending.length, 1);
assert.equal(pending[0].kind, "chunk_context");
assert.match(formatApprovalPayload(pending[0].payload), /Original summary/);

const editedPayload = {
  ...originalPayload,
  summaryText: "Edited summary",
  frames: [originalPayload.frames[1]],
};

assert.equal(resolveApproval(pending[0].id, "approved", editedPayload), true);

const approved = await pendingPromise;
assert.equal(approved.status, "approved");
assert.equal(approved.approvedPayload?.kind, "chunk_context");
assert.equal(approved.approvedPayload?.summaryText, "Edited summary");
assert.equal(approved.approvedPayload?.frames.length, 1);
assert.equal(approved.approvedPayload?.frames[0]?.name, "002.jpg");

const rejectionPromise = requestApproval({
  query: "Share day 2026-04-01",
  title: "Share context day 2026-04-01",
  payload: {
    kind: "day_index",
    date: "2026-04-01",
    chunkCount: 2,
    chunkKeys: ["2026-04-01/09-30", "2026-04-01/16-35"],
    indexText: "[09:30]\nA\n\n[16:35]\nB\n",
  },
});

const pendingReject = listPendingApprovals();
assert.equal(pendingReject.length, 1);
assert.equal(resolveApproval(pendingReject[0].id, "rejected"), true);

const rejected = await rejectionPromise;
assert.equal(rejected.status, "rejected");
assert.equal(rejected.approvedPayload, undefined);

console.log("Approval smoke test passed.");
