import { execSync } from "child_process";

const IDLE_CHECK_INTERVAL_MS = 30_000;
const IDLE_START_THRESHOLD_SECONDS = 300;
const IDLE_CONTINUE_THRESHOLD_SECONDS = 60;

export function getSystemIdleSeconds(): number {
  try {
    const output = execSync(
      "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000)}'",
      { encoding: "utf8" }
    )
      .trim()
      .split("\n")[0];
    const idleSeconds = Number.parseInt(output ?? "", 10);
    return Number.isFinite(idleSeconds) ? idleSeconds : 0;
  } catch {
    return 0;
  }
}

type IdleMonitorOptions = {
  hasUnprocessedFiles: () => boolean | Promise<boolean>;
  isProcessing: () => boolean;
  processWhileIdle: (shouldContinue: () => boolean) => Promise<void>;
};

export function startIdleMonitor(options: IdleMonitorOptions): () => void {
  let tickInFlight = false;

  const runTick = async (): Promise<void> => {
    if (tickInFlight || options.isProcessing()) {
      return;
    }

    tickInFlight = true;
    try {
      const idleSeconds = getSystemIdleSeconds();
      if (idleSeconds <= IDLE_START_THRESHOLD_SECONDS) {
        return;
      }

      const hasPending = await options.hasUnprocessedFiles();
      if (!hasPending) {
        return;
      }

      await options.processWhileIdle(
        () => getSystemIdleSeconds() > IDLE_CONTINUE_THRESHOLD_SECONDS
      );
    } finally {
      tickInFlight = false;
    }
  };

  const timer = setInterval(() => {
    void runTick();
  }, IDLE_CHECK_INTERVAL_MS);

  void runTick();

  return () => {
    clearInterval(timer);
  };
}
