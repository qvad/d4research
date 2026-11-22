import {
  activeD4AgentMcpServers,
  isCompactionCommandMessage,
  parseGoalCommand,
  type OrchestrationV2ContextHandoff,
} from "@d4research/contracts";
import { describeTaskScopeRefusal, makeTaskScopeEvaluator } from "../d4Agent/D4AgentTaskScope.ts";
import * as D4AgentContext from "../d4Agent/D4AgentContext.ts";
import { NIA_USER_INSTRUCTIONS } from "@d4research/provider-core/server/d4AgentPolicy";
import { selectAppProviderHistory } from "./appProviderHistory.ts";
import { extractTrailingProviderHandoffContext } from "@d4research/shared/providerHandoffPrompt";
import * as HandoffMemory from "../handoffMemory.ts";
import { FetchHttpClient } from "effect/http";
import * as SecondBrainService from "../second-brain/SecondBrainService.ts";
import { modelSelectionsEqual } from "@d4research/shared/model";
import {
  deriveDevProviderCandidates,
  parseDevTrigger,
  providerDriverSupportsPipelineOrchestration,
} from "@d4research/shared/devPipeline";
import {
  buildResearchRunManifest,
  deriveResearchProviderCandidatesFromProviders,
  parseResearchTrigger,
} from "@d4research/shared/researchPipeline";
import { ServerSettingsService } from "../serverSettings.ts";
import { compressHandoffContextLocal } from "../handoffCompression.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { InlineDelegationRunner } from "../mcp/toolkits/research/inlineDelegation.ts";
import { buildResumeNote } from "../mcp/toolkits/research/runArtifacts.ts";
import { OrchestrationEventStore } from "../persistence/OrchestrationEventStore.ts";
import { expandProviderDevMessage, expandProviderResearchMessage } from "./PipelineMessage.ts";
import { tryRunInlineResearchTurn } from "./InlineResearchTurn.ts";
import { withPersistedSkillsContext } from "./ConfiguredSkills.ts";
import { extractTrailingEnabledSkillsContext } from "@d4research/shared/enabledSkillsContext";
import * as McpProviderSessions from "@d4research/provider-core/server/McpProviderSessions";
import { setActiveMcpTurn } from "../mcp/McpSessionRegistry.ts";
import { projectComposerContextForProvider } from "@d4research/shared/composerContextReferences";
import { classifyCodexManagedError } from "../provider/CodexManagedErrors.ts";
import { expandAssistantCitationsForProvider } from "@d4research/shared/assistantCitations";
import {
  CommandId,
  D4AgentError,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  latestProviderTurnForAttempt,
  withMessageSenderNote,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  RunId,
  RunAttemptId,
  NodeId,
  ThreadId,
  TurnId,
} from "@d4research/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import {
  CLAUDE_PROVIDER,
  CLAUDE_QUERY_ENDED_BEFORE_TURN_DETAIL,
} from "./Adapters/ClaudeAdapterV2.ts";
import { withTurnStartReservation, withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeRestoreMissingWorktree } from "../workspace/restoreMissingWorktree.ts";
import type * as TaskFolders from "../workspace/TaskFolders.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderUsageAnalytics from "./ProviderEventIngestor.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { canForkBusySourceNatively, isActiveRun } from "./CommandPolicy.ts";
import { contextBoundaryOrdinal, isScheduledFreshRun } from "./contextBoundary.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffBudget,
  attachmentTokenAllowance,
  estimateTextTokens,
  contextUsageForHandoff,
  historicalMessage,
  restoreHandoffHistory,
  latestNativeContextUsage,
} from "@d4research/provider-core/server/handoffBudget";
import { ContextHandoffBackgroundWorkError } from "@d4research/provider-core/server/failure";
import { makeHandoffCompactionRecovery } from "./HandoffCompactionRecovery.ts";
import { deliverContextHandoffs, withInlineContext } from "./ContextHandoffDelivery.ts";
import { isProviderCommand, outputInstructions } from "./runOutput.ts";
import * as ProviderAdapter from "@d4research/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@d4research/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import { unsentManualContinuationSource } from "@d4research/shared/orchestrationV2ManualContinuation";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  knownProviderFailureMessage,
  makeProviderFailure,
} from "@d4research/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import {
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";

export class ProviderTurnStartError extends Schema.TaggedError<ProviderTurnStartError>()(
  "ProviderTurnStartError",
  {
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
    attemptId: Schema.optional(RunAttemptId),
    rootNodeId: Schema.optional(NodeId),
  },
) {}

/** Runs that ended without completing: their provider turn may still project as running. */
const NON_COMPLETING_TERMINAL_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

export function abandonedProviderTurns(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
  run: Pick<OrchestrationV2Run, "ordinal">,
  providerThreadId: OrchestrationV2ProviderThread["id"],
) {
  const attemptsByRun = Map.groupBy(projection.attempts, (attempt) => attempt.runId);
  const abandonedRuns = new Map<string | null, OrchestrationV2Run>();
  for (const previous of projection.runs) {
    if (
      previous.ordinal >= run.ordinal ||
      previous.providerThreadId !== providerThreadId ||
      !NON_COMPLETING_TERMINAL_RUN_STATUSES.has(previous.status)
    ) {
      continue;
    }
    if (previous.activeAttemptId !== null) {
      abandonedRuns.set(previous.activeAttemptId, previous);
    }
    for (const attempt of attemptsByRun.get(previous.id) ?? []) {
      abandonedRuns.set(attempt.id, previous);
    }
  }
  return projection.providerTurns.flatMap((turn) => {
    const previous = abandonedRuns.get(turn.runAttemptId);
    return turn.providerThreadId === providerThreadId &&
      turn.status === "running" &&
      previous !== undefined
      ? [{ turn, run: previous }]
      : [];
  });
}

export const isProviderTurnStartError = Schema.is(ProviderTurnStartError);
const isProviderAdapterProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);
const isD4AgentError = Schema.is(D4AgentError);
const isProviderAdapterOpenSessionError = Schema.is(
  ProviderAdapter.ProviderAdapterOpenSessionError,
);

/**
 * Claude refuses these before it reads the prompt: replacing a process running background work,
 * launch arguments whose appended system prompt or settings cannot be read, or MCP registration
 * that never answers while the query opens. A query that ends before the turn attaches (such as a
 * rejected resume point) never received the prompt either.
 */
const PROMPT_REFUSAL_TAGS = [
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  "ClaudeAppendSystemPromptFileError",
  "ClaudeAppendSystemPromptMissingValueError",
  "ClaudeSettingsLaunchArgError",
  "ClaudeMcpRegistrationTimeoutError",
] as const;

const refusedBeforePrompt = (error: unknown): boolean =>
  PROMPT_REFUSAL_TAGS.some((tag) => Predicate.isTagged(error, tag)) ||
  (isProviderAdapterProtocolError(error) &&
    error.driver === CLAUDE_PROVIDER &&
    error.detail === CLAUDE_QUERY_ENDED_BEFORE_TURN_DETAIL) ||
  (Predicate.hasProperty(error, "cause") && refusedBeforePrompt(error.cause));

/**
 * Whether a non-truncating provider's native session lost the conversation kept before `run`.
 * Rollback resets it: the newest accepted turn was rolled back (works without legacy-missing
 * native ids) or ran under another native id (rollback of runs the provider never accepted).
 */
const nativeSessionMissesKeptTurns = (
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "attempts" | "providerTurns" | "contextHandoffs"
  >,
  providerThread: OrchestrationV2ProviderThread,
  run: OrchestrationV2Run,
): boolean => {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  if (nativeId === undefined) return false;
  const acceptedAttemptIds = new Set(projection.providerTurns.map((turn) => turn.runAttemptId));
  const accepted = projection.attempts.filter((attempt) => acceptedAttemptIds.has(attempt.id));
  const runsById = new Map(projection.runs.map((source) => [source.id, source]));
  const ordinalOf = (attempt: OrchestrationV2RunAttempt) =>
    runsById.get(attempt.runId)?.ordinal ?? 0;
  const newest = accepted
    .filter((attempt) => attempt.providerThreadId === providerThread.id)
    .toSorted((a, b) => ordinalOf(a) - ordinalOf(b) || a.attemptOrdinal - b.attemptOrdinal)
    .at(-1);
  if (newest === undefined) return false;
  // Inherited fork history is kept even when every local run was rolled back.
  const keepsHistory =
    (projection.thread.forkedFrom?.type === "run" && projection.thread.lineage.sideChat !== true) ||
    accepted.some((attempt) => {
      const source = runsById.get(attempt.runId);
      return (
        source !== undefined && source.ordinal < run.ordinal && source.status !== "rolled_back"
      );
    });
  return (
    keepsHistory &&
    (runsById.get(newest.runId)?.status === "rolled_back" ||
      (newest.nativeThreadId !== undefined && newest.nativeThreadId !== nativeId)) &&
    !projection.contextHandoffs.some(
      (handoff) =>
        handoff.toProviderThreadId === providerThread.id &&
        handoff.delivery?.nativeThreadId === nativeId &&
        handoff.delivery.status !== "pending",
    )
  );
};

/** Missing execution records cannot be repaired by retrying a start. */
export class ProviderTurnStartRunStateMissingError extends Schema.TaggedError<ProviderTurnStartRunStateMissingError>()(
  "ProviderTurnStartRunStateMissingError",
  {
    runId: RunId,
  },
) {}

export const isProviderTurnStartRunStateMissingError = Schema.is(
  ProviderTurnStartRunStateMissingError,
);

const RESUME_PROMPT = "Continue where you left off.";

const START_GAVE_UP_MESSAGE =
  "T3 Code could not start this turn. Send the message again; if it keeps failing, check the server logs.";

const startFailureMessage = (error: Error): string => {
  const nestedCause = "cause" in error ? error.cause : undefined;
  return (
    knownProviderFailureMessage(error) ??
    (nestedCause instanceof Error
      ? nestedCause.message
      : typeof nestedCause === "string"
        ? nestedCause
        : error.message)
  );
};

export interface ProviderTurnStartServiceV2Shape {
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
  }) => Effect.Effect<void, ProviderTurnStartError>;
  readonly failStartingRun: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly attemptId: RunAttemptId;
    readonly rootNodeId: NodeId;
  }) => Effect.Effect<void, ProviderTurnStartError | ProviderTurnStartRunStateMissingError>;
}

export class ProviderTurnStartServiceV2 extends Context.Service<
  ProviderTurnStartServiceV2,
  ProviderTurnStartServiceV2Shape
