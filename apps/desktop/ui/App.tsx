import { useState, useEffect, useRef, useCallback } from "react";

const contextManager = window.contextManager;

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rotationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startCapture = useCallback(async () => {
    try {
      setError(null);
      if (!contextManager) {
        throw new Error(
          "contextManager is not available. Run the app with Electron (pnpm dev), not in a browser."
        );
      }
      const sources = await contextManager.getDesktopSources({
        types: ["screen"],
      });
      if (sources.length === 0) {
        throw new Error("No screen source available");
      }
      const sourceId = sources[0].id;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
          },
        } as unknown as MediaTrackConstraints,
      });
      streamRef.current = stream;

      await contextManager.startRecording();

      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm";
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 2500000,
      });

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          e.data.arrayBuffer().then((buf) => {
            contextManager.sendRecordingChunk(buf);
          });
        }
      };

      recorder.start(1000); // Collect chunks every second
      mediaRecorderRef.current = recorder;

      const chunkDurationMs = await contextManager.getChunkDurationMs();
      rotationTimerRef.current = setInterval(async () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
          mediaRecorderRef.current.stop();
          mediaRecorderRef.current.onstop = async () => {
            const { filePath } = await contextManager.rotateRecording();
            const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
              ? "video/webm;codecs=vp9"
              : "video/webm";
            const newRecorder = new MediaRecorder(streamRef.current!, {
              mimeType,
              videoBitsPerSecond: 2500000,
            });
            newRecorder.ondataavailable = (e) => {
              if (e.data.size > 0) {
                e.data.arrayBuffer().then((buf) => {
                  contextManager.sendRecordingChunk(buf);
                });
              }
            };
            newRecorder.start(1000);
            mediaRecorderRef.current = newRecorder;
          };
        }
      }, chunkDurationMs);

      durationTimerRef.current = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);

      setIsRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start recording");
    }
  }, []);

  const stopCapture = useCallback(async () => {
    if (rotationTimerRef.current) {
      clearInterval(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    setDuration(0);

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.onstop = async () => {
        await contextManager.stopRecording();
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        mediaRecorderRef.current = null;
        setIsRecording(false);
      };
    } else {
      await contextManager.stopRecording();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      mediaRecorderRef.current = null;
      setIsRecording(false);
    }
  }, []);

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  useEffect(() => {
    return () => {
      if (rotationTimerRef.current) clearInterval(rotationTimerRef.current);
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    };
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>Context Manager</h1>
      <p>Personal, local-first screen recording and tagging.</p>

      {error && (
        <p style={{ color: "#c00", marginBottom: 16 }}>{error}</p>
      )}

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

        {isRecording && (
          <span style={{ marginLeft: 16, fontSize: 18, fontWeight: 500 }}>
            {formatDuration(duration)}
          </span>
        )}
      </div>
    </div>
  );
}
