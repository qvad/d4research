import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ScopedThreadRef,
} from "@d4research/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@d4research/client-runtime/state/runtime";
import { useState } from "react";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { TimelinePendingApprovalRow } from "../chat/TimelinePendingApprovalRow";
import { WorkLogBlock } from "../chat/WorkLog";
import { InlineButton } from "../ui/button";

/**
 * Nia's page draws its own transcript, so requests the provider raises inside Nia's thread have
 * no timeline row to appear in. Without this a turn waits on an approval nobody can see.
 */
export function NiaThreadRequests({
  threadRef,
  onOpenThread,
}: {
  threadRef: ScopedThreadRef;
  onOpenThread: () => void;
}) {
  const requests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(threadRef));
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState<ReadonlyArray<RuntimeRequestId>>([]);
  const [error, setError] = useState<string | null>(null);
  if (requests === null)
    return (
      <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
        Nia is waiting for you. Loading the request…
      </p>
    );
  if (requests.approvals.length === 0 && requests.userInputs.length === 0) return null;
  const onRespond = async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
    if (!canOperate || responding.includes(requestId)) return;
    setResponding((ids) => [...ids, requestId]);
    setError(null);
    const result = await respond({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, requestId, decision },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not send the decision.");
    }
    setResponding((ids) => ids.filter((id) => id !== requestId));
    return result;
  };
  return (
    <section aria-label="Nia needs your approval" className="px-4 py-3 text-sm">
      {requests.approvals.length > 0 ? (
        <WorkLogBlock>
          {requests.approvals.map((approval) => (
            <TimelinePendingApprovalRow
              key={approval.requestId}
              approval={approval}
              respondingRequestIds={responding}
              canOperateThread={canOperate}
              onRespondToApproval={onRespond}
            />
          ))}
        </WorkLogBlock>
      ) : null}
      {requests.userInputs.map((input) => (
        <div key={input.requestId} className="space-y-1 py-1">
          {input.questions.map((question) => (
            <p key={question.id} className="whitespace-pre-wrap wrap-anywhere select-text">
              {question.question}
            </p>
          ))}
          <InlineButton onClick={onOpenThread}>Answer in the thread view</InlineButton>
        </div>
      ))}
      {error !== null ? (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
