import { shouldPreserveAssistantLineBreaks } from "@d4research/shared/markdownPipeline";
import { MessageId, type TurnItemId } from "@d4research/contracts";
import { T, useGT } from "gt-react";
import { use } from "react";
import type { ChatMessage } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { ReplyIcon } from "lucide-react";
import { captureAssistantMessageOpening } from "~/lib/assistantTextSelection";
import { responseContextRecord } from "~/lib/composerContextRecords";
import { Button } from "../ui/button";
import { readResponseSubagents } from "../../state/entities";
import { AssistantCitationSource } from "./AssistantCitationSource";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import { MESSAGE_HEADING_LEVEL, MessageAuthorHeading } from "./TimelineRowParts";

/** Text an agent sent with `send_to_user`, shown as its own words. */
export function SentMessageTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "sent-message" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <MessageAuthorHeading>T3 Code</MessageAuthorHeading>
      {/* Sent messages have no message id; citations name their turn item instead. */}
      <AssistantCitationSource
        messageId={MessageId.make(row.id)}
        {...(ctx.threadRef ? { threadRef: ctx.threadRef } : {})}
        itemKey={row.id}
        request={ctx.citationRequest}
        listRef={ctx.listRef}
      >
        <ChatMarkdown
          text={row.text}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          lineBreaks={shouldPreserveAssistantLineBreaks(row.text)}
          skills={ctx.skills}
          headingLevelOffset={MESSAGE_HEADING_LEVEL}
          onUseArtifactTemplate={ctx.onUseArtifactTemplate}
          onRunShellCommand={ctx.onRunShellCommand}
          onImageExpand={ctx.onImageExpand}
        />
      </AssistantCitationSource>
    </div>
  );
}

export function AssistantReplyButton({
  message,
  itemId,
}: {
  message: ChatMessage;
  itemId: TurnItemId;
}) {
  const ctx = use(TimelineRowCtx);
  const gt = useGT();
  const { threadRef, onReplyToResponse } = ctx;
  if (!threadRef || !onReplyToResponse || !message.text.trim()) return null;

  const reply = () => {
    // The meta row can sit below trailing tool rows, so the message may be virtualized away.
    const source = [
      ...document.querySelectorAll<HTMLElement>("[data-assistant-citation-source]"),
    ].find(
      (element) =>
        element.dataset.assistantCitationSource === message.id &&
        element.dataset.assistantCitationThread === threadRef.threadId &&
        element.dataset.assistantCitationEnvironment === threadRef.environmentId,
    );
    const opening = captureAssistantMessageOpening(source ?? null, message.text);
    if (!opening) return;
    onReplyToResponse(
      responseContextRecord({
        citation: { version: 1, ...threadRef, messageId: message.id, ...opening },
        itemId,
        subagents: readResponseSubagents(threadRef, itemId),
      }),
    );
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={reply}
            aria-label={gt("Reply to this response")}
          />
        }
      >
        <ReplyIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <T>Reply to this response</T>
      </TooltipPopup>
    </Tooltip>
  );
}
