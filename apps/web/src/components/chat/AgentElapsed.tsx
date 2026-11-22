import type { RuntimeSubagent } from "@d4research/client-runtime/state/subagentRuntime";
import { isOrchestrationV2WorkActive } from "@d4research/contracts";
import { deriveSubagentElapsedMs } from "@d4research/shared/orchestrationTiming";
import { useEffect, useRef } from "react";
import { msg, useMessages } from "gt-react";
import type { MessageResolver } from "~/i18n/messages";

function formatElapsedSeconds(totalSeconds: number, resolve: MessageResolver): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return resolve(msg("{seconds}s", { seconds, $context: "elapsed time, seconds" }));
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return resolve(
      msg("{minutes}m {seconds}s", {
        minutes,
        seconds: String(seconds % 60).padStart(2, "0"),
        $context: "elapsed time, minutes and seconds",
      }),
    );
  }
  return resolve(
    msg("{hours}h {minutes}m", {
      hours,
      minutes: String(minutes % 60).padStart(2, "0"),
      $context: "elapsed time, hours and minutes",
    }),
  );
}

function formatCompactElapsedSeconds(totalSeconds: number, resolve: MessageResolver): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60)
    return resolve(msg("{seconds}s", { seconds, $context: "elapsed time, seconds" }));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return resolve(msg("{minutes}m", { minutes, $context: "elapsed time, minutes" }));
  if (minutes >= 600) {
    return resolve(
      msg("{hours}h", { hours: Math.floor(minutes / 60), $context: "elapsed time, hours" }),
    );
  }
  return resolve(
    msg("{hours}h", { hours: Math.floor(minutes / 6) / 10, $context: "elapsed time, hours" }),
  );
}

export function AgentElapsed({
  agent,
  compact = false,
}: {
  agent: Pick<RuntimeSubagent, "status" | "startedAt" | "completedAt">;
  compact?: boolean;
}) {
  const m = useMessages();
  const format = compact ? formatCompactElapsedSeconds : formatElapsedSeconds;
  const textRef = useRef<HTMLSpanElement>(null);
  const live = isOrchestrationV2WorkActive(agent.status);
  const startedAt = agent.startedAt;
  const completedAt = agent.completedAt;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the elapsed-time DOM text synchronized with the running clock.
  useEffect(() => {
    if (!startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        const elapsedMs = deriveSubagentElapsedMs(
          { status: agent.status, startedAt, completedAt },
          Date.now(),
        );
        const text = elapsedMs === null ? "" : format(elapsedMs / 1000, m);
        if (textRef.current.textContent !== text) textRef.current.textContent = text;
      }
    };
    update();
    if (!live) return;
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt, completedAt, agent.status, format, m]);

  const elapsedMs = deriveSubagentElapsedMs(agent, 0);
  if (elapsedMs === null) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {format(elapsedMs / 1000, m)}
    </span>
  );
}
