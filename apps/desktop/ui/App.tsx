import { useState, useEffect, useRef, useCallback } from "react";

const contextManager = window.contextManager;

type ProcessingStatus = {
  isProcessing: boolean;
  currentChunk: number;
  totalChunks: number;
  pendingChunks: number;
  trigger: "idle" | "manual" | null;
};

type RemoteAccessState = {
  enabled: boolean;
  status: "disabled" | "starting" | "connected" | "reconnecting" | "error";
  publicUrl: string | null;
  authToken: string | null;
  error: string | null;
};

type ApprovalRequest = {
  id: string;
  createdAt: string;
  query: string;
  resultPreview: string;
  fullResult: string;
};

type ApprovalSettings = {
  autoApproveAllRequests: boolean;
  timeoutMs: number;
};

type TabId = "controls" | "requests" | "settings";

const fallbackSettings: ApprovalSettings = {
  autoApproveAllRequests: false,
  timeoutMs: 120_000,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("controls");
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus>({
    isProcessing: false,
    currentChunk: 0,
    totalChunks: 0,
    pendingChunks: 0,
    trigger: null,
  });
  const [remoteAccessState, setRemoteAccessState] = useState<RemoteAccessState>({
    enabled: false,
    status: "disabled",
    publicUrl: null,
    authToken: null,
    error: null,
  });
  const [isTogglingRemoteAccess, setIsTogglingRemoteAccess] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [approvalSettings, setApprovalSettings] = useState<ApprovalSettings>(fallbackSettings);
  const [settingsTimeoutSeconds, setSettingsTimeoutSeconds] = useState(120);
  const [expandedRequestIds, setExpandedRequestIds] = useState<Record<string, boolean>>({});
  const [approvalNotice, setApprovalNotice] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rotationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRotatingRef = useRef(false);
  const stoppingRef = useRef(false);
  const pendingChunkSendsRef = useRef(new Set<Promise<void>>());
  const previousPendingCountRef = useRef(0);

  async function createScreenStream(): Promise<MediaStream> {
    const sources = await contextManager.getDesktopSources({ types: ["screen"] });
    if (sources.length === 0) {
      throw new Error("No screen source available");
    }

    const sourceId = sources[0].id;
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
        },
      } as unknown as MediaTrackConstraints,
    });
  }

  async function flushPendingChunkSends(): Promise<void> {
    if (pendingChunkSendsRef.current.size === 0) {
      return;
    }
    await Promise.allSettled(Array.from(pendingChunkSendsRef.current));
  }

  function wireRecorder(recorder: MediaRecorder) {
    recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      const sendPromise = e.data
        .arrayBuffer()
        .then((buf) => {
          contextManager.sendRecordingChunk(buf);
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Failed to read recorded chunk");
        })
        .finally(() => {
          pendingChunkSendsRef.current.delete(sendPromise);
        });
      pendingChunkSendsRef.current.add(sendPromise);
    };

    recorder.onerror = (event) => {
      const maybeError = (event as unknown as { error?: Error }).error;
      setError(maybeError?.message ?? "MediaRecorder error");
    };
  }

  const startRecorderForCurrentFile = useCallback(async () => {
    const stream = await createScreenStream();
    streamRef.current = stream;
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 2500000,
    });
    wireRecorder(recorder);
    recorder.start(1000);
    mediaRecorderRef.current = recorder;
  }, []);

  const startCapture = useCallback(async () => {
    try {
      setError(null);
      if (!contextManager) {
        throw new Error(
          "contextManager is not available. Run the app with Electron (pnpm dev), not in a browser."
        );
      }

      stoppingRef.current = false;
      isRotatingRef.current = false;

      await contextManager.startRecording();
      await startRecorderForCurrentFile();

      const rotateOnce = async (): Promise<void> => {
        if (isRotatingRef.current || stoppingRef.current) return;
        const current = mediaRecorderRef.current;
        if (!current || current.state !== "recording") return;

        isRotatingRef.current = true;
        current.onstop = async () => {
          try {
            if (stoppingRef.current) return;
            await flushPendingChunkSends();
            streamRef.current?.getTracks().forEach((t) => t.stop());
            streamRef.current = null;

            await contextManager.rotateRecording();
            await startRecorderForCurrentFile();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Failed rotating recorder");
            setIsRecording(false);
            stoppingRef.current = true;
          } finally {
            isRotatingRef.current = false;
          }
        };

        current.stop();
      };

      const chunkDurationMs = await contextManager.getChunkDurationMs();
      rotationTimerRef.current = setInterval(() => {
        void rotateOnce();
      }, chunkDurationMs);

      durationTimerRef.current = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);

      setIsRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start recording");
    }
  }, [startRecorderForCurrentFile]);

  const stopCapture = useCallback(async () => {
    stoppingRef.current = true;

    if (rotationTimerRef.current) {
      clearInterval(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    setDuration(0);

    const finalizeStop = async () => {
      await flushPendingChunkSends();
      await contextManager.stopRecording();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      mediaRecorderRef.current = null;
      isRotatingRef.current = false;
      stoppingRef.current = false;
      setIsRecording(false);
    };

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.onstop = async () => {
        try {
          await finalizeStop();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to stop recording");
        }
      };
      mediaRecorderRef.current.stop();
    } else {
      try {
        await finalizeStop();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to stop recording");
      }
    }
  }, []);

  const refreshProcessingStatus = useCallback(async () => {
    if (!contextManager) {
      return;
    }
    const status = await contextManager.getProcessingStatus();
    setProcessingStatus(status);
  }, []);

  const refreshApprovalState = useCallback(async () => {
    if (!contextManager) {
      return;
    }
    const state = await contextManager.getApprovalState();
    setPendingApprovals(state.pending);
    setApprovalSettings(state.settings || fallbackSettings);
  }, []);

  const processNow = useCallback(async () => {
    try {
      setError(null);
      const result = await contextManager.processNow();
      if (!result.started) {
        await refreshProcessingStatus();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to process backlog");
    }
  }, [refreshProcessingStatus]);

  const setRemoteAccessEnabled = useCallback(async (enabled: boolean) => {
    try {
      setError(null);
      setIsTogglingRemoteAccess(true);
      const nextState = await contextManager.setRemoteAccessEnabled(enabled);
      setRemoteAccessState(nextState);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed updating remote access");
    } finally {
      setIsTogglingRemoteAccess(false);
    }
  }, []);

  const copyToClipboard = useCallback(async (value: string | null) => {
    if (!value) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed copying to clipboard");
    }
  }, []);

  const resolveRequest = useCallback(async (requestId: string, resolution: "approved" | "rejected") => {
    try {
      setError(null);
      await contextManager.resolveApproval(requestId, resolution);
      setPendingApprovals((current) => current.filter((request) => request.id !== requestId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve request");
    }
  }, []);

  const approveAll = useCallback(async () => {
    try {
      setError(null);
      await contextManager.approveAllRequests();
      setPendingApprovals([]);
      setApprovalNotice("Approved all pending requests.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve all requests");
    }
  }, []);

  const saveSettings = useCallback(async () => {
    try {
      setError(null);
      const timeoutMs = Math.max(5, settingsTimeoutSeconds) * 1000;
      const updated = await contextManager.updateApprovalSettings({
        autoApproveAllRequests: approvalSettings.autoApproveAllRequests,
        timeoutMs,
      });
      setApprovalSettings(updated);
      setSettingsTimeoutSeconds(Math.max(5, Math.round(updated.timeoutMs / 1000)));
      setApprovalNotice("Approval settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save approval settings");
    }
  }, [approvalSettings.autoApproveAllRequests, settingsTimeoutSeconds]);

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const processingCurrent = Math.max(processingStatus.currentChunk, 1);
  const processingTotal = Math.max(processingStatus.totalChunks, processingCurrent);

  const statusLine = (() => {
    if (processingStatus.isProcessing) {
      return `Processing chunk ${processingCurrent}/${processingTotal}`;
    }
    if (isRecording) {
      return "Recording";
    }
    if (processingStatus.pendingChunks > 0) {
      return `Idle - ${processingStatus.pendingChunks} chunks pending`;
    }
    return "All caught up";
  })();

  const remoteStatusLine = (() => {
    switch (remoteAccessState.status) {
      case "connected":
        return "Connected";
      case "starting":
        return "Starting tunnel...";
      case "reconnecting":
        return "Reconnecting tunnel...";
      case "error":
        return "Tunnel error";
      default:
        return "Disabled";
    }
  })();
  const remoteMcpEndpoint = remoteAccessState.publicUrl ? `${remoteAccessState.publicUrl}/mcp` : null;

  useEffect(() => {
    if (!contextManager) {
      return;
    }

    void refreshProcessingStatus();
    void refreshApprovalState();
    void contextManager.getRemoteAccessState().then((state) => {
      setRemoteAccessState(state);
    });

    const unsubscribeProcessing = contextManager.onProcessingStatus((status) => {
      setProcessingStatus(status);
    });
    const unsubscribeApprovals = contextManager.onApprovalState((state) => {
      const previousCount = previousPendingCountRef.current;
      const nextCount = state.pending.length;
      previousPendingCountRef.current = nextCount;
      setPendingApprovals(state.pending);
      setApprovalSettings(state.settings || fallbackSettings);
      if (nextCount > previousCount) {
        setApprovalNotice(`New context request pending (${nextCount} total).`);
      }
    });
    const unsubscribeRemote = contextManager.onRemoteAccessState((state) => {
      setRemoteAccessState(state);
    });

    return () => {
      unsubscribeProcessing();
      unsubscribeApprovals();
      unsubscribeRemote();
      if (rotationTimerRef.current) clearInterval(rotationTimerRef.current);
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    };
  }, [refreshApprovalState, refreshProcessingStatus]);

  useEffect(() => {
    setSettingsTimeoutSeconds(Math.max(5, Math.round(approvalSettings.timeoutMs / 1000)));
  }, [approvalSettings.timeoutMs]);

  const pendingCount = pendingApprovals.length;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>Context Manager</h1>
      <p>Personal, local-first screen recording and tagging.</p>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button onClick={() => setActiveTab("controls")} disabled={activeTab === "controls"}>
          Controls
        </button>
        <button onClick={() => setActiveTab("requests")} disabled={activeTab === "requests"}>
          Requests{pendingCount > 0 ? ` (${pendingCount})` : ""}
        </button>
        <button onClick={() => setActiveTab("settings")} disabled={activeTab === "settings"}>
          Settings
        </button>
      </div>

      {error && <p style={{ color: "#c00", marginBottom: 16 }}>{error}</p>}
      {approvalNotice && <p style={{ color: "#056", marginBottom: 16 }}>{approvalNotice}</p>}

      {activeTab === "controls" && (
        <>
          <div style={{ marginTop: 24 }}>
            <button
              onClick={isRecording ? stopCapture : startCapture}
              style={{
                padding: "12px 24px",
                fontSize: 16,
                backgroundColor: isRecording ? "#c00" : "#07c",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              {isRecording ? "Stop Recording" : "Start Recording"}
            </button>
            <button
              onClick={processNow}
              disabled={processingStatus.pendingChunks === 0 || processingStatus.isProcessing}
              style={{
                marginLeft: 12,
                padding: "12px 24px",
                fontSize: 16,
                backgroundColor:
                  processingStatus.pendingChunks === 0 || processingStatus.isProcessing
                    ? "#999"
                    : "#0a7",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                cursor:
                  processingStatus.pendingChunks === 0 || processingStatus.isProcessing
                    ? "not-allowed"
                    : "pointer",
              }}
            >
              {processingStatus.isProcessing
                ? `Processing chunk ${processingCurrent}/${processingTotal}...`
                : "Process Now"}
            </button>

            {isRecording && (
              <span style={{ marginLeft: 16, fontSize: 18, fontWeight: 500 }}>
                {formatDuration(duration)}
              </span>
            )}
          </div>
          <p style={{ marginTop: 16, color: "#555" }}>{statusLine}</p>
        </>
      )}

      {activeTab === "requests" && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
            <strong>Pending Requests: {pendingCount}</strong>
            <button onClick={() => void refreshApprovalState()}>Refresh</button>
            <button onClick={() => void approveAll()} disabled={pendingCount === 0}>
              Approve All
            </button>
          </div>

          {pendingCount === 0 && <p style={{ color: "#555" }}>No pending requests.</p>}

          {pendingApprovals.map((request) => {
            const isExpanded = expandedRequestIds[request.id] === true;
            return (
              <div
                key={request.id}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 12,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{request.query}</div>
                    <div style={{ color: "#666", fontSize: 13 }}>
                      {new Date(request.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => void resolveRequest(request.id, "approved")}>Approve</button>
                    <button onClick={() => void resolveRequest(request.id, "rejected")}>Reject</button>
                  </div>
                </div>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    marginTop: 8,
                    background: "#f8f8f8",
                    padding: 8,
                    borderRadius: 6,
                    maxHeight: isExpanded ? 320 : 120,
                    overflow: "auto",
                  }}
                >
                  {isExpanded ? request.fullResult : request.resultPreview}
                </pre>
                <button
                  onClick={() =>
                    setExpandedRequestIds((current) => ({ ...current, [request.id]: !isExpanded }))
                  }
                >
                  {isExpanded ? "Collapse" : "Expand"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {activeTab === "settings" && (
        <div style={{ marginTop: 24, maxWidth: 480 }}>
          <h3 style={{ marginBottom: 12 }}>Remote Access</h3>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={remoteAccessState.enabled}
              disabled={isTogglingRemoteAccess}
              onChange={(event) => {
                void setRemoteAccessEnabled(event.target.checked);
              }}
            />
            Enable remote access
          </label>
          <p style={{ color: "#555", marginTop: 0, marginBottom: 8 }}>
            Status: {remoteStatusLine}
          </p>
          <p style={{ color: "#555", marginTop: 0, marginBottom: 8, fontSize: 13, lineHeight: 1.5 }}>
            Remote tool calls still respect the approval queue below. Keep the app open to approve
            requests, or enable auto-approve while testing.
          </p>
          {remoteAccessState.error && (
            <p style={{ color: "#a60", marginTop: 0, marginBottom: 8 }}>{remoteAccessState.error}</p>
          )}
          {remoteAccessState.enabled && (
            <div
              style={{
                border: "1px solid #ddd",
                borderRadius: 8,
                padding: 12,
                marginBottom: 20,
                background: "#fafafa",
              }}
            >
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: "#666" }}>Public Tunnel URL</div>
                <div style={{ wordBreak: "break-all", marginTop: 4 }}>
                  {remoteAccessState.publicUrl || "(waiting for tunnel URL...)"}
                </div>
                <button
                  style={{ marginTop: 6 }}
                  disabled={!remoteAccessState.publicUrl}
                  onClick={() => void copyToClipboard(remoteAccessState.publicUrl)}
                >
                  Copy URL
                </button>
              </div>
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: "#666" }}>Remote MCP Endpoint</div>
                <div style={{ wordBreak: "break-all", marginTop: 4 }}>
                  {remoteMcpEndpoint || "(waiting for MCP endpoint...)"}
                </div>
                <button
                  style={{ marginTop: 6 }}
                  disabled={!remoteMcpEndpoint}
                  onClick={() => void copyToClipboard(remoteMcpEndpoint)}
                >
                  Copy MCP Endpoint
                </button>
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#666" }}>Local-Only Debug Token</div>
                <div style={{ wordBreak: "break-all", marginTop: 4 }}>
                  {remoteAccessState.authToken || "(waiting for MCP auth token...)"}
                </div>
                <button
                  style={{ marginTop: 6 }}
                  disabled={!remoteAccessState.authToken}
                  onClick={() => void copyToClipboard(remoteAccessState.authToken)}
                >
                  Copy Token
                </button>
              </div>
              <p style={{ color: "#555", marginTop: 12, marginBottom: 0, fontSize: 13, lineHeight: 1.5 }}>
                Use the <code>/mcp</code> endpoint above for Claude or any remote MCP client. The
                server now advertises standard OAuth discovery, authorization, token, and dynamic
                client registration endpoints automatically. The debug token is only for localhost
                manual checks and is not part of the normal Claude setup.
              </p>
            </div>
          )}

          <h3 style={{ marginBottom: 12 }}>Approval Settings</h3>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <input
              type="checkbox"
              checked={approvalSettings.autoApproveAllRequests}
              onChange={(event) =>
                setApprovalSettings((current) => ({
                  ...current,
                  autoApproveAllRequests: event.target.checked,
                }))
              }
            />
            Auto-approve all requests
          </label>

          <label style={{ display: "block", marginBottom: 8 }}>Approval timeout (seconds)</label>
          <input
            type="number"
            min={5}
            value={settingsTimeoutSeconds}
            onChange={(event) => {
              const next = Number(event.target.value);
              setSettingsTimeoutSeconds(Number.isFinite(next) ? next : 120);
            }}
            style={{ marginBottom: 16, width: 160 }}
          />

          <div>
            <button onClick={() => void saveSettings()}>Save Settings</button>
          </div>
        </div>
      )}
    </div>
  );
}
