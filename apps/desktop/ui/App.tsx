import { useState, useEffect, useRef, useCallback } from "react";
import type {
  ApprovalFrame,
  ApprovalPayload,
  ApprovalRequest,
  ApprovalSettings,
  ChunkContextApprovalPayload,
  DayIndexApprovalPayload,
  DayListApprovalPayload,
} from "../src/approvalTypes";

const contextManager = window.contextManager;
const INDEX_SECTION_PATTERN = /\[(\d{2}):(\d{2})\]\n([\s\S]*?)(?=\n\n\[\d{2}:\d{2}\]\n|$)/g;

type ProcessingStatus = {
  isProcessing: boolean;
  currentChunk: number;
  totalChunks: number;
  pendingChunks: number;
  visiblePendingChunks: number;
  activeRecordingChunk: boolean;
  trigger: "idle" | "manual" | "live" | null;
};

type RemoteAccessState = {
  enabled: boolean;
  status: "disabled" | "starting" | "connected" | "reconnecting" | "error";
  publicUrl: string | null;
  authToken: string | null;
  error: string | null;
};

type AISettings = {
  provider: "fireworks" | "local";
  localBaseUrl: string;
  localTaggingModel: string;
  localSearchModel: string;
};

type TabId = "controls" | "requests" | "settings";

const fallbackSettings: ApprovalSettings = {
  autoApproveAllRequests: false,
  timeoutMs: 120_000,
};

const fallbackAISettings: AISettings = {
  provider: "fireworks",
  localBaseUrl: "http://127.0.0.1:11434/v1",
  localTaggingModel: "llava:7b",
  localSearchModel: "qwen3:4b",
};

function formatFriendlyDate(dateText: string): string {
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return dateText;
  }
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatFriendlyTime(timeText: string): string {
  const [hourText = "00", minuteText = "00"] = timeText.split(":");
  const date = new Date(2000, 0, 1, Number(hourText), Number(minuteText));
  if (Number.isNaN(date.getTime())) {
    return timeText;
  }
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCreatedAt(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function parseIndexSections(indexText: string): Array<{ time: string; summaryText: string }> {
  const sections: Array<{ time: string; summaryText: string }> = [];
  INDEX_SECTION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INDEX_SECTION_PATTERN.exec(indexText)) !== null) {
    sections.push({
      time: `${match[1]}:${match[2]}`,
      summaryText: (match[3] || "").trim(),
    });
  }
  return sections;
}

function frameDataUrl(frame: ApprovalFrame): string {
  return `data:${frame.mimeType};base64,${frame.data}`;
}

