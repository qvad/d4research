import type { CommandOutputView } from "@d4research/client-runtime/state/command-output";
import type { EnvironmentId, ThreadId, TurnItemId } from "@d4research/contracts";
import { TERMINAL_PALETTES, terminalOutputSpans } from "@d4research/shared/terminalOutput";
import { T, Var } from "gt-react";
import { useLayoutEffect, useRef } from "react";

import { useTheme } from "../../hooks/useTheme";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useInitialOutputReady, type TurnItemSource } from "./timelineRowContext";

// Within this many pixels of the end still counts as following the output.
const FOLLOW_SLACK_PX = 8;

/** True when the environment streams command output; older servers only return final output. */
export function useCommandOutputStreaming(environmentId: EnvironmentId): boolean {
  return (
    useServerConfigs().get(environmentId)?.environment.capabilities.commandOutputStreaming === true
  );
}

/**
 * Output of one expanded command row: streams while the command runs, then
 * shows its final output. Mount it only when `useCommandOutputStreaming` holds.
 * It subscribes only while mounted, so collapsed rows and other threads receive nothing.
 */
export function CommandOutputPanel(props: {
  readonly onInitialOutputReady?: (() => void) | undefined;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly source?: TurnItemSource["commandOutput"] | undefined;
}) {
  const input = { threadId: props.threadId, itemId: props.itemId };
  const { data, error } = useEnvironmentQuery<CommandOutputView, unknown>(
    props.source
      ? props.source(input)
      : orchestrationEnvironment.v2.commandOutput({ environmentId: props.environmentId, input }),
  );
  useInitialOutputReady(data === null && !error, props.onInitialOutputReady);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow new output until the reader scrolls up; scrolling back down resumes.
  const followRef = useRef(true);
  const text = data?.output.text ?? "";
  const { resolvedTheme } = useTheme();

  // This panel only re-renders when its output changes, so keep the end in view after each.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scrolls the output DOM to the live edge after streamed content commits.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  });

  if (text.length === 0) {
    if (error) {
      return (
        <div className="text-destructive">
          <T>
            Couldn&apos;t load output: <Var>{error}</Var>
          </T>
        </div>
      );
    }
    if (data === null) {
      return (
        <div className="text-muted-foreground italic">
          <T>Loading output…</T>
        </div>
      );
    }
    return data.running ? null : (
      <div className="text-muted-foreground italic">
        <T>No output.</T>
      </div>
    );
  }
  // Parsed after the layout effect, the last hook, so the compiler caches it on text and theme.
  const spans = terminalOutputSpans(text, TERMINAL_PALETTES[resolvedTheme]);
  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        followRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX;
      }}
      className="max-h-80 overflow-auto text-muted-foreground"
    >
      {data?.output.truncated ? (
        <div className="italic">
          <T>Earlier output not shown</T>
        </div>
      ) : null}
      {spans.map((span, index) =>
        span.style === null ? (
          span.text
        ) : (
          // Spans never reorder and are rebuilt on each update.
          // oxlint-disable-next-line react/no-array-index-key
          <span key={index} style={span.style}>
            {span.text}
          </span>
        ),
      )}
    </div>
  );
}