>()("d4research/orchestration-v2/ProviderTurnStartService/ProviderTurnStartServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnStartServiceV2,
  never,
  | SecondBrainService.SecondBrainService
  | EventSink.EventSinkV2
  | ContextHandoffService.ContextHandoffServiceV2
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectService.ProjectService
  | ProviderAuthService.ProviderAuthService
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunExecutionService.RunExecutionServiceV2
  | RuntimePolicy.RuntimePolicyV2
  | ServerSettingsService
  | ProviderRegistry
  | McpProviderSessions.McpProviderSessions
  | InlineDelegationRunner
  | OrchestrationEventStore
  | TurnItemPositionStore.TurnItemPositionStoreV2
  | TaskFolders.TaskFolders
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const handoffMemory = yield* HandoffMemory.HandoffMemory;
    const eventSink = yield* EventSink.EventSinkV2;
    const turnAnalytics = yield* ProviderUsageAnalytics.ProviderTurnAnalytics;
    const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const brain = yield* SecondBrainService.SecondBrainService;
    const projects = yield* ProjectService.ProjectService;
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const mcpProviderSessions = yield* McpProviderSessions.McpProviderSessions;
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    const providerRegistry = yield* ProviderRegistry;
    const d4AgentContext = yield* Effect.serviceOption(D4AgentContext.D4AgentContext);
    const currentTaskScopeStatus = yield* makeTaskScopeEvaluator;
    const researchServices = yield* Effect.context<
      InlineDelegationRunner | OrchestrationEventStore
    >();
    const restoreMissingWorktree = yield* makeRestoreMissingWorktree;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;

    // Build draining callbacks outside startup scope so they cannot retain full thread history.
    const makeRunControls = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly attemptId: OrchestrationV2RunAttempt["id"];
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly runOrdinal: number;
      readonly worktreePath: string | null;
      readonly inheritedBackgroundTurnItems: ReturnType<
        typeof RunExecutionService.selectInheritedBackgroundTurnItems
      >;
    }) => {
      const isCurrentAttemptIn = (statuses: ReadonlyArray<OrchestrationV2Run["status"]>) =>
        projectionStore
          .getRun(input.threadId, input.runId)
          .pipe(
            Effect.map(
              (run) => run?.activeAttemptId === input.attemptId && statuses.includes(run.status),
            ),
          );
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        isCurrentAttemptIn([expectedStatus]);
      return {
        isCurrentAttemptInStatus,
        loadInheritedBackgroundTurnItems: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) =>
              RunExecutionService.selectInheritedBackgroundTurnItems({
                threadId: input.threadId,
                currentProviderThreadId: input.providerThreadId,
                currentRunOrdinal: input.runOrdinal,
                runs: current.runs,
                turnItems: current.turnItems,
              }),
            ),
            Effect.catchCause(() => Effect.succeed(input.inheritedBackgroundTurnItems)),
          ),
        shouldStartProviderTurn: () => isCurrentAttemptInStatus("running"),
        shouldFinalizeRun: () => isCurrentAttemptIn(["starting", "running"]),
        hasUnpairedRunInterruptRequest: () =>
          projectionStore
            .hasUnpairedRunInterruptRequest(
              input.threadId,
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-request",
              }),
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-result",
              }),
            )
            .pipe(Effect.catchCause(() => Effect.succeed(false))),
        hasWorkspaceMoved: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) => current.thread.worktreePath !== input.worktreePath),
            Effect.catchCause(() => Effect.succeed(false)),
          ),
        loadUnsettledWork: (threadId: ThreadId, nodeIds: ReadonlyArray<NodeId>) =>
          projectionStore
            .getThreadRecords(threadId, ["subagents", "nodes", "turnItems"], {
              nodeIds,
              subagentIds: nodeIds,
              turnItemStatuses: ["pending", "running", "waiting"],
            })
            .pipe(
              Effect.catchTags({
                ProjectionStoreThreadNotFoundError: () =>
                  Effect.succeed({ subagents: [], nodes: [], turnItems: [] }),
              }),
            ),
        loadRunInterruptReason: () =>
          projectionStore
            .getThreadRecords(input.threadId, ["turnItems"], {
              turnItemTypes: ["run_interrupt_request"],
              turnItemRunIds: [input.runId],
            })
            .pipe(
              Effect.map(({ turnItems }) => {
                const request = turnItems.find((item) => item.type === "run_interrupt_request");
                return request?.type === "run_interrupt_request" ? request.message : undefined;
              }),
              Effect.catchCause(() => Effect.undefined),
            ),
      };
    };

    const makeDeliverySession = (
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      startWithHandoffs: (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact?: boolean,
      ) => ReturnType<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>,
    ) => {
      let deliver: typeof startWithHandoffs | undefined = startWithHandoffs;
      const start = (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact = false,
      ) =>
        Effect.suspend(() => {
          if (deliver !== undefined) return deliver(input, compact);
          return compact && session.compactThread !== undefined
            ? session.compactThread(input)
            : session.startTurn(input);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              deliver = undefined;
            }),
          ),
        );
      return {
        ...session,
        startTurn: (input: Parameters<typeof session.startTurn>[0]) => start(input),
        ...(session.resumeTurn === undefined
          ? {}
          : {
              resumeTurn: (input: ProviderAdapter.ProviderAdapterV2ResumeTurnInput) =>
                start(ProviderAdapter.resumeTurnInput(input)),
            }),
        ...(session.compactThread === undefined
          ? {}
          : {
              compactThread: (input: Parameters<typeof session.startTurn>[0]) => start(input, true),
            }),
      };
    };

    const settleRunBeforeStart = Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(
      function* (input: {
        readonly run: OrchestrationV2Run;
        readonly rootNode: OrchestrationV2ExecutionNode;
        readonly attempt: OrchestrationV2RunAttempt;
        readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly signal: string;
        readonly status: "completed" | "failed";
        readonly now: DateTime.Utc;
        readonly startedAt?: DateTime.Utc;
        readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
        readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"] | null;
        readonly item:
          | Pick<Extract<OrchestrationV2TurnItem, { type: "error" }>, "type" | "title" | "failure">
          | Pick<
              Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
              "type" | "title" | "input" | "output" | "exitCode"
            >;
        readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
      }) {
        const { run, rootNode, attempt, turnItems, now, status } = input;
        const runId = run.id;
        const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
        const item: OrchestrationV2TurnItem = {
          id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
          threadId: run.threadId,
          runId,
          nodeId: rootNode.id,
          providerThreadId: input.itemProviderThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal:
            Math.max(
              0,
              ...turnItems.filter((item) => item.runId === runId).map((item) => item.ordinal),
            ) + 1,
          status,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          ...input.item,
        };
        const eventPayloads = [
          { type: "turn-item.updated", payload: item },
          { type: "run.updated", payload: { ...run, status, ...started, completedAt: now } },
          {
            type: "run-attempt.updated",
            payload: { ...attempt, status, ...started, completedAt: now },
          },
          {
            type: "node.updated",
            payload: { ...rootNode, status, ...started, completedAt: now },
          },
          ...(input.providerThreadUpdate === undefined
            ? []
            : [
                {
                  type: "provider-thread.updated" as const,
                  payload: input.providerThreadUpdate,
                },
              ]),
        ] as const;
        const events = yield* Effect.forEach(eventPayloads, (event) =>
          Effect.gen(function* () {
            return {
              ...event,
              id: yield* idAllocator.allocate.event({ threadId: run.threadId }),
              threadId: run.threadId,
              runId,
              nodeId: rootNode.id,
              providerInstanceId: input.providerInstanceId,
              occurredAt: now,
            } satisfies OrchestrationV2DomainEvent;
          }),
        );
        const written = yield* eventSink.writeIfRunCurrent({
          threadId: run.threadId,
          runId,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events,
        });
        // A steering restart that cannot start still ends a run whose earlier turns counted.
        if (written.committed) {
          yield* turnAnalytics.runSettled({
            runId,
            status,
            completedAt: now,
            childrenRunning: false,
          });
        }
      },
    );

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (
      input: {
        readonly threadId: ThreadId;
        readonly runId: RunId;
        readonly willRetry?: boolean;
      },
      captureStartingRun: (run: OrchestrationV2Run) => void,
    ) {
      const { runId } = input;
      const projection = yield* projectionStore.getTurnStartContext(input.threadId, runId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* new ProviderTurnStartError({ runId, cause: `Run ${runId} was not found.` });
      }
      if (run.status !== "starting") {
        return;
      }
      captureStartingRun(run);
      const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      const checkpointScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === rootNode?.checkpointScopeId,
      );
      // Older versions also stored subagent replies as history handoffs. Their
      // queued completion messages carry the results without a history budget.
      const subagentResultTransfers = new Set(
        projection.contextTransfers
          .filter((transfer) => transfer.type === "subagent_result")
          .map((transfer) => transfer.id),
      );
      const isPendingForRun = (handoff: OrchestrationV2ContextHandoff, anyProviderThread = false) =>
        handoff.status === "ready" &&
        (handoff.targetRunId === run.id ||
          ((anyProviderThread || handoff.toProviderThreadId === run.providerThreadId) &&
            projection.runs.some(
              (source) =>
                source.id === handoff.targetRunId &&
                // A settled delivery retires history of this thread: the session that took it
                // holds it, and a fresh session starts from a full summary of the thread. That
                // summary lacks another thread's history (a fork source, a merge-back).
                (((source.status === "failed" ||
                  source.status === "interrupted" ||
                  source.status === "cancelled") &&
                  !(
                    (handoff.delivery?.status === "injected" ||
                      handoff.delivery?.status === "inline") &&
                    handoff.fromProviderThreadIds.length > 0 &&
                    handoff.fromProviderThreadIds.every((id) =>
                      projection.providerThreads.some((candidate) => candidate.id === id),
                    )
                  )) ||
                  (source.status === "completed" &&
                    handoff.delivery === undefined &&
                    // Compaction and /goal turns defer history to the next turn.
                    projection.messages.some(
                      (message) =>
                        message.id === source.userMessageId &&
                        (isCompactionCommandMessage(message) || parseGoalCommand(message) !== null),
                    ))),
            )));
      const isSideChatHandoff = (handoff: OrchestrationV2ContextHandoff) =>
        projection.thread.lineage.sideChat === true &&
        ContextHandoffService.isSideChatContextHandoff(handoff);
      const handoffs = projection.contextHandoffs.filter(
        (handoff) =>
          !isSideChatHandoff(handoff) &&
          (handoff.transferId == null || !subagentResultTransfers.has(handoff.transferId)) &&
          isPendingForRun(handoff),
      );
      // Carried forward until a provider turn accepts them, also after a provider switch. A fresh
      // session starts without them, and an unscheduled fresh run retires them. A schedule's fresh
      // run is a side conversation, so the thread's next turn still gets them.
      const carriedSideChatHandoffs = projection.contextHandoffs.filter(
        (handoff) =>
          isSideChatHandoff(handoff) &&
          handoff.delivery === undefined &&
          isPendingForRun(handoff, true),
      );
      const sideChatHandoff = run.freshContext === true ? undefined : carriedSideChatHandoffs[0];
      const nativeForkTransfer = projection.contextTransfers.find(
        (transfer) =>
          transfer.type === "fork" &&
          transfer.targetThreadId === input.threadId &&
          transfer.targetRunId === run.id &&
          transfer.status === "pending" &&
          transfer.resolution === null,
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        message === undefined ||
        checkpointScope === undefined
      ) {
        return yield* new ProviderTurnStartError({
          runId,
          cause: `Run ${runId} is missing its execution projection state.`,
        });
      }
      if (
        carriedSideChatHandoffs.length > 0 &&
        run.freshContext === true &&
        !isScheduledFreshRun(run, projection.turnItems)
      ) {
        const updatedAt = yield* DateTime.now;
        const retired = yield* eventSink.writeIfRunCurrent({
          threadId: run.threadId,
          runId,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: yield* Effect.forEach(carriedSideChatHandoffs, (handoff) =>
            Effect.map(idAllocator.allocate.event({ threadId: projection.thread.id }), (id) => ({
              id,
              type: "context-handoff.updated" as const,
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: updatedAt,
              payload: { ...handoff, status: "superseded" as const, updatedAt },
            })),
          ),
        });
        if (!retired.committed) return;
      }
      const manualResume =
        run.manualContinuationOfRunId !== undefined && attempt.reason !== "steering_restart";
      const resumeSource = manualResume
        ? unsentManualContinuationSource(run, projection)
        : undefined;
      const unsentResumeMessage =
        resumeSource !== undefined
          ? projection.messages.find((source) => source.id === resumeSource.userMessageId)
          : undefined;
      const providerMessage = unsentResumeMessage ?? message;
      const settleStartFailure = Effect.fn("ProviderTurnStartService.settleStartFailure")(
        function* (failed: {
          readonly signal: string;
          readonly title: string;
          readonly error: Error;
          readonly message?: string;
        }) {
          yield* settleRunBeforeStart({
            run,
            rootNode,
            attempt,
            turnItems: projection.turnItems,
            signal: failed.signal,
            status: "failed",
            now: yield* DateTime.now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: failed.title,
              failure: makeProviderFailure({
                cause: failed.error,
                message: failed.message ?? startFailureMessage(failed.error),
                class: "provider_error",
              }),
            },
          });
        },
      );
      const scopedAgentTask = String(projection.thread.id).startsWith("d4-action:");
      const isNiaChatThread = Option.isSome(d4AgentContext)
        ? d4AgentContext.value.isChatThread === undefined
          ? yield* d4AgentContext.value.owns(projection.thread.id)
          : yield* d4AgentContext.value.isChatThread(projection.thread.id)
        : false;
      const isNiaUserTurn =
        // Task threads and server-created messages must never inherit the interactive chat policy.
        !scopedAgentTask &&
        message.createdBy === "user" &&
        isNiaChatThread &&
        // DeepSeek exposes Nia tools only through its restricted manager loop.
        ["codex", "claudeAgent", "pi", "opencode"].includes(providerThread.driver);
      // Interactive tool permissions do not replace context validation or scoped prompt data.
      const d4AgentContextText = Option.isSome(d4AgentContext)
        ? yield* d4AgentContext.value.prepare(
            projection.thread.id,
            run.modelSelection,
            providerThread.providerSessionId,
          )
        : null;
      const settings = yield* serverSettings.getSettings;
      // A refused scope is a final answer, not a transient fault. Throwing here
      // made the effect worker retry, give up, and leave the run `starting`
      // forever; settling it failed tells the caller why at once.
      const taskScope = yield* currentTaskScopeStatus(
        projection.thread.id,
        settings.d4Agent,
        settings,
      );
      if (
        expandAssistantCitationsForProvider(providerMessage.text).length >
        PROVIDER_SEND_TURN_MAX_INPUT_CHARS
      ) {
        yield* settleRunBeforeStart({
          run,
          rootNode,
          attempt,
          turnItems: projection.turnItems,
          signal: "expanded-input-too-long",
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Message is too long",
            failure: makeProviderFailure({
              class: "validation_error",
              message: `Message exceeds ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")} characters after expanding quotes. Shorten it and try again.`,
            }),
          },
        });
        return;
      }
      const scopeRefusal =
        taskScope === null
          ? null
          : taskScope.status !== "ok"
            ? describeTaskScopeRefusal(taskScope)
            : taskScope.record.projectId !== projection.thread.projectId
              ? "This task belongs to a different project than its thread, so it cannot start."
              : null;
      if (scopeRefusal !== null) {
        yield* settleRunBeforeStart({
          run,
          rootNode,
          attempt,
          turnItems: projection.turnItems,
          signal: "task-scope-refused",
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Task scope refused",
            failure: makeProviderFailure({ message: scopeRefusal }),
          },
        });
        return;
      }
      const providers = yield* providerRegistry.getProviders;
      const nextOrdinal =
        Math.max(
          0,
          ...projection.turnItems
            .filter((item) => item.runId === runId)
            .map((item) => item.ordinal),
        ) + 1;
      if (
        d4AgentContextText === null &&
        (yield* tryRunInlineResearchTurn({
          run,
          attempt,
          rootNode,
          message,
          providers,
          checkpointScopeId: checkpointScope.id,
          preparePrompt: (text) => Effect.succeed(withPersistedSkillsContext(text, message.text)),
          shareMemoContext: settings.research.shareMemoContext,
          nextOrdinal,
        }).pipe(
          Effect.provideContext(researchServices),
          Effect.provideService(EventSink.EventSinkV2, eventSink),
          Effect.provideService(IdAllocator.IdAllocatorV2, idAllocator),
        ))
      )
        return;
      const acceptedPrompt = extractTrailingEnabledSkillsContext(providerMessage.text).promptText;
      const pipelinePrompt = acceptedPrompt.startsWith("Ultrathink:\n")
        ? acceptedPrompt.slice("Ultrathink:\n".length)
        : acceptedPrompt;
      const pipelineKind =
        d4AgentContextText !== null
          ? null
          : parseDevTrigger(pipelinePrompt) !== null
            ? "development"
            : parseResearchTrigger(pipelinePrompt) !== null
              ? "research"
              : null;
      const selectedProvider = providers.find(
        (provider) => provider.instanceId === run.providerInstanceId,
      );
      if (
        pipelineKind !== null &&
        (!selectedProvider ||
          !providerDriverSupportsPipelineOrchestration(String(selectedProvider.driver)))
      ) {
        yield* settleRunBeforeStart({
          run,
          rootNode,
          attempt,
          turnItems: projection.turnItems,
          signal: "pipeline-unavailable",
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Pipeline unavailable",
            failure: makeProviderFailure({
              message:
                "The selected provider cannot orchestrate pipelines because it does not expose MCP tools.",
            }),
          },
        });
        return;
      }
      const researchCandidates = deriveResearchProviderCandidatesFromProviders(providers);
      const manifest =
        d4AgentContextText !== null
          ? null
          : buildResearchRunManifest(
              pipelinePrompt,
              settings.research,
              researchCandidates,
              settings.pipelineTargetPolicy,
            );
      if (manifest !== null) {
        const now = yield* DateTime.now;
        const written = yield* eventSink.writeIfRunCurrent({
          threadId: message.threadId,
          runId,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: message.threadId }),
              threadId: message.threadId,
              runId,
              nodeId: rootNode.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              type: "turn-item.updated",
              payload: {
                id: idAllocator.derive.runSignalTurnItem({ runId, signal: "research-manifest" }),
                threadId: message.threadId,
                runId,
                nodeId: rootNode.id,
                providerThreadId: providerThread.id,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: nextOrdinal,
                status: "completed",
                startedAt: now,
                updatedAt: now,
                completedAt: now,
                type: "system_notice",
                title: "Research run",
                message: `Research scenario ${manifest.scenario} started`,
                activity: {
                  kind: "research.run.started",
                  payload: { messageId: String(message.id), ...manifest },
                },
              },
            },
          ],
        });
        if (!written.committed) return;
      }
      const providerMessageText =
        d4AgentContextText !== null
          ? message.text
          : withPersistedSkillsContext(
              expandProviderResearchMessage(
                expandProviderDevMessage(
                  acceptedPrompt,
                  settings.dev,
                  deriveDevProviderCandidates(providers),
                  settings.pipelineTargetPolicy,
                ),
                settings.research,
                researchCandidates,
                settings.pipelineTargetPolicy,
              ),
              message.text,
            );
      if (
        d4AgentContextText === null &&
        message.attachments.length === 0 &&
        acceptedPrompt.trimStart().startsWith("/")
      ) {
        const isEmptyCompaction =
          acceptedPrompt.trim().toLowerCase() === "/compact" && !projection.hasConversation;
        // Preparing a run may already point the thread at a newly selected
        // provider. Account commands still belong to its last native session.
        const nativeThreads = new Map(
          projection.providerThreads
            .filter(
              (candidate) => candidate.ownerNodeId === null && candidate.nativeThreadRef !== null,
            )
            .map((candidate) => [candidate.id, candidate]),
        );
        const previousNativeRun = projection.runs.reduce<OrchestrationV2Run | undefined>(
          (previous, candidate) =>
            candidate.ordinal < run.ordinal &&
            candidate.providerThreadId !== null &&
            nativeThreads.has(candidate.providerThreadId) &&
            (previous === undefined || candidate.ordinal > previous.ordinal)
              ? candidate
              : previous,
          undefined,
        );
        const nativeThread = nativeThreads.get(
          previousNativeRun?.providerThreadId ??
            projection.thread.activeProviderThreadId ??
            providerThread.id,
        );
        const authInstanceId = nativeThread?.providerInstanceId ?? run.providerInstanceId;
        const authResult = isEmptyCompaction
          ? null
          : yield* Effect.result(
              providerAuth.tryHandlePromptCommand({
                instanceId: authInstanceId,
                text: projectComposerContextForProvider({
                  text: acceptedPrompt,
                  records: providerMessage.context?.records ?? [],
                }),
                hasAttachments: false,
                // A scheduled delivery keeps its task author's createdBy.
                sentByPerson:
                  providerMessage.createdBy === "user" &&
                  providerMessage.scheduledTaskId === undefined,
              }),
            );
        if (isEmptyCompaction || authResult?._tag === "Failure" || authResult?.success) {
          const now = yield* DateTime.now;
          const failure = isEmptyCompaction
            ? makeProviderFailure({
                class: "validation_error",
                message: "Start a conversation before compacting this thread.",
              })
            : authResult?._tag === "Failure"
              ? makeProviderFailure({
                  class: "permission_error",
                  message: authResult.failure.detail,
                })
              : undefined;
          const status = failure === undefined ? "completed" : "failed";
          yield* settleRunBeforeStart({
            run,
            rootNode,
            attempt,
            turnItems: projection.turnItems,
            signal: isEmptyCompaction ? "empty-compaction" : "provider-sign-out",
            status,
            now,
            startedAt: now,
            providerInstanceId: authInstanceId,
            itemProviderThreadId: nativeThread?.id ?? providerThread.id,
            item:
              failure !== undefined
                ? {
                    type: "error",
                    title: isEmptyCompaction
                      ? "Cannot compact an empty thread"
                      : "Provider sign-out failed",
                    failure,
                  }
                : {
                    type: "command_execution",
                    title: "Provider signed out",
                    input: acceptedPrompt.trim(),
                    output: "Provider signed out",
                    exitCode: 0,
                  },
            providerThreadUpdate: {
              ...providerThread,
              status:
                providerThread.status === "error"
                  ? "error"
                  : providerThread.nativeThreadRef === null
                    ? "not_loaded"
                    : "idle",
              updatedAt: now,
            },
          });
          return;
        }
      }
      const recreateResult = yield* Effect.result(restoreMissingWorktree(projection.thread));
      if (recreateResult._tag === "Failure") {
        if (input.willRetry === true) return yield* recreateResult.failure;
        yield* settleStartFailure({
          signal: "worktree-recreate-failure",
          title: "Couldn't recreate thread workspace",
          error: recreateResult.failure,
          message: recreateResult.failure.message,
        });
        return;
      }
      const selectInheritedBackgroundItems = (
        current: ProjectionStore.ProjectionRuntimeRecoveryState,
      ): ReturnType<typeof RunExecutionService.selectInheritedBackgroundTurnItems> =>
        RunExecutionService.selectInheritedBackgroundTurnItems({
          threadId: current.thread.id,
          currentProviderThreadId: providerThread.id,
          currentRunOrdinal: run.ordinal,
          runs: current.runs,
          turnItems: current.turnItems,
        });
      const recoveryResult = yield* Effect.result(
        projectionStore.getRuntimeRecoveryProjection(projection.thread.id),
      );
      if (recoveryResult._tag === "Failure") {
        if (input.willRetry === true) return yield* recoveryResult.failure;
        yield* settleStartFailure({
          signal: "runtime-recovery-read-failure",
          title: "Couldn't read thread state",
          error: recoveryResult.failure,
        });
        return;
      }
      const inheritedBackgroundTurnItems = selectInheritedBackgroundItems(recoveryResult.success);
      const providerSessionId = providerThread.providerSessionId;
      const runControls = makeRunControls({
        threadId: projection.thread.id,
        runId: run.id,
        attemptId: attempt.id,
        providerThreadId: providerThread.id,
        runOrdinal: run.ordinal,
        worktreePath: projection.thread.worktreePath,
        inheritedBackgroundTurnItems,
      });
      const { isCurrentAttemptInStatus } = runControls;

      const resolvedPolicy = yield* runtimePolicy
        .resolve({
          thread: projection.thread,
          modelSelection: run.modelSelection,
        })
        .pipe(Effect.result);
      if (resolvedPolicy._tag === "Failure") {
        const error = resolvedPolicy.failure;
        if (error._tag !== "RuntimePolicyAboveCeilingError") return yield* error;
        yield* settleStartFailure({
          signal: "runtime-mode-above-ceiling",
          title: "Thread mode is above the policy limit",
          error,
        });
        return;
      }
      const resolvedRuntimePolicy = isNiaUserTurn
        ? {
            ...resolvedPolicy.success,
            ...(resolvedPolicy.success.maxRuntimeMode === undefined ||
            resolvedPolicy.success.maxRuntimeMode === "full-access"
              ? {
                  runtimeMode: "full-access" as const,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "dangerFullAccess" },
                }
              : {}),
            cwd:
              (Option.isSome(d4AgentContext) ? d4AgentContext.value.homeDirectory : undefined) ??
              resolvedPolicy.success.cwd,
            additionalInstructions: NIA_USER_INSTRUCTIONS,
          }
        : d4AgentContextText === null
          ? resolvedPolicy.success
          : {
              ...resolvedPolicy.success,
              runtimeMode: "approval-required" as const,
              interactionMode: "default" as const,
              toolPolicy: "d4-agent" as const,
              d4AgentMcpServers: activeD4AgentMcpServers(settings.d4Agent),
              approvalPolicy: "never",
              sandboxPolicy: { type: "readOnly", networkAccess: false },
            };

      if (!(yield* isCurrentAttemptInStatus("starting"))) return;
      const existingSessionProjection = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      // A run that ended without completing can leave its provider turn projected as
      // running when the agent ignored Stop or an interrupt timed out. Every attempt
      // of such a run owns a possible abandoned turn, including attempts a steering
      // restart superseded, and the session cannot be reused until those turns stop.
      const abandonedTurns = abandonedProviderTurns(projection, run, providerThread.id);
      const abandonedTurn = abandonedTurns.at(-1)?.turn;
      if (abandonedTurn !== undefined) {
        const liveSession = yield* providerSessions.get(providerSessionId);
        if (Option.isSome(liveSession)) {
          // The run already ended without stopping its provider — a failed start, an
          // ignored Stop, or an interrupt that never confirmed. Recover that exact
          // turn before reusing its native conversation.
          const recovered = yield* Effect.result(
            liveSession.value.interruptTurn({
              providerThread,
              providerTurnId: abandonedTurn.id,
              requestRuntimeRestart: true,
            }),
          );
          if (recovered._tag === "Failure") {
            if (input.willRetry === true) return yield* recovered.failure;
            yield* settleStartFailure({
              signal: "provider-turn-recovery-failure",
              title: "Provider turn recovery failed",
              error: recovered.failure,
            });
            return;
          }
        }
        const completedAt = yield* DateTime.now;
        const repaired = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: yield* Effect.forEach(abandonedTurns, ({ turn, run: abandonedRun }) =>
            Effect.gen(function* () {
              return {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "provider-turn.updated" as const,
                threadId: projection.thread.id,
                runId: abandonedRun.id,
                nodeId: turn.nodeId,
                providerInstanceId: abandonedRun.providerInstanceId,
                occurredAt: completedAt,
                payload: { ...turn, status: "interrupted" as const, completedAt },
              };
            }),
          ),
        });
        if (!repaired.committed) return;
      }
      // Opening a session does not prompt the provider, so the workspace is still unchanged.
      const baseline = yield* runExecution.forkBaseline({
        appThread: projection.thread,
        run,
        checkpointScope,
      });
      const brokenNativeThread = providerThread.status === "error";
      // Opened without the broken native id, a session that was not live starts fresh.
      const opensFreshSession =
        brokenNativeThread &&
        providerThread.nativeThreadRef !== null &&
        !(yield* providerSessions.isLive(providerSessionId));
      const sessionResult = yield* Effect.result(
        providerSessions.open({
          threadId: projection.thread.id,
          providerSessionId,
          modelSelection: run.modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
          ...(existingSessionProjection === undefined
            ? {}
            : { resumeFromSession: existingSessionProjection }),
          ...(providerThread.nativeThreadRef?.nativeId == null || brokenNativeThread
            ? {}
            : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
          ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        }),
      );
      if (sessionResult._tag === "Failure") {
        const failure = sessionResult.failure;
        const requiresSignIn =
          "cause" in failure &&
          isProviderAdapterOpenSessionError(failure.cause) &&
          failure.cause.requiresSignIn === true;
        if (input.willRetry === true && !requiresSignIn) return yield* failure;
        yield* settleStartFailure({
          signal: "provider-session-open-failure",
          title: "Provider session failed to open",
          error: sessionResult.failure,
        });
        return;
      }
      const session = sessionResult.success;
      if (!(yield* isCurrentAttemptInStatus("starting"))) return;
      const loadFromProvider = Effect.fn("ProviderTurnStartService.loadFromProvider")(function* (
        load: Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapter.ProviderAdapterV2Error>,
      ) {
        const loaded = yield* Effect.result(load);
        if (loaded._tag === "Success") return loaded.success;
        if (input.willRetry === true) return yield* loaded.failure;
        yield* settleStartFailure({
          signal: "provider-thread-load-failure",
          title: "Provider turn failed to start",
          error: loaded.failure,
        });
        return undefined;
      });
      let effectiveHandoffs = handoffs;
      let resumeFellBack = false;
      const messageText = withMessageSenderNote(
        providerMessage,
        projectComposerContextForProvider({
          text: providerMessageText,
          records: providerMessage.context?.records ?? [],
        }),
      );
      // Native goal commands go verbatim; handoff history waits a turn.
      const goalDriver =
        session.driver === "codex" ||
        session.driver === "claudeAgent" ||
        session.providerSession.capabilities.turns.supportsNativeGoals === true;
      const goalCommand = goalDriver && parseGoalCommand(providerMessage) !== null;
      // Part of the user text, so every way a turn starts carries it, after the user's own words.
      const userText =
        run.outputSchema === undefined || goalCommand || isProviderCommand(providerMessage)
          ? messageText
          : `${messageText}\n\n${outputInstructions(run.outputSchema)}`;
      const saveHandoff = (text: string) =>
        handoffMemory.schedule({ text, threadId: input.threadId }, (receipt) =>
          Effect.gen(function* () {
            const current = yield* projectionStore.getThreadProjection(input.threadId);
            const now = yield* DateTime.now;
            yield* eventSink.write({
              events: [
                {
                  id: yield* idAllocator.allocate.event({ threadId: input.threadId }),
                  type: "turn-item.updated",
                  threadId: input.threadId,
                  runId,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    id: idAllocator.derive.runSignalTurnItem({
                      runId,
                      signal: "meko-handoff-failed",
                    }),
                    threadId: input.threadId,
                    runId,
                    nodeId: rootNode.id,
                    providerThreadId: providerThread.id,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal:
                      Math.max(
                        0,
                        ...current.turnItems
                          .filter((item) => item.runId === runId)
                          .map((item) => item.ordinal),
                      ) + 1,
                    status: "completed",
                    startedAt: now,
                    updatedAt: now,
                    completedAt: now,
                    type: "system_notice",
                    title: "Meko handoff save was not verified",
                    message: receipt.message,
                    activity: { kind: "handoff.meko.failed", payload: { status: receipt.status } },
                  },
                },
              ],
            });
          }).pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Meko handoff receipt could not be recorded."),
            ),
          ),
        );
      const attachedHandoff = extractTrailingProviderHandoffContext(
        extractTrailingEnabledSkillsContext(userText).promptText,
      ).handoff;
      if (
        d4AgentContextText === null &&
        !scopedAgentTask &&
        settings.handoff.memoryBackend === "meko" &&
        attachedHandoff !== null
      )
        yield* saveHandoff(attachedHandoff.summary);
      // The provider turn marks cancellation work delivered; restart continuations use their own text or resume natively.
      const noteContinuation = isRestartNoteContinuation(
        run,
        projection.runs,
        projection.providerTurns,
        projection.attempts,
      );
      const restartCancelledWork = pendingRestartCancelledBackgroundWork({
        runs: projection.runs,
        providerTurns: projection.providerTurns,
        compactionMessageIds: () =>
          new Set(
            projection.messages
              .filter(
                (candidate) =>
                  isCompactionCommandMessage(candidate) ||
                  (goalDriver && parseGoalCommand(candidate) !== null),
              )
              .map((candidate) => candidate.id),
          ),
        run,
        attempts: projection.attempts,
      });
      // A pipeline run cut short by a restart, a stop, or a failure is
      // continued by the next plain message; the server ledger tells the
      // orchestrator what already ran so it does not delegate it again.
      const resumeNote =
        d4AgentContextText !== null
          ? ""
          : yield* Effect.gen(function* () {
              const project = yield* projects.getById(projection.thread.projectId).pipe(
                Effect.map(Option.getOrUndefined),
                Effect.orElseSucceed(() => undefined),
              );
              return yield* buildResumeNote({
                threadId: projection.thread.id,
                currentRunId: run.id,
                runs: projection.runs,
                messages: projection.messages,
                workspaceRoot: project?.workspaceRoot,
              });
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            );
      const restartNote = [
        restartCancelledWork.length === 0
          ? ""
          : restartCancelledBackgroundWorkNote(restartCancelledWork),
        resumeNote,
      ]
        .filter((part) => part !== "")
        .join("\n\n");
      const tokenCap = yield* handoffTokenCapConfig.pipe(
        Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
      );
      const handoffContextForThread = (loadedProviderThread: OrchestrationV2ProviderThread) => {
        const measuredContext = latestNativeContextUsage(projection, providerThread);
        const previousSelection =
          measuredContext?.modelSelection ??
          projection.runs.findLast(
            (source) =>
              source.ordinal < run.ordinal &&
              source.startedAt !== null &&
              source.providerThreadId === providerThread.id,
          )?.modelSelection;
        const sameSelection =
          previousSelection === undefined ||
          modelSelectionsEqual(previousSelection, run.modelSelection);
        const sameNativeThread =
          loadedProviderThread.nativeThreadRef?.nativeId ===
          providerThread.nativeThreadRef?.nativeId;
        const threadUsage = loadedProviderThread.contextUsage ?? providerThread.contextUsage;
        const previousUsage = measuredContext
          ? { ...threadUsage, ...measuredContext.usage }
          : threadUsage;
        const reuseTelemetry =
          sameSelection ||
          (previousSelection !== undefined &&
            session.canReuseContextUsage?.(previousSelection, run.modelSelection) === true);
        const knownModelWindow = session.getModelContextWindow?.(
          run.modelSelection,
          resolvedRuntimePolicy.cwd,
        );
        const handoffUsage = contextUsageForHandoff({
          sameNativeThread,
          sameSelection,
          reuseTelemetry,
          previousUsage,
          knownModelWindow,
        });
        const settledHandoffs = projection.contextHandoffs.filter(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status !== "pending",
        );
        const deliveredItemIds = new Set(
          settledHandoffs.flatMap((handoff) => handoff.delivery?.itemIds ?? []),
        );
        const coveredItemIds = new Set([
          ...deliveredItemIds,
          ...settledHandoffs.flatMap((handoff) => handoff.delivery?.omittedItemIds ?? []),
        ]);
        const deliveredAttemptIds = new Set(
          projection.providerTurns.map((turn) => turn.runAttemptId),
        );
        const acceptedAttempts = projection.attempts.filter(
          (source) =>
            source.providerThreadId === providerThread.id && deliveredAttemptIds.has(source.id),
        );
        const nativeInputRunIds = new Set(
          acceptedAttempts
            .filter(
              (source) =>
                source.nativeThreadId !== undefined &&
                source.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId,
            )
            .map((source) => source.runId),
        );
        const legacyInputRunIds = new Set(
          acceptedAttempts
            .filter((source) => source.nativeThreadId === undefined)
            .map((source) => source.runId),
        );
        const legacyRecoveredRunIds = new Set(
          projection.runs
            .filter(
              (source) =>
                source.providerThreadId === providerThread.id &&
                settledHandoffs.some(
                  (handoff) =>
                    handoff.strategy === "full_thread_summary" &&
                    handoff.fromProviderThreadIds.includes(providerThread.id) &&
                    source.ordinal >= handoff.coveredRunOrdinals.from &&
                    source.ordinal <= handoff.coveredRunOrdinals.to,
                ),
            )
            .map((source) => source.id),
        );
        // Row identity survives recovery; only accepted native input and delivered history occupy the new session.
        const nativeContextEstimate = Effect.gen(function* () {
          return sameNativeThread
            ? (yield* projectionStore.getTurnStartHistory(input.threadId)).reduce((sum, item) => {
                const acceptedNatively =
                  item.providerThreadId === providerThread.id &&
                  item.runId !== null &&
                  (nativeInputRunIds.has(item.runId) ||
                    (legacyInputRunIds.has(item.runId) &&
                      !coveredItemIds.has(item.id) &&
                      !legacyRecoveredRunIds.has(item.runId)));
                if (item.runId === run.id || (!acceptedNatively && !deliveredItemIds.has(item.id)))
                  return sum;
                const historical = historicalMessage(item);
                const nativeAttachments =
                  item.type === "user_message" && acceptedNatively
                    ? attachmentTokenAllowance(item.attachments)
                    : 0;
                return (
                  sum +
                  (historical === null ? 0 : estimateTextTokens(historical.text)) +
                  nativeAttachments
                );
              }, 0)
            : 0;
        });
        const modelContextWindow =
          knownModelWindow ??
          (handoffUsage !== null || reuseTelemetry ? previousUsage?.maxTokens : undefined);
        const budgetProviderThread = {
          ...loadedProviderThread,
          contextUsage: handoffUsage,
        };
        const missedRuns = projection.runs.filter(
          (source) =>
            source.ordinal < run.ordinal &&
            source.providerThreadId === providerThread.id &&
            (source.status === "failed" || source.status === "interrupted") &&
            !deliveredAttemptIds.has(source.activeAttemptId),
        );
        const missedRunIds = new Set(missedRuns.map((source) => source.id));
        return {
          modelContextWindow,
          budgetProviderThread,
          nativeContextEstimate,
          sameNativeThread,
          handoffUsage,
          deliveredItemIds,
          coveredItemIds,
          acceptedAttempts,
          nativeInputRunIds,
          legacyInputRunIds,
          missedRuns,
          missedRunIds,
          budget: Effect.gen(function* () {
            return handoffBudget({
              tokenCap,
              modelContextWindow,
              userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
              attachments: providerMessage.attachments,
              providerThread: budgetProviderThread,
              nativeContextEstimate:
                budgetProviderThread.contextUsage?.usedTokens === undefined
                  ? yield* nativeContextEstimate
                  : 0,
            });
          }),
        };
      };
      const prepareRetryHandoff = Effect.fn("ProviderTurnStartService.prepareRetryHandoff")(
        function* (context: ReturnType<typeof handoffContextForThread>) {
          const { missedRunIds, coveredItemIds, missedRuns, acceptedAttempts } = context;
          const missedHistory =
            missedRunIds.size === 0
              ? []
              : (yield* projectionStore.getTurnStartHistory(input.threadId, [
                  ...missedRunIds,
                ])).filter((item) => item.runId !== null && missedRunIds.has(item.runId));
          const missedItems = missedHistory.filter(
            (item) => !coveredItemIds.has(item.id) && historicalMessage(item) !== null,
          );
          // The resume fallback summary already covers every earlier run in order. A
          // retry copy after it would rank older missed requests as the newest history.
          const handoffs =
            missedItems.length === 0 || resumeFellBack
              ? []
              : [
                  yield* contextHandoffService.prepareProviderHandoff({
                    threadId: projection.thread.id,
                    targetRunId: run.id,
                    transferId: null,
                    fromProviderThreadIds: [providerThread.id],
                    toProviderThreadId: providerThread.id,
                    fromProviderInstanceId: run.providerInstanceId,
                    toProviderInstanceId: run.providerInstanceId,
                    coveredRunOrdinals: {
                      from: missedRuns[0]!.ordinal,
                      to: missedRuns.at(-1)!.ordinal,
                    },
                    strategy: "delta_since_target_last_seen",
                    items: missedItems,
                    runs: projection.runs,
                    createdAt: yield* DateTime.now,
                  }),
                ];
          // History delivery (inline or injected) is text only, so missed images ride on prompts
          // until a later run's is accepted. Compaction and /goal starts carry none. A missed run's
          // own accepted attempt predates its unsent steering input, so it does not count.
          const runsById = new Map(projection.runs.map((source) => [source.id, source]));
          const messagesById = new Map(projection.messages.map((message) => [message.id, message]));
          let lastPromptOrdinal = 0;
          for (const attempt of acceptedAttempts) {
            if (missedRunIds.has(attempt.runId)) continue;
            const source = runsById.get(attempt.runId);
            if (source === undefined) continue;
            const message = messagesById.get(source.userMessageId);
            if (
              message !== undefined &&
              (isCompactionCommandMessage(message) ||
                (goalDriver && parseGoalCommand(message) !== null))
            )
              continue;
            lastPromptOrdinal = Math.max(lastPromptOrdinal, source.ordinal);
          }
          const attachments = missedHistory.flatMap((item) =>
            item.type === "user_message" &&
            item.runId !== null &&
            (runsById.get(item.runId)?.ordinal ?? 0) > lastPromptOrdinal
              ? item.attachments
              : [],
          );
          return { handoffs, attachments };
        },
      );
      const prepareRecoveryHandoff = Effect.fn("ProviderTurnStartService.prepareRecoveryHandoff")(
        function* () {
          const transferId = yield* idAllocator.allocate.contextTransfer({
            sourceThreadId: projection.thread.id,
            targetThreadId: projection.thread.id,
            type: "provider_resume_fallback",
          });
          const createdAt = yield* DateTime.now;
          const history = yield* projectionStore.getTurnStartHistory(input.threadId);
          const boundary = contextBoundaryOrdinal({ runs: projection.runs, turnItems: history });
          const from = Math.max(1, boundary);
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId,
            fromProviderThreadIds: [providerThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: providerThread.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: { from, to: Math.max(from, run.ordinal - 1) },
            strategy: "full_thread_summary",
            runs: projection.runs,
            items: [
              ...(boundary === 0
                ? yield* ContextHandoffService.readInheritedHandoffItems(
                    projectionStore,
                    projection.thread,
                  )
                : []),
              ...history.filter((item) =>
                item.runId === null
                  ? boundary === 0
                  : projection.runs.some(
                      (source) =>
                        source.id === item.runId &&
                        source.ordinal >= boundary &&
                        source.ordinal < run.ordinal &&
                        source.status !== "rolled_back",
                    ),
              ),
            ],
            createdAt,
          });
          return { handoff, transferId, createdAt };
        },
      );
      const recoveryHandoff = yield* Effect.cached(prepareRecoveryHandoff());
      const withRecoveryHandoff = (handoff: OrchestrationV2ContextHandoff) => {
        // Delivery ranks later handoffs as newer history. Pending handoffs from
        // earlier runs predate this summary; handoffs for this run (provider-switch
        // delta, merge-back) are newer and must stay last.
        return [
          ...effectiveHandoffs.filter((candidate) => candidate.targetRunId !== run.id),
          handoff,
          ...effectiveHandoffs.filter((candidate) => candidate.targetRunId === run.id),
        ];
      };
      let resumedRetryHandoff: Effect.Success<ReturnType<typeof prepareRetryHandoff>> | undefined;
      let resumedHandoffContext: ReturnType<typeof handoffContextForThread> | undefined;
      let portableForkFallback: OrchestrationV2ContextHandoff | undefined;
      let recoveryTurnItem: OrchestrationV2TurnItem | undefined;
      const loadedProviderThread = yield* Effect.gen(function* () {
        if (nativeForkTransfer !== undefined) {
          let sourceProjection = yield* projectionStore.getThreadRecords(
            nativeForkTransfer.sourceThreadId,
            ["runs", "providerThreads", "attempts", "providerTurns"],
          );
          const sourceRun = sourceProjection.runs.find(
            (candidate) => candidate.id === nativeForkTransfer.sourcePoint.runId,
          );
          const sourceProviderThread = sourceProjection.providerThreads.find(
            (candidate) => candidate.id === sourceRun?.providerThreadId,
          );
          const sourceAttempt = sourceProjection.attempts.find(
            (candidate) => candidate.id === sourceRun?.activeAttemptId,
          );
          const sourceProviderTurn =
            latestProviderTurnForAttempt(sourceProjection.providerTurns, sourceAttempt?.id) ??
            sourceProjection.providerTurns.find(
              (candidate) => candidate.id === sourceAttempt?.providerTurnId,
            );
          if (sourceRun === undefined || sourceProviderThread === undefined) {
            return yield* new ProviderTurnStartError({
              runId,
              cause: `Native fork transfer ${nativeForkTransfer.id} has no source provider execution.`,
            });
          }
          // The source may have started a turn after dispatch planned this fork.
          const sourceBusy = sourceProjection.runs.some(
            (candidate) => candidate.ordinal > sourceRun.ordinal && isActiveRun(candidate),
          );
          let nativeForkFailure: string | undefined;
          if (
            (sourceRun.status === "completed" || sourceRun.status === "waiting") &&
            (!sourceBusy ||
              canForkBusySourceNatively(
                session.providerSession.capabilities,
                sourceProviderTurn?.nativeTurnRef != null,
              ))
          ) {
            // Rolled-back turns are no longer in the source conversation, so they cannot bound a fork.
            const rolledBackAttemptIds = new Set(
              sourceProjection.attempts
                .filter((attempt) =>
                  sourceProjection.runs.some(
                    (candidate) =>
                      candidate.id === attempt.runId && candidate.status === "rolled_back",
                  ),
                )
                .map((attempt) => attempt.id),
            );
            const forked = yield* Effect.result(
              session.forkThread({
                sourceProviderThread,
                sourceProviderTurns: sourceProjection.providerTurns.filter(
                  (turn) =>
                    turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId),
                ),
                targetThreadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                ...(sourceProviderTurn === undefined
                  ? {}
                  : { providerTurnId: sourceProviderTurn.id }),
              }),
            );
            if (forked._tag === "Success") return forked.success;
            if (input.willRetry === true) return yield* forked.failure;
            if (!(yield* isCurrentAttemptInStatus("starting"))) return undefined;
            // Retries are spent (e.g. the source's native session is gone): start fresh with portable history.
            yield* Effect.logWarning("Starting a native fork in a fresh native session", {
              driver: session.driver,
              providerThreadId: providerThread.id,
              sourceProviderThreadId: sourceProviderThread.id,
              runId,
              errorTag: forked.failure._tag,
            });
            nativeForkFailure = makeProviderFailure({
              cause: forked.failure,
              message: startFailureMessage(forked.failure),
              class: "provider_error",
            }).message;
            sourceProjection = {
              ...sourceProjection,
              ...(yield* projectionStore.getThreadRecords(nativeForkTransfer.sourceThreadId, [
                "runs",
                "attempts",
              ])),
            };
          }
          const nativeForkFailed = nativeForkFailure !== undefined;
          const sourceItems = yield* ContextHandoffService.readForkHistoryItems(
            projectionStore,
            sourceProjection,
            sourceRun,
          );
          const createdAt = yield* DateTime.now;
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId: nativeForkTransfer.id,
            fromProviderThreadIds: [sourceProviderThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: sourceRun.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: ContextHandoffService.visibleDeltaRunOrdinals(
              sourceProjection,
              sourceItems,
            ),
            strategy: "full_thread_summary",
            items: sourceItems,
            runs: sourceProjection.runs,
            createdAt,
          });
          const loaded = yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: nativeForkFailed
                ? { ...providerThread, nativeThreadRef: null, forkedFrom: null }
                : { ...providerThread, forkedFrom: null },
              // The failed fork may have left the adapter's session half-switched.
              ...(nativeForkFailed ? { forceNewNativeThread: true } : {}),
            }),
          );
          if (loaded === undefined) return undefined;
          portableForkFallback = handoff;
          effectiveHandoffs = [handoff, ...effectiveHandoffs];
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-handoff.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: createdAt,
                payload: handoff,
              },
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: createdAt,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  status: "resolved_portable",
                  resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                  error: null,
                  updatedAt: createdAt,
                },
              },
              ...(nativeForkFailure === undefined
                ? []
                : [
                    {
                      id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                      type: "turn-item.updated" as const,
                      threadId: projection.thread.id,
                      runId: run.id,
                      providerInstanceId: run.providerInstanceId,
                      occurredAt: createdAt,
                      payload: {
                        id: idAllocator.derive.runSignalTurnItem({
                          runId,
                          signal: "native-fork-fallback",
                        }),
                        threadId: projection.thread.id,
                        runId,
                        nodeId: rootNode.id,
                        providerThreadId: providerThread.id,
                        providerTurnId: null,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal:
                          Math.max(
                            0,
                            ...projection.turnItems
                              .filter((item) => item.runId === runId)
                              .map((item) => item.ordinal),
                          ) + 1,
                        status: "completed" as const,
                        title: "Native fork failed",
                        startedAt: createdAt,
                        completedAt: createdAt,
                        updatedAt: createdAt,
                        type: "system_notice" as const,
                        message: `Could not fork the source conversation natively (${nativeForkFailure}). Started a fresh session with its history.`,
                      },
                    },
                  ]),
            ],
          });
          return loaded;
        }
        if (providerThread.nativeThreadRef === null) {
          // Hand the run's provider thread to the adapter so it adopts this
          // row's identity when attaching native state. An adapter that mints
          // its own row instead leaves two live rows per app thread, and
          // `activeProviderThreadId` then flaps between them on every update.
          return yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: providerThread,
            }),
          );
        }
        const uncertainDelivery = projection.contextHandoffs.some(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status === "pending",
        );
        const rejectedHistory = yield* Effect.gen(function* () {
          if (session.driver !== "codex") return false;
          const acceptedAttemptIds = new Set(
            projection.providerTurns.map((turn) => turn.runAttemptId),
          );
          const previous = projection.runs.findLast(
            (source) =>
              source.providerThreadId === providerThread.id &&
              source.ordinal < run.ordinal &&
              source.activeAttemptId !== null &&
              acceptedAttemptIds.has(source.activeAttemptId),
          );
          if (
            previous === undefined ||
            (previous.status !== "failed" &&
              previous.status !== "interrupted" &&
              previous.status !== "cancelled")
          )
            return false;
          const previousAttempt = projection.attempts.find(
            (source) => source.id === previous.activeAttemptId,
          );
          if (previousAttempt === undefined) return false;
          if (previousAttempt.nativeThreadId !== undefined) {
            if (previousAttempt.nativeThreadId !== providerThread.nativeThreadRef?.nativeId)
              return false;
          } else if (
            projection.contextHandoffs.some(
              (handoff) =>
                handoff.toProviderThreadId === providerThread.id &&
                handoff.strategy === "full_thread_summary" &&
                handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
                handoff.coveredRunOrdinals.to >= previous.ordinal,
            )
          )
            return false;
          // The native resume RPC can succeed while persisted input still rejects every turn.
          return (yield* projectionStore.getTurnStartHistory(input.threadId, [previous.id])).some(
            (item) =>
              item.type === "error" &&
              item.nodeId === previous.rootNodeId &&
              (item.failure.code === "invalid_encrypted_content" ||
                classifyCodexManagedError(item.failure.message)?.code ===
                  "invalid_encrypted_content"),
          );
        });
        // A fresh session would orphan background work still running on the native thread.
        const hasPendingWork = (thread: OrchestrationV2ProviderThread) =>
          session.hasPendingBackgroundWorkForThread?.(thread, { includeSubagents: true }) ??
          session.hasPendingBackgroundWork ??
          Effect.succeed(false);
        const failForPendingWork = loadFromProvider(
          Effect.fail(
            new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: session.driver,
              threadId: projection.thread.id,
              providerThreadId: providerThread.id,
              runId,
              cause: new ContextHandoffBackgroundWorkError(),
            }),
          ),
        );
        if (rejectedHistory && (yield* hasPendingWork(providerThread))) {
          return yield* failForPendingWork;
        }
        // A provider that cannot truncate rolls back into a fresh native session holding none of the kept turns.
        const nativeSessionLacksKeptTurns =
          !session.providerSession.capabilities.checkpointing.providerCanRollbackConversation &&
          nativeSessionMissesKeptTurns(projection, providerThread, run);
        // Dispatch prepares no import handoff for a session import: its history is in the native session.
        const importedNativeSession =
          projection.thread.historyOrigin === "v1_import" &&
          !projection.providerTurns.some((turn) => turn.providerThreadId === providerThread.id) &&
          !projection.contextHandoffs.some(
            (handoff) =>
              handoff.toProviderThreadId === providerThread.id &&
              handoff.strategy === "manual_context",
          );
        const resumed = yield* Effect.result(
          uncertainDelivery || nativeSessionLacksKeptTurns || rejectedHistory
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: uncertainDelivery
                    ? "Uncertain native history injection"
                    : nativeSessionLacksKeptTurns
                      ? "Native session holds none of the kept conversation"
                      : "Rejected native history",
                }),
              )
            : session.resumeThread({
                providerThread,
                threadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                importedNativeSession,
              }),
        );
        if (resumed._tag === "Success") {
          if (session.compactThread !== undefined) return resumed.success;
          const context = handoffContextForThread(resumed.success);
          context.budget = yield* Effect.cached(context.budget);
          resumedHandoffContext = context;
          resumedRetryHandoff = yield* prepareRetryHandoff(context);
          const fits = yield* deliverContextHandoffs({
            handoffs: [...effectiveHandoffs, ...resumedRetryHandoff.handoffs],
            providerThread: { ...resumed.success, id: providerThread.id },
            budget: context.budget,
            deferInline: isCompactionCommandMessage(providerMessage) || goalCommand,
            alreadyDeliveredItemIds: context.deliveredItemIds,
            persist: () => Effect.void,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
          );
          if (fits) return resumed.success;
          const freshThread = { ...resumed.success, nativeThreadRef: null };
          const freshContext = handoffContextForThread(freshThread);
          const { handoff } = yield* recoveryHandoff;
          const fitsFresh = yield* deliverContextHandoffs({
            handoffs: withRecoveryHandoff(handoff),
            providerThread: freshThread,
            budget: freshContext.budget,
            alreadyDeliveredItemIds: freshContext.deliveredItemIds,
            persist: () => Effect.void,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
          );
          if (!fitsFresh) return resumed.success;
          if (yield* hasPendingWork(resumed.success)) return yield* failForPendingWork;
        }
        resumedHandoffContext = undefined;
        resumedRetryHandoff = undefined;
        if (!(yield* isCurrentAttemptInStatus("starting"))) return undefined;
        // Another client is still writing to the native thread. A fresh
        // session here would silently split the conversation from it.
        if (
          resumed._tag === "Failure" &&
          resumed.failure._tag === "ProviderAdapterThreadInUseError"
        ) {
          return yield* loadFromProvider(Effect.fail(resumed.failure));
        }

        yield* Effect.logWarning("Recovering provider context in a fresh native session", {
          driver: session.driver,
          providerThreadId: providerThread.id,
          runId,
          reason: uncertainDelivery
            ? "uncertain_history_delivery"
            : nativeSessionLacksKeptTurns
              ? "native_session_lacks_kept_turns"
              : rejectedHistory
                ? "rejected_native_history"
                : resumed._tag === "Success"
                  ? "handoff_budget_exhausted"
                  : "resume_failed",
          errorTag: resumed._tag === "Failure" ? resumed.failure._tag : "ContextHandoffBudgetError",
        });
        const replacement = yield* loadFromProvider(
          session.ensureThread({
            threadId: projection.thread.id,
            title: projection.thread.title,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            providerSessionId,
            // Clear the native ref to force a fresh session while preserving row identity.
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
            // A fresh session that never loaded the broken history needs no replacement.
            ...(opensFreshSession && resumed._tag === "Failure"
              ? {}
              : { forceNewNativeThread: true }),
          }),
        );
        if (replacement === undefined) return undefined;
        if (
          replacement.nativeThreadRef?.nativeId != null &&
          replacement.nativeThreadRef.driver === providerThread.nativeThreadRef?.driver &&
          replacement.nativeThreadRef.nativeId === providerThread.nativeThreadRef.nativeId
        ) {
          // Never retried. Forget the load first, or the next turn would skip resume and start on
          // the reused session without this error or the recovery handoff.
          yield* providerSessions.forgetLoadedProviderThread({
            providerSessionId: session.providerSessionId,
            threadId: projection.thread.id,
            providerThread: replacement,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
          });
          yield* settleStartFailure({
            signal: "provider-thread-load-failure",
            title: "Provider turn failed to start",
            error: new ProviderAdapter.ProviderAdapterProtocolError({
              driver: session.driver,
              detail:
                "the provider returned its existing session when asked for a fresh one, so the conversation context could not be moved to a new session",
            }),
          });
          return undefined;
        }
        const { handoff, transferId, createdAt } = yield* recoveryHandoff;
        const previousRun = projection.runs.findLast(
          (candidate) =>
            candidate.providerThreadId === providerThread.id &&
            candidate.ordinal < run.ordinal &&
            candidate.startedAt !== null,
        );
        // Stable per run so a retried start reuses the reserved run-start position.
        const handoffTurnItemId = idAllocator.derive.runSignalTurnItem({
          runId,
          signal: "resume-fallback-handoff",
        });
        const handoffTurnItem: OrchestrationV2TurnItem = {
          id: handoffTurnItemId,
          threadId: projection.thread.id,
          runId,
          nodeId: rootNode.id,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          // The summary is delivered ahead of this run's own handoffs and message.
          ordinal: yield* turnItemPositions.allocate({
            threadId: projection.thread.id,
            turnItemId: handoffTurnItemId,
            runId,
            runOrdinal: run.ordinal,
            placement: "run_start",
          }),
          status: "completed",
          title: "Recovered context",
          startedAt: createdAt,
          completedAt: createdAt,
          updatedAt: createdAt,
          type: "handoff",
          contextHandoffId: handoff.id,
          fromProviderThreadIds: handoff.fromProviderThreadIds,
          toProviderThreadId: handoff.toProviderThreadId,
          fromProviderInstanceIds: [providerThread.providerInstanceId],
          toProviderInstanceId: run.providerInstanceId,
          fromModelSelections: previousRun === undefined ? [] : [previousRun.modelSelection],
          toModel: run.modelSelection.model,
          strategy: handoff.strategy,
          summary: handoff.summaryText,
        };
        const replacementWrite = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: handoff,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-transfer.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: {
                id: transferId,
                type: "provider_handoff",
                sourceThreadId: projection.thread.id,
                targetThreadId: projection.thread.id,
                sourcePoint: { threadId: projection.thread.id },
                basePoint: null,
                sourceProviderInstanceId: providerThread.providerInstanceId,
                targetProviderInstanceId: run.providerInstanceId,
                targetRunId: run.id,
                status: "resolved_portable",
                resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                createdBy: "system",
                error: null,
                createdAt,
                updatedAt: createdAt,
                consumedAt: null,
              },
            },
          ],
        });
        if (!replacementWrite.committed) return undefined;
        effectiveHandoffs = withRecoveryHandoff(handoff);
        resumeFellBack = true;
        recoveryTurnItem = handoffTurnItem;
        return replacement;
      });
      if (loadedProviderThread === undefined) return;
      if (!(yield* isCurrentAttemptInStatus("starting"))) {
        return;
      }
      const now = yield* DateTime.now;
      const handoffContext = resumedHandoffContext ?? handoffContextForThread(loadedProviderThread);
      const {
        sameNativeThread,
        handoffUsage,
        deliveredItemIds,
        acceptedAttempts,
        nativeInputRunIds,
        legacyInputRunIds,
        modelContextWindow,
        budgetProviderThread,
        nativeContextEstimate,
      } = handoffContext;
      if (manualResume && unsentResumeMessage === undefined && session.resumeTurn === undefined) {
        yield* settleStartFailure({
          signal: "resume-unsupported",
          title: "Native resume is unavailable",
          error: new ProviderAdapter.ProviderResumeUnsupportedError({
            driver: session.driver,
            providerThreadId: providerThread.id,
          }),
        });
        return;
      }
      const retryHandoff = resumedRetryHandoff ?? (yield* prepareRetryHandoff(handoffContext));
      const runningProviderThread: OrchestrationV2ProviderThread = {
        ...loadedProviderThread,
        contextUsage: handoffUsage,
        id: providerThread.id,
        driver: session.driver,
        providerInstanceId: run.providerInstanceId,
        providerSessionId,
        appThreadId: projection.thread.id,
        ownerNodeId: providerThread.ownerNodeId,
        firstRunOrdinal: providerThread.firstRunOrdinal ?? run.ordinal,
        lastRunOrdinal: run.ordinal,
        handoffIds:
          portableForkFallback === undefined
            ? providerThread.handoffIds
            : [...providerThread.handoffIds, portableForkFallback.id],
        forkedFrom: portableForkFallback === undefined ? providerThread.forkedFrom : null,
        status: "active",
        createdAt: providerThread.createdAt,
        updatedAt: now,
      };
      const runningRun: OrchestrationV2Run = {
        ...run,
        status: "running",
        startedAt: run.startedAt ?? now,
      };
      const runningAttempt: OrchestrationV2RunAttempt = {
        ...attempt,
        ...(runningProviderThread.nativeThreadRef?.nativeId == null
          ? {}
          : { nativeThreadId: runningProviderThread.nativeThreadRef.nativeId }),
        status: "running",
        startedAt: now,
      };
      const runningRootNode: OrchestrationV2ExecutionNode = {
        ...rootNode,
        status: "running",
        startedAt: now,
      };
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: yield* idAllocator.allocate.event({
            threadId: projection.thread.id,
            providerSessionId,
          }),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: session.providerSession,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningProviderThread,
        },
        ...(nativeForkTransfer === undefined ||
        portableForkFallback !== undefined ||
        runningProviderThread.nativeThreadRef === null
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                driver: session.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  targetRunId: run.id,
                  status: "consumed" as const,
                  resolution: {
                    strategy: "native_fork" as const,
                    providerThreadRef: runningProviderThread.nativeThreadRef,
                  },
                  error: null,
                  updatedAt: now,
                  consumedAt: now,
                },
              },
            ]),
        // Shown only once the replacement session commits with the running transition.
        ...(recoveryTurnItem === undefined
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "turn-item.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: recoveryTurnItem,
              },
            ]),
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRun,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run-attempt.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningAttempt,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "node.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRootNode,
        },
      ];
      const runningWrite = yield* eventSink.writeIfRunCurrent({
        threadId: projection.thread.id,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: "starting",
        events,
      });
      if (!runningWrite.committed) {
        return;
      }
      // Delegated (app_owned) children run their own runs; routing them here ingests their items twice.
      const routableSubagents = projection.subagents.filter(
        (subagent) =>
          subagent.origin === "provider_native" &&
          RunExecutionService.canRouteRelatedSubagent(subagent.status),
      );
      const nativeThreadHasTurns =
        nativeInputRunIds.size > 0 ||
        (legacyInputRunIds.size > 0 &&
          sameNativeThread &&
          !acceptedAttempts.some((source) => source.nativeThreadId !== undefined));
      const brainContext =
        d4AgentContextText !== null ||
        scopedAgentTask ||
        !settings.secondBrain.path ||
        !settings.secondBrain.injection.enabled ||
        message.text.trimStart().startsWith("/")
          ? null
          : yield* Effect.gen(function* () {
              const brainProject = yield* projects.getById(projection.thread.projectId).pipe(
                Effect.map(Option.getOrUndefined),
                Effect.orElseSucceed(() => undefined),
              );
              return yield* brain.buildTurnContext({
                userText: message.text,
                includeCore:
                  !nativeThreadHasTurns ||
                  effectiveHandoffs.length > 0 ||
                  retryHandoff.handoffs.length > 0,
                providerThreadId: providerThread.id,
                brainContext:
                  settings.d4Agent.projectContexts[projection.thread.projectId] ?? "Global",
                ...(brainProject
                  ? { projectTitle: brainProject.title, workspacePath: brainProject.workspaceRoot }
                  : {}),
              });
            }).pipe(
              Effect.timeout("1500 millis"),
              Effect.catchCause(() =>
                Effect.logWarning("Second brain context unavailable").pipe(Effect.as(null)),
              ),
            );
      const brainText = brainContext ? SecondBrainService.formatTurnContext(brainContext) : "";
      const recovery = makeHandoffCompactionRecovery(session);
      let recoveredNativeContext = false;
      const persistHandoff = Effect.fn("ProviderTurnStartService.persist")(function* (
        handoff: OrchestrationV2ContextHandoff,
      ) {
        const updatedAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({
                threadId: projection.thread.id,
              }),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: updatedAt,
              payload: { ...handoff, updatedAt },
            },
          ],
        });
      });
      const startWithHandoffs = Effect.fn("ProviderTurnStartService.startWithHandoffs")(
        (turnInput: Parameters<typeof session.startTurn>[0], compact = false) =>
          Effect.gen(function* () {
            const compression =
              d4AgentContextText === null && !scopedAgentTask
                ? settings.handoff.contextCompression
                : { ...settings.handoff.contextCompression, mode: "bounded" as const };
            compact = compact && d4AgentContextText === null && !scopedAgentTask;
            let deliveryHandoffs = [...effectiveHandoffs, ...retryHandoff.handoffs];
            if (compression.mode !== "bounded" && deliveryHandoffs.length > 0) {
              // Preparation is pure and bounded. Recover intact covered items here,
              // in the effect worker, before choosing direct or smart delivery.
              const history = yield* projectionStore.getTurnStartHistory(input.threadId);
              deliveryHandoffs = deliveryHandoffs.map((handoff) =>
                restoreHandoffHistory(handoff, history, projection.runs),
              );
            }
            if (
              d4AgentContextText === null &&
              !scopedAgentTask &&
              settings.handoff.memoryBackend === "meko" &&
              deliveryHandoffs.length > 0
            ) {
              yield* saveHandoff(
                deliveryHandoffs
                  .map((handoff) => handoff.summaryText)
                  .join("\n\n")
                  .slice(0, 60_000),
              );
            }
            const deliver = () =>
              deliverContextHandoffs({
                handoffs: deliveryHandoffs,
                mode: compression.mode,
                compact: (transcript, maxCharacters) =>
                  compressHandoffContextLocal({
                    transcript,
                    task: userText,
                    model: compression.localModel,
                    judgeModel: compression.judgeModel || compression.localModel,
                    ...(compression.judgeBaseUrl ? { judgeBaseUrl: compression.judgeBaseUrl } : {}),
                    ...(compression.secondaryJudgeModel && compression.secondaryJudgeBaseUrl
                      ? {
                          secondaryJudge: {
                            model: compression.secondaryJudgeModel,
                            baseUrl: compression.secondaryJudgeBaseUrl,
                          },
                        }
                      : {}),
                    maxInputCharacters: compression.maxInputCharacters,
                    maxOutputCharacters: Math.min(maxCharacters, compression.maxOutputCharacters),
                    customPrompt: compression.customPrompt,
                  }),
                deferInline: compact || goalCommand,
                providerThread: runningProviderThread,
                budget: Effect.gen(function* () {
                  return handoffBudget({
                    tokenCap: compression.mode === "direct" ? Number.MAX_SAFE_INTEGER : tokenCap,
                    modelContextWindow,
                    userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
                    attachments: message.attachments,
                    providerThread: budgetProviderThread,
                    nativeContextEstimate:
                      budgetProviderThread.contextUsage?.usedTokens === undefined
                        ? yield* nativeContextEstimate
                        : 0,
                  });
                }),
                alreadyDeliveredItemIds: deliveredItemIds,
                ...(session.injectHistory === undefined
                  ? {}
                  : {
                      inject: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                        session.injectHistory!({
                          providerThread: runningProviderThread,
                          ...history,
                        }),
                    }),
                persist: Effect.fn("ProviderTurnStartService.persist")(function* (handoff) {
                  const updatedAt = yield* DateTime.now;
                  yield* eventSink.write({
                    events: [
                      {
                        id: yield* idAllocator.allocate.event({
                          threadId: projection.thread.id,
                        }),
                        type: "context-handoff.updated",
                        threadId: projection.thread.id,
                        runId: run.id,
                        providerInstanceId: run.providerInstanceId,
                        occurredAt: updatedAt,
                        payload: { ...handoff, updatedAt },
                      },
                    ],
                  });
                }),
              });
            const delivery = yield* deliver().pipe(
              Effect.catchTags({
                // @effect-diagnostics-next-line effectFnOpportunity:off -- d4research code predating this style rule.
                ContextHandoffBudgetError: (error) =>
                  Effect.gen(function* () {
                    if (
                      compact ||
                      d4AgentContextText !== null ||
                      scopedAgentTask ||
                      !nativeThreadHasTurns ||
                      handoffBudget({
                        tokenCap,
                        modelContextWindow,
                        userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
                        attachments: message.attachments,
                        providerThread: { ...budgetProviderThread, contextUsage: null },
                        nativeContextEstimate: 0,
                      }) === 0 ||
                      !(yield* isCurrentAttemptInStatus("running"))
                    )
                      return yield* error;
                    budgetProviderThread.contextUsage = yield* recovery.compact(turnInput);
                    recoveredNativeContext = true;
                    if (!(yield* isCurrentAttemptInStatus("running")))
                      return { context: "", delivered: Effect.void, unsent: Effect.void };
                    // Delivery rejected before any persistence/injection. Retry only this phase;
                    // never retry startTurn, whose acknowledgement can be ambiguous.
                    return yield* deliver();
                  }),
              }),
            );
            if (!(yield* isCurrentAttemptInStatus("running"))) return;
            if (
              session.providerSession.capabilities.context.requiresAppHistory &&
              session.injectHistory
            ) {
              yield* session.injectHistory({
                providerThread: runningProviderThread,
                messages: selectAppProviderHistory(
                  yield* projectionStore.getTurnStartHistory(input.threadId),
                  projection.runs,
                  run.id,
                ),
                context: "",
              });
            }
            const start = compact ? session.compactThread! : session.startTurn;
            // Like history, the side chat context waits for a turn that sends a prompt.
            const sideChatContext =
              sideChatHandoff === undefined || compact || goalCommand
                ? ""
                : sideChatHandoff.summaryText;
            const context = [
              delivery.context,
              sideChatContext,
              restartNote,
              compact || goalCommand ? "" : brainText,
            ]
              .filter((part) => part !== "")
              .join("\n\n");
            const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
            const startInput = noteContinuation ? promptedInput : turnInput;
            const { resume: _resume, ...contextInput } = startInput;
            const { message: resumeMessage, resume: _resumeIntent, ...resumeInput } = startInput;
            const missedAttachments =
              compact || goalCommand
                ? []
                : retryHandoff.attachments.filter(
                    (missed) =>
                      !turnInput.message.attachments.some((current) => current.id === missed.id),
                  );
            const prompted =
              context !== "" || missedAttachments.length > 0 || d4AgentContextText !== null;
            const requestText =
              turnInput.resume && prompted && userText === "" ? RESUME_PROMPT : userText;
            const text =
              d4AgentContextText !== null
                ? `${d4AgentContextText}\n\n${context === "" ? "" : `${context}\n\n`}User message:\n${requestText}`
                : goalCommand
                  ? userText
                  : withInlineContext(context, requestText);
            const operation =
              turnInput.resume && !prompted && session.resumeTurn !== undefined
                ? session.resumeTurn({ ...resumeInput, messageId: resumeMessage.messageId })
                : start({
                    ...(prompted ? contextInput : startInput),
                    ...(recoveredNativeContext
                      ? { providerTurnOrdinal: turnInput.providerTurnOrdinal + 1 }
                      : {}),
                    message: {
                      ...turnInput.message,
                      text,
                      ...(missedAttachments.length === 0
                        ? {}
                        : {
                            attachments: [...missedAttachments, ...turnInput.message.attachments],
                          }),
                    },
                    ...(text === userText
                      ? {}
                      : { inlineContextLength: text.length - userText.length }),
                  });
            yield* operation.pipe(
              // A pending marker would make the next turn abandon this native
              // session, though the refused prompt never reached it.
              Effect.tapError((error) =>
                refusedBeforePrompt(error)
                  ? delivery.unsent.pipe(
                      Effect.catchCause(() =>
                        Effect.logWarning("Failed to restore unsent context handoffs", {
                          runId: run.id,
                        }),
                      ),
                    )
                  : Effect.void,
              ),
            );
            if (!compact && brainContext)
              yield* brain.markContextDelivered(brainContext).pipe(
                Effect.timeout("100 millis"),
                Effect.catchCause(() =>
                  Effect.logWarning("Second brain delivery receipt unavailable"),
                ),
              );
            // After provider acceptance, failed delivery bookkeeping must not stop live ingestion.
            const nativeThreadId = runningProviderThread.nativeThreadRef?.nativeId;
            yield* Effect.forEach(
              [
                delivery.delivered,
                ...(sideChatContext === "" ||
                sideChatHandoff === undefined ||
                nativeThreadId == null
                  ? []
                  : [
                      persistHandoff({
                        ...sideChatHandoff,
                        toProviderThreadId: runningProviderThread.id,
                        delivery: { nativeThreadId, status: "inline" as const, itemIds: [] },
                      }),
                    ]),
              ],
              (record) =>
                record.pipe(
                  Effect.catchCause(() =>
                    Effect.logWarning("Failed to record accepted context handoff delivery", {
                      runId: run.id,
                      deliveryStatus: "pending",
                    }),
                  ),
                ),
              { discard: true },
            );
          }).pipe(
            Effect.mapError((cause) =>
              cause._tag === "ProviderAdapterTurnStartError"
                ? cause
                : new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: session.driver,
                    threadId: projection.thread.id,
                    providerThreadId: providerThread.id,
                    runId: run.id,
                    cause,
                  }),
            ),
          ),
      );
      const deliverySession =
        d4AgentContextText === null &&
        !session.providerSession.capabilities.context.requiresAppHistory &&
        effectiveHandoffs.length === 0 &&
        retryHandoff.handoffs.length === 0 &&
        retryHandoff.attachments.length === 0 &&
        sideChatHandoff === undefined &&
        restartNote === "" &&
        brainText === "" &&
        !noteContinuation
          ? session
          : makeDeliverySession(recovery.session, startWithHandoffs);
      const mcpSession = yield* mcpProviderSessions.read(message.threadId);
      if (mcpSession !== undefined) {
        yield* setActiveMcpTurn(
          mcpSession.providerSessionId,
          TurnId.make(run.id),
          isNiaUserTurn ? "user" : "restricted",
        );
      }
      return runExecution.startRootRun({
        commandId: CommandId.make(`command:effect:provider-turn.start:${run.id}`),
        appThread: projection.thread,
        providerSessionId,
        session: deliverySession,
        run: runningRun,
        rootNode: runningRootNode,
        checkpointScope,
        providerThread: runningProviderThread,
        attempt: runningAttempt,
        attemptId: attempt.id,
        baseline,
        loadInheritedBackgroundTurnItems: runControls.loadInheritedBackgroundTurnItems,
        relatedThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.childThreadId === null ? [] : [subagent.childThreadId],
        ),
        relatedProviderThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.providerThreadId === null ? [] : [subagent.providerThreadId],
        ),
        providerTurnOrdinal:
          Math.max(
            0,
            ...projection.providerTurns
              .filter((turn) => turn.providerThreadId === providerThread.id)
              .map((turn) => turn.ordinal),
          ) + 1,
        resume: manualResume && unsentResumeMessage === undefined,
        nativeThreadHasTurns,
        shouldStartProviderTurn: runControls.shouldStartProviderTurn,
        shouldFinalizeRun: runControls.shouldFinalizeRun,
        loadRunInterruptReason: runControls.loadRunInterruptReason,
        hasUnpairedRunInterruptRequest: runControls.hasUnpairedRunInterruptRequest,
        hasWorkspaceMoved: runControls.hasWorkspaceMoved,
        loadUnsettledWork: runControls.loadUnsettledWork,
        message: {
          messageId: message.id,
          text: userText,
          attachments: providerMessage.attachments,
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          ...(message.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: message.scheduledTaskId }),
          ...(message.senderThreadId === undefined
            ? {}
            : { senderThreadId: message.senderThreadId }),
        },
        modelSelection: run.modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
      });
    });

    const settleExhaustedStart = Effect.fn("orchestrationV2.providerTurnStart.settleExhausted")(
      function* (initialRun: OrchestrationV2Run, cause: unknown) {
        if (initialRun.activeAttemptId === null) return;
        const projection = yield* projectionStore.getThreadRecords(
          initialRun.threadId,
          ["runs", "nodes", "attempts", "turnItems"],
          { runIds: [initialRun.id] },
        );
        const run = projection.runs.find((run) => run.id === initialRun.id);
        if (run?.status !== "starting" || run.activeAttemptId !== initialRun.activeAttemptId)
          return;
        const now = yield* DateTime.now;
        const node = projection.nodes.find((node) => node.id === run.rootNodeId);
        const attempt = projection.attempts.find((attempt) => attempt.id === run.activeAttemptId);
        const agentError = isD4AgentError(cause) ? cause : undefined;
        const failure = makeProviderFailure({
          cause,
          message:
            agentError?.message ??
            "The provider could not start this turn. Retry the turn; if it keeps failing, check the provider setup and server logs.",
          class:
            agentError !== undefined && agentError.reason !== "storage"
              ? "validation_error"
              : "provider_error",
        });
        const item: OrchestrationV2TurnItem = {
          id: idAllocator.derive.runSignalTurnItem({
            runId: run.id,
            signal: "provider-start-failure",
          }),
          type: "error",
          threadId: initialRun.threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          providerThreadId: run.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: Math.max(0, ...projection.turnItems.map((item) => item.ordinal)) + 1,
          status: "failed",
          title: "Provider turn failed to start",
          failure,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        };
        const payloads = [
          { type: "turn-item.updated", payload: item },
          { type: "run.updated", payload: { ...run, status: "failed", completedAt: now } },
          ...(attempt === undefined
            ? []
            : [
                {
                  type: "run-attempt.updated" as const,
                  payload: { ...attempt, status: "failed" as const, completedAt: now },
                },
              ]),
          ...(node === undefined
            ? []
            : [
                {
                  type: "node.updated" as const,
                  payload: { ...node, status: "failed" as const, completedAt: now },
                },
              ]),
        ] as const;
        const events = yield* Effect.forEach(payloads, (event) =>
          Effect.gen(function* () {
            return {
              ...event,
              id: yield* idAllocator.allocate.event({ threadId: initialRun.threadId }),
              threadId: initialRun.threadId,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
            } satisfies OrchestrationV2DomainEvent;
          }),
        );
        const written = yield* eventSink.writeIfRunCurrent({
          threadId: initialRun.threadId,
          runId: run.id,
          activeAttemptId: initialRun.activeAttemptId,
          expectedStatus: "starting",
          events,
        });
        if (written.committed)
          yield* turnAnalytics.runSettled({
            runId: run.id,
            status: "failed",
            completedAt: now,
            childrenRunning: false,
          });
      },
    );

    return ProviderTurnStartServiceV2.of({
      start: Effect.fn("ProviderTurnStartService.start")(
        function* (input) {
          let startingRun: OrchestrationV2Run | undefined;
          const captureStartingRun = (run: OrchestrationV2Run) => {
            startingRun = run;
          };
          return yield* Effect.gen(function* () {
            // Storage cleanup removes worktrees under the same lease. Only startup
            // holds it; the provider turn runs after it is released.
            const { thread } = yield* projectionStore.getThreadRecords(input.threadId, []);
            const cwd =
              thread.worktreePath ??
              (yield* projects
                .getById(thread.projectId, { includeDeleted: true })
                .pipe(Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot)));
            const providerTurn = yield* cwd === undefined
              ? start(input, captureStartingRun)
              : withTurnStartReservation(
                  fileSystem,
                  path,
                  path.resolve(cwd),
                  thread.worktreePath === null
                    ? start(input, captureStartingRun)
                    : withWorkspaceLease(
                        path.resolve(thread.worktreePath),
                        start(input, captureStartingRun),
                      ),
                );
            if (providerTurn !== undefined) {
              // Run execution owns finalization after the running write. A later
              // failure must not settle a replacement attempt committed by steering.
              yield* providerTurn.pipe(
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterruptsOnly(cause),
                  (cause) =>
                    Effect.logWarning(
                      "Run execution failed after starting",
                      { runId: input.runId },
                      cause,
                    ),
                ),
              );
            }
          }).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                (input.willRetry === false && startingRun !== undefined
                  ? settleExhaustedStart(startingRun, Cause.squash(cause))
                  : Effect.void
                ).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ProviderTurnStartError({
                        runId: input.runId,
                        cause: Cause.squash(cause),
                        ...(startingRun?.activeAttemptId == null || startingRun.rootNodeId == null
                          ? {}
                          : {
                              attemptId: startingRun.activeAttemptId,
                              rootNodeId: startingRun.rootNodeId,
                            }),
                      }),
                    ),
                  ),
                ),
            ),
          );
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnStartError(cause)
                ? cause
                : new ProviderTurnStartError({ runId: input.runId, cause }),
            ),
          ),
      ),
      failStartingRun: Effect.fn("ProviderTurnStartService.failStartingRun")(
        function* ({ threadId, runId, attemptId, rootNodeId }) {
          const projection = yield* projectionStore.getTurnStartContext(threadId, runId);
          const run = projection.runs.find((candidate) => candidate.id === runId);
          if (
            run === undefined ||
            run.status !== "starting" ||
            run.activeAttemptId !== attemptId ||
            run.rootNodeId !== rootNodeId
          )
            return;
          const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
          const attempt = projection.attempts.find(
            (candidate) => candidate.id === run.activeAttemptId,
          );
          if (rootNode === undefined || attempt === undefined) {
            return yield* new ProviderTurnStartRunStateMissingError({ runId });
          }
          yield* settleRunBeforeStart({
            run,
            rootNode,
            attempt,
            turnItems: projection.turnItems,
            signal: "provider-turn-start-failure",
            status: "failed",
            now: yield* DateTime.now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: run.providerThreadId,
            item: {
              type: "error",
              title: "Turn failed to start",
              failure: makeProviderFailure({ message: START_GAVE_UP_MESSAGE }),
            },
          });
        },
        (effect, { runId }) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnStartRunStateMissingError(cause)
                ? cause
                : new ProviderTurnStartError({ runId, cause }),
            ),
          ),
      ),
    });
  }),
).pipe(Layer.provide(HandoffMemory.layer.pipe(Layer.provide(FetchHttpClient.layer))));