function approvalKindLabel(payload: ApprovalPayload): string {
  switch (payload.kind) {
    case "day_list":
      return "Day list";
    case "day_index":
      return "Day index";
    case "chunk_context":
      return "Chunk context";
  }
}

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
    visiblePendingChunks: 0,
    activeRecordingChunk: false,
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
  const [aiSettings, setAISettings] = useState<AISettings>(fallbackAISettings);
  const [settingsTimeoutSeconds, setSettingsTimeoutSeconds] = useState(120);
  const [chunkDurationMinutes, setChunkDurationMinutes] = useState(5);
  const [approvalDrafts, setApprovalDrafts] = useState<Record<string, ApprovalPayload>>({});
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
        .then((buf) => contextManager.sendRecordingChunk(buf))
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

  const updateApprovalDraft = useCallback((requestId: string, nextPayload: ApprovalPayload) => {
    setApprovalDrafts((current) => ({ ...current, [requestId]: nextPayload }));
  }, []);

  const resolveRequest = useCallback(
    async (request: ApprovalRequest, resolution: "approved" | "rejected") => {
      try {
        setError(null);
        await contextManager.resolveApproval(
          request.id,
          resolution,
          resolution === "approved" ? approvalDrafts[request.id] || request.payload : undefined
        );
        setPendingApprovals((current) => current.filter((pending) => pending.id !== request.id));
        setApprovalDrafts((current) => {
          const next = { ...current };
          delete next[request.id];
          return next;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to resolve request");
      }
    },
    [approvalDrafts]
  );

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

  const saveAISettings = useCallback(async () => {
    try {
      setError(null);
      const updated = await contextManager.updateAISettings(aiSettings);
      setAISettings(updated);
      setApprovalNotice("AI settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save AI settings");
    }
  }, [aiSettings]);

  const saveChunkSettings = useCallback(async () => {
    try {
      setError(null);
      const updated = await contextManager.updateChunkSettings({
        chunkDurationMinutes: Math.max(1, Math.round(chunkDurationMinutes)),
      });
      setChunkDurationMinutes(updated.chunkDurationMinutes);
      setApprovalNotice("Capture settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save capture settings");
    }
  }, [chunkDurationMinutes]);

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const formatChunkCount = (count: number) => `${count} chunk${count === 1 ? "" : "s"}`;

  const processingCurrent = Math.max(processingStatus.currentChunk, 1);
  const processingTotal = Math.max(processingStatus.totalChunks, processingCurrent);
  const visiblePendingChunks = processingStatus.visiblePendingChunks;

  const statusLine = (() => {
    if (processingStatus.isProcessing) {
      if (processingStatus.trigger === "live" && processingStatus.activeRecordingChunk) {
        return `Processing chunk ${processingCurrent}/${processingTotal} - next chunk recording`;
      }
      return `Processing chunk ${processingCurrent}/${processingTotal}`;
    }
    if (isRecording && processingStatus.activeRecordingChunk) {
      if (processingStatus.pendingChunks > 0) {
        return `Recording - ${formatChunkCount(visiblePendingChunks)} pending`;
      }
      return "Recording - 1 chunk in progress";
    }
    if (isRecording) {
      return "Recording";
    }
    if (visiblePendingChunks > 0) {
      return `Idle - ${formatChunkCount(visiblePendingChunks)} pending`;
    }
    return "All caught up";
  })();

  const processNowLabel = (() => {
    if (processingStatus.isProcessing) {
      return `Processing chunk ${processingCurrent}/${processingTotal}...`;
    }
    if (processingStatus.pendingChunks > 0) {
      return `Process ${formatChunkCount(processingStatus.pendingChunks)}`;
    }
    if (processingStatus.activeRecordingChunk) {
      return "Waiting for current chunk";
    }
    return "Process Now";
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
    void contextManager.getChunkSettings().then((settings) => {
      setChunkDurationMinutes(settings.chunkDurationMinutes);
    });
    void contextManager.getAISettings().then((settings) => {
      setAISettings(settings);
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

  useEffect(() => {
    setApprovalDrafts((current) => {
      const next: Record<string, ApprovalPayload> = {};
      for (const request of pendingApprovals) {
        next[request.id] = current[request.id] || request.payload;
      }
      return next;
    });
  }, [pendingApprovals]);

  const pendingCount = pendingApprovals.length;
  const isLocalProvider = aiSettings.provider === "local";
  const statusToneClass = processingStatus.isProcessing
    ? "tone-processing"
    : isRecording
      ? "tone-live"
      : processingStatus.pendingChunks > 0
        ? "tone-pending"
        : "tone-ready";
  const remoteStatusToneClass =
    remoteAccessState.status === "connected"
      ? "tone-ready"
      : remoteAccessState.status === "error"
        ? "tone-warning"
        : remoteAccessState.status === "starting" || remoteAccessState.status === "reconnecting"
          ? "tone-processing"
          : "tone-muted";

  const renderDayListApproval = (request: ApprovalRequest, payload: DayListApprovalPayload) => (
    <div className="approval-stack">
      <div className="approval-chip-row">
        <span className="approval-kind-pill">{approvalKindLabel(payload)}</span>
        <span className="approval-helper-pill">Approve as shown</span>
      </div>
      <div className="approval-day-grid">
        {payload.days.length === 0 ? (
          <p className="empty-state">No stored context days found.</p>
        ) : (
          payload.days.map((day) => (
            <article key={`${request.id}-${day.date}`} className="approval-day-card">
              <div className="approval-day-header">
                <div>
                  <p className="approval-day-date">{formatFriendlyDate(day.date)}</p>
                  <p className="approval-day-subtitle">{day.date}</p>
                </div>
                <span className="approval-count-pill">
                  {day.chunkCount} chunk{day.chunkCount === 1 ? "" : "s"}
                </span>
              </div>
              <div className="approval-day-metadata">
                <span>{day.firstChunkTime ? formatFriendlyTime(day.firstChunkTime) : "No start time"}</span>
                <span>{day.lastChunkTime ? formatFriendlyTime(day.lastChunkTime) : "No end time"}</span>
                <span>{day.hasIndex ? "Indexed" : "Missing index"}</span>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );

  const renderDayIndexApproval = (request: ApprovalRequest, payload: DayIndexApprovalPayload) => {
    const sections = parseIndexSections(payload.indexText);
    return (
      <div className="approval-stack">
        <div className="approval-chip-row">
          <span className="approval-kind-pill">{approvalKindLabel(payload)}</span>
          <span className="approval-helper-pill">Edits apply only to this approval</span>
        </div>
        <div className="approval-date-hero">
          <div>
            <p className="approval-date-label">{formatFriendlyDate(payload.date)}</p>
            <h3 className="approval-date-title">{payload.date}</h3>
          </div>
          <div className="approval-chip-row">
            <span className="approval-count-pill">
              {payload.chunkCount} chunk{payload.chunkCount === 1 ? "" : "s"}
            </span>
            <span className="approval-count-pill">{payload.chunkKeys.length} keys</span>
          </div>
        </div>
        <div className="approval-time-section-list">
          {sections.length === 0 ? (
            <p className="empty-state">No timestamp sections detected in this index.</p>
          ) : (
            sections.map((section, index) => (
              <article key={`${request.id}-${section.time}-${index}`} className="approval-time-card">
                <div className="approval-time-pill">{formatFriendlyTime(section.time)}</div>
                <p className="approval-time-text">{section.summaryText}</p>
              </article>
            ))
          )}
        </div>
        <div className="approval-editor-block">
          <label className="field-label" htmlFor={`approval-index-${request.id}`}>
            Outgoing index text
          </label>
          <textarea
            id={`approval-index-${request.id}`}
            className="field-input approval-textarea"
            value={payload.indexText}
            onChange={(event) =>
              updateApprovalDraft(request.id, {
                ...payload,
                indexText: event.target.value,
              })
            }
          />
        </div>
      </div>
    );
  };

  const renderChunkContextApproval = (
    request: ApprovalRequest,
    payload: ChunkContextApprovalPayload
  ) => (
    <div className="approval-stack">
      <div className="approval-chip-row">
        <span className="approval-kind-pill">{approvalKindLabel(payload)}</span>
        <span className="approval-helper-pill">Edits apply only to this approval</span>
      </div>
      <div className="approval-date-hero">
        <div>
          <p className="approval-date-label">{formatFriendlyDate(payload.date)}</p>
          <h3 className="approval-date-title">{formatFriendlyTime(payload.time)}</h3>
          <p className="approval-day-subtitle">{payload.chunkKey}</p>
        </div>
        <span className="approval-count-pill">
          {payload.frames.length} frame{payload.frames.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="approval-editor-block">
        <label className="field-label" htmlFor={`approval-summary-${request.id}`}>
          Outgoing summary
        </label>
        <textarea
          id={`approval-summary-${request.id}`}
          className="field-input approval-textarea approval-textarea-short"
          value={payload.summaryText}
          onChange={(event) =>
            updateApprovalDraft(request.id, {
              ...payload,
              summaryText: event.target.value,
            })
          }
        />
      </div>
      <div className="approval-editor-block">
        <label className="field-label" htmlFor={`approval-meta-${request.id}`}>
          Outgoing metadata
        </label>
        <textarea
          id={`approval-meta-${request.id}`}
          className="field-input approval-textarea"
          value={payload.metaText}
          onChange={(event) =>
            updateApprovalDraft(request.id, {
              ...payload,
              metaText: event.target.value,
            })
          }
        />
      </div>
      <div className="approval-frame-header">
        <div>
          <p className="approval-date-label">Frames</p>
          <p className="approval-day-subtitle">Remove any frame you do not want to send.</p>
        </div>
        <span className="approval-count-pill">
          {payload.frames.length} selected
        </span>
      </div>
      <div className="approval-frame-grid">
        {payload.frames.length === 0 ? (
          <p className="empty-state">No frames selected for this approval.</p>
        ) : (
          payload.frames.map((frame) => (
            <article key={`${request.id}-${frame.name}`} className="approval-frame-card">
              <button
                className="approval-frame-remove"
                onClick={() =>
                  updateApprovalDraft(request.id, {
                    ...payload,
                    frames: payload.frames.filter((candidate) => candidate.name !== frame.name),
                  })
                }
                type="button"
              >
                Remove
              </button>
              <img className="approval-frame-image" src={frameDataUrl(frame)} alt={frame.name} />
              <div className="approval-frame-meta">
                <span>{frame.name}</span>
                <span>{frame.mimeType}</span>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );

  const renderApprovalCard = (request: ApprovalRequest) => {
    const payload = approvalDrafts[request.id] || request.payload;
    switch (payload.kind) {
      case "day_list":
        return renderDayListApproval(request, payload);
      case "day_index":
        return renderDayIndexApproval(request, payload);
      case "chunk_context":
        return renderChunkContextApproval(request, payload);
    }
  };

  return (
    <div className="app-shell">
      <div className="hero-wrap">
        <div className="app-frame">
          <header className="hero">
            <p className="hero-eyebrow">Open Source &middot; Private &middot; Context Aware</p>
            <h1 className="hero-title">
              Your AI,<br />
              always <span>in the loop.</span>
            </h1>
            <p className="hero-copy">
              Records your screen, tags what you do, and exposes that context to your favorite
              models.
            </p>
            <div className="hero-meta">
              <span className={`status-pill ${statusToneClass}`}>{statusLine}</span>
              <span className={`status-pill ${remoteStatusToneClass}`}>Remote: {remoteStatusLine}</span>
            </div>
          </header>
        </div>
      </div>

      <div className="app-frame content-area">
        <div className="tab-list" role="tablist" aria-label="Context manager sections">
          <button
            className={`tab-button ${activeTab === "controls" ? "is-active" : ""}`}
            onClick={() => setActiveTab("controls")}
            type="button"
          >
            Controls
          </button>
          <button
            className={`tab-button ${activeTab === "requests" ? "is-active" : ""}`}
            onClick={() => setActiveTab("requests")}
            type="button"
          >
            Requests{pendingCount > 0 ? ` (${pendingCount})` : ""}
          </button>
          <button
            className={`tab-button ${activeTab === "settings" ? "is-active" : ""}`}
            onClick={() => setActiveTab("settings")}
            type="button"
          >
            Settings
          </button>
        </div>

        {error && <p className="banner banner-error">{error}</p>}
        {approvalNotice && <p className="banner banner-info">{approvalNotice}</p>}

        {activeTab === "controls" && (
          <section className="panel">
            <div className="section-heading">
              <p className="section-kicker">Capture</p>
              <h2 className="section-title">Capture your desktop context</h2>
            </div>

            <div className="control-row">
              <button
                className={`button button-primary ${isRecording ? "button-danger" : ""}`}
                onClick={isRecording ? stopCapture : startCapture}
                type="button"
              >
                {isRecording ? "Stop Recording" : "Start Recording"}
              </button>
              <button
                className="button button-secondary"
                onClick={processNow}
                disabled={processingStatus.pendingChunks === 0 || processingStatus.isProcessing}
                type="button"
              >
                {processNowLabel}
              </button>

              {isRecording && <span className="duration-pill">{formatDuration(duration)}</span>}
            </div>

            <p className="support-copy">
              Capture runs quietly in the background, rotating files automatically so your backlog
              stays searchable and easy to process.
            </p>
          </section>
        )}

        {activeTab === "requests" && (
          <section className="panel">
            <div className="section-heading section-heading-row">
              <div>
                <p className="section-kicker">Approvals</p>
                <h2 className="section-title">Pending requests</h2>
              </div>
              <div className="button-row">
                <button className="button button-ghost" onClick={() => void refreshApprovalState()} type="button">
                  Refresh
                </button>
                <button
                  className="button button-secondary"
                  onClick={() => void approveAll()}
                  disabled={pendingCount === 0}
                  type="button"
                >
                  Approve All
                </button>
              </div>
            </div>

            <p className="support-copy">Pending Requests: {pendingCount}</p>

            {pendingCount === 0 && <p className="empty-state">No pending requests.</p>}

            <div className="request-list">
              {pendingApprovals.map((request) => (
                <article key={request.id} className="request-card approval-request-card">
                  <div className="request-header">
                    <div className="request-meta">
                      <div className="request-title">{request.title || request.query}</div>
                      <div className="request-date">{formatCreatedAt(request.createdAt)}</div>
                    </div>
                    <div className="button-row">
                      <button
                        className="button button-secondary"
                        onClick={() => void resolveRequest(request, "approved")}
                        type="button"
                      >
                        Approve
                      </button>
                      <button
                        className="button button-ghost"
                        onClick={() => void resolveRequest(request, "rejected")}
                        type="button"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                  {renderApprovalCard(request)}
                </article>
              ))}
            </div>
          </section>
        )}

        {activeTab === "settings" && (
          <section className="panel panel-form">
            <div className="settings-stack">
              <div className="section-heading">
                <p className="section-kicker">Capture</p>
                <h2 className="section-title">Capture settings</h2>
              </div>

              <label className="field-label" htmlFor="chunk-duration-minutes">
                Chunk duration (minutes)
              </label>
              <input
                id="chunk-duration-minutes"
                className="field-input field-input-small"
                type="number"
                min={1}
                step={1}
                value={chunkDurationMinutes}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setChunkDurationMinutes(Number.isFinite(next) ? next : 5);
                }}
              />
              <p className="support-copy">
                New recordings rotate every {chunkDurationMinutes || 5} minute
                {Math.abs(chunkDurationMinutes || 5) === 1 ? "" : "s"}. Default is 5 minutes.
              </p>
              <div>
                <button className="button button-primary" onClick={() => void saveChunkSettings()} type="button">
                  Save Capture Settings
                </button>
              </div>

              <div className="section-heading">
                <p className="section-kicker">Configuration</p>
                <h2 className="section-title">AI settings</h2>
              </div>

              <label className="field-label" htmlFor="provider">
                Provider
              </label>
              <select
                id="provider"
                className="field-input"
                value={aiSettings.provider}
                onChange={(event) =>
                  setAISettings((current) => ({
                    ...current,
                    provider: event.target.value === "local" ? "local" : "fireworks",
                  }))
                }
              >
                <option value="fireworks">Fireworks</option>
                <option value="local">Local (Ollama)</option>
              </select>
              {!isLocalProvider && (
                <p className="support-copy">
                  Fireworks mode keeps using your existing <code>FIREWORKS_*</code> environment
                  variables.
                </p>
              )}
              {isLocalProvider && (
                <>
                  <label className="field-label" htmlFor="ollama-base-url">
                    Ollama base URL
                  </label>
                  <input
                    id="ollama-base-url"
                    className="field-input"
                    type="text"
                    value={aiSettings.localBaseUrl}
                    onChange={(event) =>
                      setAISettings((current) => ({
                        ...current,
                        localBaseUrl: event.target.value,
                      }))
                    }
                  />
                  <label className="field-label" htmlFor="ollama-tagging-model">
                    Local tagging model
                  </label>
                  <input
                    id="ollama-tagging-model"
                    className="field-input"
                    type="text"
                    value={aiSettings.localTaggingModel}
                    onChange={(event) =>
                      setAISettings((current) => ({
                        ...current,
                        localTaggingModel: event.target.value,
                      }))
                    }
                  />
                  <label className="field-label" htmlFor="ollama-search-model">
                    Local search model
                  </label>
                  <input
                    id="ollama-search-model"
                    className="field-input"
                    type="text"
                    value={aiSettings.localSearchModel}
                    onChange={(event) =>
                      setAISettings((current) => ({
                        ...current,
                        localSearchModel: event.target.value,
                      }))
                    }
                  />
                  <p className="support-copy">
                    Use Ollama&apos;s OpenAI-compatible endpoint. If you enter{" "}
                    <code>http://127.0.0.1:11434</code>, the app will automatically normalize it to{" "}
                    <code>/v1</code>.
                  </p>
                </>
              )}
              <div>
                <button className="button button-primary" onClick={() => void saveAISettings()} type="button">
                  Save AI Settings
                </button>
              </div>

              <div className="section-heading">
                <p className="section-kicker">Connection</p>
                <h2 className="section-title">Remote access</h2>
              </div>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={remoteAccessState.enabled}
                  disabled={isTogglingRemoteAccess}
                  onChange={(event) => {
                    void setRemoteAccessEnabled(event.target.checked);
                  }}
                />
                <span>Enable remote access</span>
              </label>
              <p className={`support-copy ${remoteStatusToneClass}`}>Status: {remoteStatusLine}</p>
              <p className="support-copy">
                Remote tool calls still respect the approval queue below. Keep the app open to
                approve requests, or enable auto-approve while testing.
              </p>
              {remoteAccessState.error && <p className="banner banner-warning">{remoteAccessState.error}</p>}
              {remoteAccessState.enabled && (
                <div className="info-card">
                  <div className="info-block">
                    <div className="info-label">Remote MCP Endpoint</div>
                    <div className="info-value">
                      {remoteMcpEndpoint || "(waiting for MCP endpoint...)"}
                    </div>
                    <button
                      className="button button-ghost"
                      disabled={!remoteMcpEndpoint}
                      onClick={() => void copyToClipboard(remoteMcpEndpoint)}
                      type="button"
                    >
                      Copy MCP Endpoint
                    </button>
                  </div>
                  <p className="support-copy">
                    Use the endpoint above for Claude or any remote MCP client. The server
                    advertises standard OAuth discovery, authorization, token, and dynamic client
                    registration endpoints automatically.
                  </p>
                </div>
              )}

              <div className="section-heading">
                <p className="section-kicker">Guardrails</p>
                <h2 className="section-title">Approval settings</h2>
              </div>

              <label className="checkbox-row">
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
                <span>Auto-approve all requests</span>
              </label>

              <label className="field-label" htmlFor="approval-timeout">
                Approval timeout (seconds)
              </label>
              <input
                id="approval-timeout"
                className="field-input field-input-small"
                type="number"
                min={5}
                value={settingsTimeoutSeconds}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setSettingsTimeoutSeconds(Number.isFinite(next) ? next : 120);
                }}
              />

              <div>
                <button className="button button-primary" onClick={() => void saveSettings()} type="button">
                  Save Settings
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
