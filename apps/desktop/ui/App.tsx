import { useState, useEffect, useRef, useCallback } from "react";
import type {
  ApprovalFrame,
  ApprovalPayload,
  ApprovalRequest,
  ApprovalSettings,
  ChunkContextApprovalPayload,
  DayIndexApprovalPayload,
  DayListApprovalPayload,
  LiveContextApprovalPayload,
  LiveFrameApprovalPayload,
  LiveSnapshotsApprovalPayload,
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
  fireworksApiKey?: string;
};

type ExclusionEntry = {
  bundle_id: string;
  name: string;
  is_default: boolean;
  enabled: boolean;
};

type ExclusionsConfig = {
  requires_restart: boolean;
  bundle_ids: ExclusionEntry[];
};

type InstalledApp = {
  bundleId: string;
  name: string;
  iconPath: string | null;
};

type SckitExclusionsInitState = {
  initialized: boolean;
  bundleIds: string[];
  error: string | null;
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
};

const initialExclusionsConfig: ExclusionsConfig = {
  requires_restart: false,
  bundle_ids: [],
};

const initialSckitExclusionsState: SckitExclusionsInitState = {
  initialized: false,
  bundleIds: [],
  error: null,
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

function normalizeClockTime(timeText: string): string {
  const [hRaw = "0", mRaw = "0"] = timeText.trim().split(":");
  const hour = Math.min(23, Math.max(0, Number.parseInt(hRaw, 10) || 0));
  const minute = Math.min(59, Math.max(0, Number.parseInt(mRaw, 10) || 0));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function serializeIndexSections(sections: Array<{ time: string; summaryText: string }>): string {
  return sections
    .map((section) => {
      const t = normalizeClockTime(section.time);
      const body = section.summaryText.replace(/\r\n/g, "\n").trimEnd();
      return `[${t}]\n${body}`;
    })
    .join("\n\n")
    .trimEnd();
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
    case "live_context":
      return "Live context";
    case "live_frame":
      return "Live frame";
    case "live_snapshots":
      return "Live snapshots";
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
  const [exclusions, setExclusions] = useState<ExclusionsConfig>(initialExclusionsConfig);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [manualBundleId, setManualBundleId] = useState("");
  const [sckitExclusionsState, setSckitExclusionsState] = useState<SckitExclusionsInitState>(
    initialSckitExclusionsState
  );
  const [approvalDrafts, setApprovalDrafts] = useState<Record<string, ApprovalPayload>>({});
  const [approvalNotice, setApprovalNotice] = useState<string | null>(null);
  const [frameLightbox, setFrameLightbox] = useState<{ src: string; title: string } | null>(null);

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

  const setExclusionsAndNotify = useCallback((next: ExclusionsConfig, notice: string) => {
    setExclusions(next);
    setApprovalNotice(notice);
  }, []);

  const updateExclusionEntries = useCallback(
    async (entries: ExclusionEntry[], notice: string) => {
      const updated = await contextManager.updateExclusions({ bundle_ids: entries });
      setExclusionsAndNotify(updated, notice);
    },
    [setExclusionsAndNotify]
  );

  const toggleExclusion = useCallback(
    async (bundleId: string, enabled: boolean) => {
      const nextEntries = exclusions.bundle_ids.map((entry) =>
        entry.bundle_id === bundleId ? { ...entry, enabled } : entry
      );
      await updateExclusionEntries(nextEntries, "Excluded windows updated. Restart required.");
    },
    [exclusions.bundle_ids, updateExclusionEntries]
  );

  const removeExclusion = useCallback(
    async (bundleId: string) => {
      const nextEntries = exclusions.bundle_ids.filter((entry) => entry.bundle_id !== bundleId);
      await updateExclusionEntries(nextEntries, "Excluded windows updated. Restart required.");
    },
    [exclusions.bundle_ids, updateExclusionEntries]
  );

  const addExclusion = useCallback(
    async (entry: { bundleId: string; name: string }) => {
      const normalized = entry.bundleId.trim();
      if (!normalized) {
        return;
      }
      const existing = exclusions.bundle_ids.find((candidate) => candidate.bundle_id === normalized);
      const nextEntries = existing
        ? exclusions.bundle_ids.map((candidate) =>
            candidate.bundle_id === normalized ? { ...candidate, name: entry.name, enabled: true } : candidate
          )
        : [
            ...exclusions.bundle_ids,
            {
              bundle_id: normalized,
              name: entry.name || normalized,
              is_default: false,
              enabled: true,
            },
          ];
      await updateExclusionEntries(nextEntries, "Excluded windows updated. Restart required.");
    },
    [exclusions.bundle_ids, updateExclusionEntries]
  );

  const saveAllSettings = useCallback(async () => {
    await saveChunkSettings();
    await saveAISettings();
    await saveSettings();
  }, [saveChunkSettings, saveAISettings, saveSettings]);

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
        return `Processed ${processingCurrent}/${processingTotal} chunks - next chunk recording`;
      }
      return `Processed ${processingCurrent}/${processingTotal} chunks`;
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
      return `Processed ${processingCurrent}/${processingTotal} chunks...`;
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
    void contextManager.getExclusions().then((settings) => {
      setExclusions(settings);
    });
    void contextManager.scanInstalledApps().then((apps) => {
      setInstalledApps(apps);
    });
    void contextManager.getSckitExclusionsInitState().then((state) => {
      setSckitExclusionsState(state);
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

  useEffect(() => {
    if (!frameLightbox) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFrameLightbox(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [frameLightbox]);

  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      const droppedFile = event.dataTransfer?.files?.[0] as (File & { path?: string }) | undefined;
      const filePath = droppedFile?.path;
      if (!filePath || !filePath.endsWith(".app")) {
        return;
      }
      void contextManager.scanInstalledAppFromPath(filePath).then((appEntry) => {
        if (!appEntry) {
          return;
        }
        void addExclusion({ bundleId: appEntry.bundleId, name: appEntry.name });
      });
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [addExclusion, pickerOpen]);

  const pendingCount = pendingApprovals.length;
  const exclusionQuery = pickerQuery.trim().toLowerCase();
  const excludedIds = new Set(exclusions.bundle_ids.map((entry) => entry.bundle_id));
  const filteredApps = installedApps.filter((app) => {
    if (excludedIds.has(app.bundleId)) {
      return false;
    }
    if (!exclusionQuery) {
      return true;
    }
    return (
      app.name.toLowerCase().includes(exclusionQuery) ||
      app.bundleId.toLowerCase().includes(exclusionQuery)
    );
  });
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
    const updateDayIndexSection = (
      sectionIndex: number,
      patch: Partial<{ time: string; summaryText: string }>
    ) => {
      const next = parseIndexSections(payload.indexText).map((section, i) =>
        i === sectionIndex ? { ...section, ...patch } : section
      );
      updateApprovalDraft(request.id, {
        ...payload,
        indexText: serializeIndexSections(next),
      });
    };

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
            <>
              <p className="empty-state">No timestamp sections detected in this index.</p>
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
            </>
          ) : (
            sections.map((section, index) => (
              <article key={`${request.id}-${section.time}-${index}`} className="approval-time-card">
                <div className="approval-time-edit-row">
                  <label className="field-label approval-time-field-label" htmlFor={`approval-time-${request.id}-${index}`}>
                    Time
                  </label>
                  <input
                    id={`approval-time-${request.id}-${index}`}
                    type="time"
                    className="field-input approval-time-input"
                    value={normalizeClockTime(section.time)}
                    onChange={(event) =>
                      updateDayIndexSection(index, { time: event.target.value })
                    }
                  />
                </div>
                <label className="field-label" htmlFor={`approval-summary-${request.id}-${index}`}>
                  Summary
                </label>
                <textarea
                  id={`approval-summary-${request.id}-${index}`}
                  className="field-input approval-textarea approval-time-body-textarea"
                  value={section.summaryText}
                  onChange={(event) =>
                    updateDayIndexSection(index, { summaryText: event.target.value })
                  }
                />
              </article>
            ))
          )}
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
        <label
          className="field-label approval-editor-heading"
          htmlFor={`approval-summary-${request.id}`}
        >
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
        <label
          className="field-label approval-editor-heading"
          htmlFor={`approval-meta-${request.id}`}
        >
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
              <button
                type="button"
                className="approval-frame-image-button"
                onClick={() =>
                  setFrameLightbox({ src: frameDataUrl(frame), title: frame.name })
                }
                aria-label={`View full size: ${frame.name}`}
              >
                <img className="approval-frame-image" src={frameDataUrl(frame)} alt="" />
              </button>
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

  const renderLiveContextApproval = (request: ApprovalRequest, payload: LiveContextApprovalPayload) => (
    <div className="approval-stack">
      <div className="approval-chip-row">
        <span className="approval-kind-pill">{approvalKindLabel(payload)}</span>
        <span className="approval-helper-pill">Edits apply only to this approval</span>
      </div>
      <div className="approval-editor-block">
        <label className="field-label" htmlFor={`approval-live-ctx-${request.id}`}>
          Outgoing text
        </label>
        <textarea
          id={`approval-live-ctx-${request.id}`}
          className="field-input approval-textarea"
          value={payload.timelineText}
          onChange={(event) =>
            updateApprovalDraft(request.id, {
              ...payload,
              timelineText: event.target.value,
            })
          }
        />
      </div>
    </div>
  );

  const renderLiveFrameApproval = (request: ApprovalRequest, payload: LiveFrameApprovalPayload) => (
    <div className="approval-stack">
      <div className="approval-chip-row">
        <span className="approval-kind-pill">{approvalKindLabel(payload)}</span>
        <span className="approval-helper-pill">Approve to send this screenshot</span>
      </div>
      <div className="approval-date-hero">
        <p className="approval-day-subtitle">Timestamp {payload.timestamp}</p>
      </div>
      <div className="approval-frame-grid">
        <article className="approval-frame-card">
          <button
            type="button"
            className="approval-frame-image-button"
            onClick={() =>
              setFrameLightbox({
                src: frameDataUrl({ name: "live", mimeType: payload.mimeType, data: payload.data }),
                title: "Live frame",
              })
            }
            aria-label="View full size"
          >
            <img
              className="approval-frame-image"
              src={frameDataUrl({ name: "live", mimeType: payload.mimeType, data: payload.data })}
              alt=""
            />
          </button>
        </article>
      </div>
    </div>
  );

  const renderLiveSnapshotsApproval = (
    request: ApprovalRequest,
    payload: LiveSnapshotsApprovalPayload
  ) => (
    <div className="approval-stack">
      <div className="approval-chip-row">
        <span className="approval-kind-pill">{approvalKindLabel(payload)}</span>
        <span className="approval-helper-pill">Remove snapshots you do not want to send</span>
      </div>
      <div className="approval-frame-header">
        <span className="approval-count-pill">{payload.items.length} snapshot(s)</span>
      </div>
      <div className="approval-frame-grid">
        {payload.items.length === 0 ? (
          <p className="empty-state">No snapshots selected.</p>
        ) : (
          payload.items.map((item) => (
            <article key={`${request.id}-${item.timestamp}`} className="approval-frame-card">
              <button
                className="approval-frame-remove"
                onClick={() =>
                  updateApprovalDraft(request.id, {
                    ...payload,
                    items: payload.items.filter((row) => row.timestamp !== item.timestamp),
                  })
                }
                type="button"
              >
                Remove
              </button>
              <button
                type="button"
                className="approval-frame-image-button"
                onClick={() =>
                  setFrameLightbox({
                    src: frameDataUrl(item.frame),
                    title: `${item.app} @ ${item.timestamp}`,
                  })
                }
                aria-label="View snapshot"
              >
                <img className="approval-frame-image" src={frameDataUrl(item.frame)} alt="" />
              </button>
              <div className="approval-frame-meta">
                <span>{item.app}</span>
                <span>{item.windowTitle}</span>
              </div>
              <label className="field-label" htmlFor={`approval-snap-ocr-${request.id}-${item.timestamp}`}>
                OCR
              </label>
              <textarea
                id={`approval-snap-ocr-${request.id}-${item.timestamp}`}
                className="field-input approval-textarea approval-time-body-textarea"
                value={item.ocrText}
                onChange={(event) =>
                  updateApprovalDraft(request.id, {
                    ...payload,
                    items: payload.items.map((row) =>
                      row.timestamp === item.timestamp ? { ...row, ocrText: event.target.value } : row
                    ),
                  })
                }
              />
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
      case "live_context":
        return renderLiveContextApproval(request, payload);
      case "live_frame":
        return renderLiveFrameApproval(request, payload);
      case "live_snapshots":
        return renderLiveSnapshotsApproval(request, payload);
    }
  };

  return (
    <div className="app-shell">
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
        {!sckitExclusionsState.initialized && sckitExclusionsState.error && (
          <p className="banner banner-error">
            OS-level exclusions failed to initialize: {sckitExclusionsState.error}
          </p>
        )}
        {approvalNotice && <p className="banner banner-info">{approvalNotice}</p>}

        {activeTab === "controls" && (
          <section className="panel">
            <div className="section-heading">
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

              <div className="section-heading">
                <h2 className="section-title">Privacy &mdash; Excluded Windows</h2>
              </div>
              <p className="support-copy">
                Apps in this list are blocked at the OS level. Their pixels never enter Basis.
              </p>
              {exclusions.requires_restart && (
                <div className="banner banner-warning restart-banner">
                  <span>Restart Basis to apply exclusion changes.</span>
                  <button className="button button-secondary" type="button" onClick={() => void contextManager.restartApp()}>
                    Restart Now
                  </button>
                </div>
              )}
              <div className="exclusion-list">
                {exclusions.bundle_ids.map((entry) => (
                  <article key={entry.bundle_id} className="exclusion-row">
                    <div className="exclusion-meta">
                      <div className="exclusion-name">{entry.name}</div>
                      <div className="exclusion-bundle">{entry.bundle_id}</div>
                    </div>
                    <label className="checkbox-row exclusion-toggle">
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        onChange={(event) => {
                          void toggleExclusion(entry.bundle_id, event.target.checked);
                        }}
                      />
                      <span>{entry.enabled ? "Enabled" : "Disabled"}</span>
                    </label>
                    {!entry.is_default && (
                      <button
                        className="button button-ghost"
                        type="button"
                        onClick={() => {
                          void removeExclusion(entry.bundle_id);
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </article>
                ))}
              </div>
              <div className="button-row">
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => {
                    setPickerOpen((current) => !current);
                    if (!pickerOpen) {
                      void contextManager.scanInstalledApps().then((apps) => setInstalledApps(apps));
                    }
                  }}
                >
                  {pickerOpen ? "Close App Picker" : "Add App"}
                </button>
              </div>
              {pickerOpen && (
                <div className="exclusion-picker">
                  <input
                    className="field-input"
                    placeholder="Search apps by name or bundle ID"
                    value={pickerQuery}
                    onChange={(event) => setPickerQuery(event.target.value)}
                  />
                  <div className="exclusion-picker-results">
                    {filteredApps.length === 0 ? (
                      <p className="empty-state">No matching apps.</p>
                    ) : (
                      filteredApps.map((appEntry) => (
                        <button
                          key={appEntry.bundleId}
                          className="exclusion-picker-item"
                          type="button"
                          onClick={() => {
                            void addExclusion({ bundleId: appEntry.bundleId, name: appEntry.name });
                          }}
                        >
                          {appEntry.iconPath ? (
                            <img src={`file://${appEntry.iconPath}`} alt="" className="exclusion-app-icon" />
                          ) : (
                            <span className="exclusion-app-icon-fallback" aria-hidden>
                              App
                            </span>
                          )}
                          <span>{appEntry.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="exclusion-manual-add">
                    <label className="field-label" htmlFor="manual-bundle-id">
                      Enter bundle ID manually
                    </label>
                    <div className="button-row">
                      <input
                        id="manual-bundle-id"
                        className="field-input"
                        placeholder="com.example.desktop"
                        value={manualBundleId}
                        onChange={(event) => setManualBundleId(event.target.value)}
                      />
                      <button
                        className="button button-secondary"
                        type="button"
                        onClick={() => {
                          const bundleId = manualBundleId.trim();
                          if (!bundleId) {
                            return;
                          }
                          void addExclusion({ bundleId, name: bundleId });
                          setManualBundleId("");
                        }}
                      >
                        Add
                      </button>
                    </div>
                    <p className="support-copy">You can also drag a <code>.app</code> bundle onto this list.</p>
                  </div>
                </div>
              )}

              <div className="section-heading">
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
                <>
                  <label className="field-label" htmlFor="fireworks-api-key">
                    Fireworks API key
                  </label>
                  <input
                    id="fireworks-api-key"
                    className="field-input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste key if not using FIREWORKS_API_KEY in the environment"
                    value={aiSettings.fireworksApiKey ?? ""}
                    onChange={(event) =>
                      setAISettings((current) => ({
                        ...current,
                        fireworksApiKey: event.target.value,
                      }))
                    }
                  />
                  <p className="support-copy">
                    Tagging uses <code>FIREWORKS_API_KEY</code> when set; otherwise the key above
                    (saved in <code>ai-settings.json</code>). Optional env: <code>FIREWORKS_MODEL</code>,{" "}
                    <code>FIREWORKS_BASE_URL</code>.
                  </p>
                </>
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
                  <p className="support-copy">
                    Use Ollama&apos;s OpenAI-compatible endpoint. If you enter{" "}
                    <code>http://127.0.0.1:11434</code>, the app will automatically normalize it to{" "}
                    <code>/v1</code>.
                  </p>
                </>
              )}

              <div className="section-heading">
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
                Remote tool calls respect the approval queue. Keep the app open to
                approve requests or enable auto-approve.
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
                    Use the endpoint above for Claude or any remote MCP client.
                  </p>
                </div>
              )}

              <div className="section-heading">
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
                <button className="button button-primary" onClick={() => void saveAllSettings()} type="button">
                  Save Settings
                </button>
              </div>
            </div>
          </section>
        )}
      </div>

      <div className="app-status-bar">
        <div className="app-frame">
          <div className="hero-meta">
            <span className={`status-pill ${statusToneClass}`}>{statusLine}</span>
            <span className={`status-pill ${remoteStatusToneClass}`}>Remote: {remoteStatusLine}</span>
          </div>
        </div>
      </div>

      {frameLightbox ? (
        <div
          className="frame-lightbox-overlay"
          role="presentation"
          onClick={() => setFrameLightbox(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="frame-lightbox-title"
            className="frame-lightbox-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="frame-lightbox-close"
              onClick={() => setFrameLightbox(null)}
              aria-label="Close"
            >
              Close
            </button>
            <img
              className="frame-lightbox-image"
              src={frameLightbox.src}
              alt={frameLightbox.title}
            />
            <p id="frame-lightbox-title" className="frame-lightbox-caption">
              {frameLightbox.title}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
