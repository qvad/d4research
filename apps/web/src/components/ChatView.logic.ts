import type { OrchestrationV2ThreadProjection as ThreadProjection } from "@d4research/contracts";
import { formatTerminalContextLabel } from "../lib/terminalContext";
import {
  reviewCommentContextLabel,
  previewAnnotationContextLabel,
} from "../lib/composerContextRecords";
import { toServerClock } from "@d4research/client-runtime/clock";
import { msg } from "gt-react";
import { m, type MessageResolver } from "../i18n/messages";
import { type OrchestrationV2ProviderTurn, type RunAttemptId } from "@d4research/contracts";
import {
  deriveLatestThreadRun,
  deriveThreadRuntime,
} from "@d4research/client-runtime/state/thread-execution";
import { turnChanges } from "@d4research/client-runtime/state/thread-repositories";
import { COMPACT_COMMAND_PATTERN } from "@d4research/client-runtime/state/context-window";
import { derivePendingBackgroundWork } from "@d4research/shared/orchestrationV2PendingBackgroundWork";
import {
  latestUnheldRun,
  usageLimitRunPresentedAsLatest,
} from "@d4research/shared/orchestrationV2ThreadError";
import * as Option from "effect/Option";
import type { SetStateAction } from "react";
import { sanitizeThreadErrorMessage, thrownErrorMessage } from "@d4research/client-runtime/errors";
import type {
  ThreadStructure,
  EnvironmentThreadShell,
} from "@d4research/client-runtime/state/shell";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type AssetCreateUrlInput,
  type AssetCreateUrlResult,
  type ChatFileAttachment,
  type CommandId,
  type EnvironmentId,
  isProviderDriverKind,
  ProjectId,
  type MessageId,
  type ModelSelection,
  type OrchestrationMessageContext,
  type PreviewAnnotationPayload,
  type ProviderInteractionMode,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderThreadId,
  type ServerProvider,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadContextRecord,
  type EnvironmentContextRecord,
  type ResponseContextRecord,
  type ThreadId,
  type ThreadLinkedPullRequest,
  type RunId,
  type WorktreeSetupSnapshot,
} from "@d4research/contracts";
import { worktreeSetupAgentStarted } from "@d4research/client-runtime/worktree-setup";
import * as DateTime from "effect/DateTime";
import { resolveAssetUrl } from "@d4research/client-runtime/state/assets";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@d4research/client-runtime/state/runtime";
import { readComposerImageBytes } from "./chat/composerAttachmentFiles";
import { videoMimeType } from "@d4research/shared/video";
import {
  appendCodexArtifactTemplateUsePrompt,
  codexArtifactTemplateUsePrompt,
  type CodexArtifactTemplate,
} from "@d4research/shared/codexArtifactTemplates";
import { presentThreadShell } from "@d4research/client-runtime/state/shell";
import {
  type ChatMessage,
  isImageAttachment,
  type SessionPhase,
  type Thread,
  type TurnDiffSummary,
} from "../types";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  type DraftThreadState,
} from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { threadHasStarted } from "../lib/chatThreadActions";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells, environmentThreadDetails } from "../state/threads";
import { waitForAtomValue } from "../state/waitForAtomValue";
import { filterTerminalContextsWithText, type TerminalContextDraft } from "../lib/terminalContext";
import {
  removeInlineContextReference,
  stripInlineContextReferences,
} from "~/lib/composerContextReferences";
import { terminalContextReference } from "../lib/composerContextRecords";
import type { ComposerDispatchMode } from "@d4research/client-runtime/state/composer-dispatch";
import type { DraftThreadEnvMode } from "../composerDraftStore";
import { collapseExpandedComposerCursor, type ComposerSubmissionIntent } from "../composer-logic";
import type { ReviewCommentContext } from "../reviewCommentContext";
import { derivePhase, type TimelineEntry } from "../session-logic";
import type { PreviewMiniPlayerSource } from "../previewMiniPlayerStore";
import type { DesktopPreviewOverlay } from "../previewStateStore";
import type { RightPanelSurface } from "../rightPanelStore";
import {
  NO_PROVIDER_MODEL_SELECTION,
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../providerInstances";

import { type OrchestrationV2ProjectedTurnItem } from "@d4research/contracts";

import { parseScopedThreadKey } from "@d4research/client-runtime/environment";

import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@d4research/contracts";

import { isDevPipelinePrompt } from "../devPipeline";
import { extractMarkdownLinkHrefs } from "@d4research/shared/markdownLinks";
import { resolveMarkdownFileLinkMeta } from "../markdown-links";

import {
  buildImmediateProviderHandoffMessage,
  isProviderHandoffCandidate,
  shouldHandoffModelSelection,
} from "../providerHandoff";
import { isDeepResearchPrompt } from "../researchPipeline";

interface ProactivePanelObservation {
  threadKey: string;
  runningTurnId: RunId | null | undefined;
  targetKey: string | null | undefined;
  userActionTurnId: RunId | null;
  userActionRevision: number;
}

export function observeProactivePanelUserChoice(
  previous: ProactivePanelObservation | null,
  input: { threadKey: string; runningTurnId: RunId | null; userActionRevision: number },
): ProactivePanelObservation {
  const sameThread = previous?.threadKey === input.threadKey;
  const newTurn =
    sameThread && input.runningTurnId !== null && input.runningTurnId !== previous.userActionTurnId;
  return {
    threadKey: input.threadKey,
    runningTurnId: sameThread ? previous.runningTurnId : undefined,
    targetKey: sameThread ? previous.targetKey : undefined,
    userActionTurnId: input.runningTurnId ?? (sameThread ? previous.userActionTurnId : null),
    userActionRevision:
      !sameThread || newTurn ? input.userActionRevision : previous.userActionRevision,
  };
}

export function shouldRetargetThreadPullRequestPanel(
  previous: ThreadLinkedPullRequest | null,
  current: ThreadLinkedPullRequest | null,
  surface: RightPanelSurface | null,
): boolean {
  if (previous === null || current === null || surface?.kind !== "pull-request") return false;
  const previousRepository = previous.repository.toLowerCase();
  return (
    (previous.projectId !== current.projectId ||
      previousRepository !== current.repository.toLowerCase() ||
      previous.number !== current.number) &&
    surface.projectId === previous.projectId &&
    surface.repository.toLowerCase() === previousRepository &&
    surface.number === previous.number
  );
}

export function shouldOpenProactiveTurnDiff(input: {
  previousRunningTurnId: RunId | null | undefined;
  runningTurnId: RunId | null;
  settledTurnId: RunId | null;
  turnCompleted: boolean;
}): boolean {
  return (
    input.runningTurnId === null &&
    input.turnCompleted &&
    input.settledTurnId !== null &&
    (input.previousRunningTurnId === undefined ||
      input.settledTurnId === input.previousRunningTurnId)
  );
}
export function resolveProactiveTurnDiffAction(input: {
  checkpoint: Pick<TurnDiffSummary, "status" | "files" | "repositories"> | undefined;
  isGitRepo: boolean | undefined;
  activeSurfaceKind?: RightPanelSurface["kind"] | null;
}): "defer" | "ignore" | "open" {
  // An open diff already shows the work; reopening it would reset the chosen scope.
  if (input.activeSurfaceKind === "pull-request" || input.activeSurfaceKind === "diff") {
    return "ignore";
  }
  // A turn that changed tracked repositories has a diff whatever the thread's own folder is.
  if (input.checkpoint?.repositories === undefined) {
    if (input.checkpoint === undefined || input.checkpoint.status === "missing") return "defer";
    if (input.isGitRepo === undefined) return "defer";
    if (
      !input.isGitRepo ||
      input.checkpoint.status !== "ready" ||
      input.checkpoint.files.length === 0
    ) {
      return "ignore";
    }
  }
  if (input.checkpoint === undefined) return "defer";
  const { totals } = turnChanges(input.checkpoint);
  return totals.count >= 3 || totals.additions + totals.deletions >= 50 ? "open" : "ignore";
}

export function codexArtifactTemplatePromptToAppend(
  currentDraft: string,
  template: CodexArtifactTemplate,
): string | null {
  return appendCodexArtifactTemplateUsePrompt(currentDraft, template) === currentDraft
    ? null
    : codexArtifactTemplateUsePrompt(template);
}

export function resolveEffectiveInteractionMode(input: {
  planModeEnabled: boolean;
  composerInteractionMode: ProviderInteractionMode | null;
  threadInteractionMode: ProviderInteractionMode | null | undefined;
}): ProviderInteractionMode {
  if (!input.planModeEnabled) return "default";
  return input.composerInteractionMode ?? input.threadInteractionMode ?? "default";
}

export function shouldDockDraftHeroForSubmission(input: {
  isDraftHeroState: boolean;
  activeThreadKey: string | null;
  submissionIntent: ComposerSubmissionIntent;
}): boolean {
  return (
    input.submissionIntent === "foreground" &&
    input.isDraftHeroState &&
    input.activeThreadKey !== null
  );
}

export function shouldReleaseTimelineAnchorForToolActivity(input: {
  anchorMessageId: MessageId | null;
  liveFollowEnabled: boolean;
  runningTurnId: RunId | null;
  timelineEntries: ReadonlyArray<TimelineEntry>;
}): boolean {
  if (input.anchorMessageId === null || !input.liveFollowEnabled || input.runningTurnId === null) {
    return false;
  }

  return input.timelineEntries.some((timelineEntry) => {
    if (timelineEntry.kind !== "work" || timelineEntry.entry.runId !== input.runningTurnId) {
      return false;
    }

    const entry = timelineEntry.entry;
    return (
      entry.tone === "tool" ||
      entry.itemType !== undefined ||
      entry.requestKind !== undefined ||
      (entry.command?.trim().length ?? 0) > 0
    );
  });
}

export { resolveVisibleWorktreeSetup } from "@d4research/client-runtime/worktree-setup";

export function resolveWorktreeSetupProgress(input: {
  threadId: ThreadId;
  localPreparing: boolean;
  runStatus: NonNullable<Thread["latestRun"]>["status"] | undefined;
  latest: WorktreeSetupSnapshot | null | undefined;
  held: WorktreeSetupSnapshot | null;
}) {
  const latest = input.latest?.threadId === input.threadId ? input.latest : null;
  const held = input.held?.threadId === input.threadId ? input.held : null;
  const snapshot = latest && (!held || latest.sequence >= held.sequence) ? latest : held;
  return {
    snapshot,
    isPreparingWorktree:
      input.localPreparing ||
      input.runStatus === "preparing" ||
      (snapshot?.phase === "running" && !worktreeSetupAgentStarted(snapshot)),
  };
}

export function resolveDraftHeroState(input: {
  isLocalDraftThread: boolean;
  hasTimelineEntries: boolean;
  isWorking: boolean;
  draftHeroDockRequested: boolean;
  backgroundSubmissionPending: boolean;
  hasWorktreeSetupCard?: boolean;
}): boolean {
  if (input.hasWorktreeSetupCard) {
    return false;
  }
  if (input.backgroundSubmissionPending) {
    return true;
  }
  return (
    input.isLocalDraftThread &&
    !input.hasTimelineEntries &&
    !input.isWorking &&
    !input.draftHeroDockRequested
  );
}

/**
 * Remounting LegendList (or handing it an empty first paint) punches a hole
 * through the chat pane — white in light mode — so cmd+1/2/3 spam flashes even
 * when the destination is already cached.
 */
export type HeldThreadTimeline<T extends readonly unknown[]> = {
  threadKey: string | null;
  entries: T;
  markdownCwd?: string | null;
  workspaceRoot?: string | null;
};

const MAX_REMEMBERED_THREAD_TIMELINES = 16;

let rememberedThreadTimelines = new Map<string, HeldThreadTimeline<readonly unknown[]>>();

let rememberedThreadTimelineOrder: string[] = [];

let lastReadyThreadKey: string | null = null;

function rememberThreadTimelineEntries(held: HeldThreadTimeline<readonly unknown[]>): void {
  if (held.threadKey === null) {
    return;
  }
  rememberedThreadTimelines.set(held.threadKey, held);
  rememberedThreadTimelineOrder = [
    ...rememberedThreadTimelineOrder.filter((key) => key !== held.threadKey),
    held.threadKey,
  ];
  while (rememberedThreadTimelineOrder.length > MAX_REMEMBERED_THREAD_TIMELINES) {
    const evicted = rememberedThreadTimelineOrder.shift();
    if (evicted !== undefined) {
      rememberedThreadTimelines.delete(evicted);
    }
  }
  lastReadyThreadKey = held.threadKey;
}

export function rememberReadyThreadTimeline<T extends readonly unknown[]>(
  held: HeldThreadTimeline<T>,
): void {
  if (held.threadKey === null || held.entries.length === 0) {
    return;
  }
  rememberThreadTimelineEntries(held);
}

export function peekRememberedThreadTimeline<T extends readonly unknown[]>(
  threadKey: string | null,
): T | null {
  if (threadKey === null) {
    return null;
  }
  return (rememberedThreadTimelines.get(threadKey)?.entries as T | undefined) ?? null;
}

export function peekHeldThreadTimeline<
  T extends readonly unknown[],
>(): HeldThreadTimeline<T> | null {
  if (lastReadyThreadKey === null) {
    return null;
  }
  const held = rememberedThreadTimelines.get(lastReadyThreadKey);
  if (held === undefined || held.entries.length === 0) {
    return null;
  }
  return held as HeldThreadTimeline<T>;
}

export function resetHeldThreadTimeline(): void {
  rememberedThreadTimelines = new Map();
  rememberedThreadTimelineOrder = [];
  lastReadyThreadKey = null;
}

export function threadKeysShareEnvironment(left: string | null, right: string | null): boolean {
  if (left === null || right === null) {
    return false;
  }
  const leftRef = parseScopedThreadKey(left);
  const rightRef = parseScopedThreadKey(right);
  return leftRef !== null && rightRef !== null && leftRef.environmentId === rightRef.environmentId;
}

export function isPaintOnlyThreadTimeline(
  displayThreadKey: string | null,
  activeThreadKey: string | null,
): boolean {
  return (
    displayThreadKey !== null && activeThreadKey !== null && displayThreadKey !== activeThreadKey
  );
}

export function resolveThreadSwitchTimeline<T extends readonly unknown[]>(input: {
  loading: boolean;
  activeThreadKey: string | null;
  nextEntries: T;
  rememberedForActive?: T | null;
  lastReady?: HeldThreadTimeline<T> | null;
}): { entries: T; displayThreadKey: string | null } {
  if (input.nextEntries.length > 0) {
    return { entries: input.nextEntries, displayThreadKey: input.activeThreadKey };
  }

  const rememberedForActive =
    input.rememberedForActive ?? peekRememberedThreadTimeline<T>(input.activeThreadKey);
  if (input.loading && rememberedForActive !== null && rememberedForActive.length > 0) {
    return { entries: rememberedForActive, displayThreadKey: input.activeThreadKey };
  }

  const lastReady = input.lastReady ?? peekHeldThreadTimeline<T>();
  if (
    input.loading &&
    lastReady !== null &&
    lastReady.threadKey !== null &&
    lastReady.threadKey !== input.activeThreadKey &&
    lastReady.entries.length > 0 &&
    threadKeysShareEnvironment(lastReady.threadKey, input.activeThreadKey)
  ) {
    return { entries: lastReady.entries, displayThreadKey: lastReady.threadKey };
  }
  return { entries: input.nextEntries, displayThreadKey: input.activeThreadKey };
}

export function resolveDraftPromotionNavigationTarget(input: {
  serverThreadRef: ScopedThreadRef | null;
  serverThread: Pick<Thread, "latestRun" | "latestUserMessageAt"> | null | undefined;
  backgroundSubmissionPending: boolean;
}): ScopedThreadRef | null {
  if (input.backgroundSubmissionPending) {
    return null;
  }
  const latestRun = input.serverThread?.latestRun ?? null;
  const runStarted = latestRun?.startedAt != null;
  const startupStopped =
    latestRun?.status === "failed" ||
    latestRun?.status === "interrupted" ||
    latestRun?.status === "cancelled";
  const messagePersisted = input.serverThread?.latestUserMessageAt != null;
  return runStarted || startupStopped || messagePersisted ? input.serverThreadRef : null;
}

export async function resolveFileAttachmentUrl(input: {
  attachment: ChatFileAttachment;
  environmentId: EnvironmentId;
  httpBaseUrl: string;
  createAssetUrl: (input: {
    environmentId: EnvironmentId;
    input: AssetCreateUrlInput;
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, unknown>>;
}): Promise<string> {
  const { attachment } = input;
  const result = await input.createAssetUrl({
    environmentId: input.environmentId,
    input: {
      resource: {
        _tag: "attachment",
        attachmentId: attachment.id,
        fileName: attachment.name,
        mimeType: videoMimeType(attachment) ?? attachment.mimeType,
      },
    },
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const url = resolveAssetUrl(input.httpBaseUrl, result.value.relativeUrl);
  if (url === null) throw new Error(m(msg("The environment returned an invalid attachment URL.")));
  return url;
}

export async function prepareRevertedMessageAttachments(input: {
  message: ChatMessage;
  environmentId: EnvironmentId;
  httpBaseUrl: string;
  createAssetUrl: Parameters<typeof resolveFileAttachmentUrl>[0]["createAssetUrl"];
}): Promise<File[]> {
  return Promise.all(
    (input.message.attachments ?? []).map(async (attachment) => {
      if (attachment.type !== "image" && attachment.type !== "file") {
        throw new Error(m(msg("This message has an attachment that cannot be restored.")));
      }
      const result = await input.createAssetUrl({
        environmentId: input.environmentId,
        input: {
          resource: {
            _tag: "attachment",
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
          },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const url = resolveAssetUrl(input.httpBaseUrl, result.value.relativeUrl);
      if (url === null)
        throw new Error(m(msg("The environment returned an invalid attachment URL.")));
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok)
        throw new Error(m(msg("Could not restore attachment: {name}", { name: attachment.name })));
      const file = new File([await response.blob()], attachment.name, {
        type: attachment.mimeType,
      });
      if (attachment.type === "image") await readComposerImageBytes(file);
      return file;
    }),
  );
}

export function resolveBackgroundDraftWorkspaceOptions(input: {
  envMode: DraftThreadEnvMode;
  branch: string | null;
  startFromOrigin: boolean;
}): {
  envMode: DraftThreadEnvMode;
  branch: string | null;
  worktreePath: null;
  startFromOrigin: boolean;
} {
  return {
    envMode: input.envMode,
    branch: input.branch,
    worktreePath: null,
    startFromOrigin: input.envMode === "worktree" && input.startFromOrigin,
  };
}

export function shouldShowPlanFollowUpPrompt(input: {
  pendingUserInputCount: number;
  interactionMode: ProviderInteractionMode;
  latestTurnSettled: boolean;
  hasActionableProposedPlan: boolean;
  hasComposerAttachments: boolean;
}): boolean {
  return (
    input.pendingUserInputCount === 0 &&
    input.interactionMode === "plan" &&
    input.latestTurnSettled &&
    input.hasActionableProposedPlan &&
    !input.hasComposerAttachments
  );
}

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";

export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;

export const ENVIRONMENT_RECONNECT_WARNING_GRACE_MS = 2_000;

export type ThreadPipelineKind = "research" | "dev";

// Scope pipeline progress to the active turn, matching any pipeline prompt in that turn.
// Handoffs retain the turn id; old completed prompts must not activate the banner.
export function deriveThreadPipelineKind(
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "text" | "runId">>,
  activeTurnId: RunId | null,
): ThreadPipelineKind | null {
  if (activeTurnId === null) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user" || message.runId !== activeTurnId) continue;
    if (isDevPipelinePrompt(message.text)) return "dev";
    if (isDeepResearchPrompt(message.text)) return "research";
  }
  return null;
}

export function agentControlledBrowserCloseConfirmation(
  surfaces: readonly RightPanelSurface[],
  desktopByTabId: Readonly<Record<string, Pick<DesktopPreviewOverlay, "controller"> | undefined>>,
  resolve: MessageResolver = m,
): string | null {
  const activeBrowserCount = surfaces.filter(
    (surface) =>
      surface.kind === "preview" &&
      surface.resourceId !== null &&
      desktopByTabId[surface.resourceId]?.controller === "agent",
  ).length;
  if (activeBrowserCount === 0) return null;
  if (activeBrowserCount === 1) {
    return [
      resolve(msg("Close browser while the agent is using it?")),
      resolve(
        msg(
          "The agent is actively controlling this browser. Closing it may interrupt the current browser action.",
        ),
      ),
    ].join("\n");
  }
  return [
    resolve(
      msg(
        "{count, plural, one {Close {count} browsers while the agent is using them?} other {Close {count} browsers while the agent is using them?}}",
        { count: activeBrowserCount },
      ),
    ),
    resolve(
      msg(
        "The agent is actively controlling these browsers. Closing them may interrupt the current browser actions.",
      ),
    ),
  ].join("\n");
}

/** The floating player hides only while the same source is rendered in the panel. */
export function shouldRenderPreviewMiniPlayer(
  source: PreviewMiniPlayerSource | null,
  renderedRightPanelSurface: RightPanelSurface | null,
): boolean {
  if (source === null) return false;
  if (source.kind === "browser") {
    return !(
      renderedRightPanelSurface?.kind === "preview" &&
      renderedRightPanelSurface.resourceId === source.tabId
    );
  }
  return !(
    renderedRightPanelSurface?.kind === "device" &&
    renderedRightPanelSurface.target?.hostId === source.hostId &&
    renderedRightPanelSurface.target.deviceId === source.deviceId
  );
}

export function shouldOpenProactivePullRequest(
  previousTargetKey: string | null | undefined,
  targetKey: string | null,
): boolean {
  return targetKey !== null && targetKey !== previousTargetKey;
}

/** Capture user intent before loading or metadata writes can defer panel activation. */

/** Validate the exact provider-bound string before optimistic state clears the draft. */
export function outgoingMessageLengthError(messageText: string): string | null {
  if (messageText.length <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS) return null;
  return `This message is ${messageText.length} characters; the provider limit is ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS}. Shorten the prompt or remove an attached context.`;
}

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export const DismissedResearchBannersSchema = Schema.Array(Schema.String);

// Audio files an agent produced in a thread, surfaced as playable artifacts.
// Removal only hides the artifact from the player (persisted per thread+path);
// the generated file itself stays in the workspace and its checkpoints.
export const DISMISSED_AUDIO_ARTIFACTS_KEY = "t3code:dismissed-audio-artifacts";

export const EMPTY_DISMISSED_AUDIO_ARTIFACTS: ReadonlyArray<string> = [];

export const DismissedAudioArtifactsSchema = Schema.Array(Schema.String);

const AUDIO_ARTIFACT_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "oga",
  "aac",
  "flac",
  "opus",
  "weba",
]);

function isAudioArtifactPath(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension !== undefined && AUDIO_ARTIFACT_EXTENSIONS.has(extension);
}

export function audioArtifactDismissKey(threadId: string, path: string): string {
  return `${threadId}::${path}`;
}

export function collectAudioArtifactPaths(
  summaries: ReadonlyArray<Pick<TurnDiffSummary, "files">>,
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "text">>,
  workspaceRoot: string | undefined,
): string[] {
  // A changed sound asset is not a recording delivered to the user. Require
  // an explicit assistant link as a checkpoint entry.
  const linkedPaths = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const href of extractMarkdownLinkHrefs(message.text)) {
      const path = resolveMarkdownFileLinkMeta(href, workspaceRoot)?.workspaceRelativePath;
      if (path && isAudioArtifactPath(path)) linkedPaths.add(path);
    }
  }
  const paths = new Set<string>();
  for (const summary of summaries) {
    for (const file of summary.files) {
      if (file.kind === "deleted") paths.delete(file.path);
      else if (linkedPaths.has(file.path)) paths.add(file.path);
    }
  }
  return [...paths];
}

export function scheduleEnvironmentReconnectWarning(showWarning: () => void): () => void {
  const timeoutId = globalThis.setTimeout(showWarning, ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);
  return () => globalThis.clearTimeout(timeoutId);
}

export function hasEnvironmentReconnectWarningGraceElapsed(
  activeEnvironmentId: EnvironmentId | null,
  elapsedEnvironmentId: EnvironmentId | null,
): boolean {
  return activeEnvironmentId !== null && activeEnvironmentId === elapsedEnvironmentId;
}

export function startNewThreadForProject(
  projectRef: ScopedProjectRef | null,
  handleNewThread: (projectRef: ScopedProjectRef) => Promise<unknown>,
): boolean {
  if (projectRef === null) return false;
  void handleNewThread(projectRef);

  return true;
}

export function resolveThreadMetadataUpdateForNextTurn(input: {
  currentModelSelection: ModelSelection;
  nextModelSelection?: ModelSelection;
  currentBranch: string | null;
  nextBranch?: string;
}): {
  modelSelection?: ModelSelection;
  branch?: string;
  worktreePath?: null;
} | null {
  const nextModelSelection = input.nextModelSelection;
  const modelSelectionChanged =
    nextModelSelection !== undefined &&
    (nextModelSelection.model !== input.currentModelSelection.model ||
      nextModelSelection.instanceId !== input.currentModelSelection.instanceId ||
      JSON.stringify(nextModelSelection.options ?? null) !==
        JSON.stringify(input.currentModelSelection.options ?? null));
  const branchChanged = input.nextBranch !== undefined && input.nextBranch !== input.currentBranch;
  if (!modelSelectionChanged && !branchChanged) {
    return null;
  }
  return {
    ...(modelSelectionChanged ? { modelSelection: nextModelSelection } : {}),
    ...(branchChanged ? { branch: input.nextBranch, worktreePath: null } : {}),
  };
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
  resolve: MessageResolver = m,
): Thread {
  const timestamp = DateTime.makeUnsafe(draftThread.createdAt);
  return presentThreadShell(draftThread.environmentId, {
    id: threadId,
    projectId: draftThread.projectId,
    title: resolve(msg("New thread")),
    providerInstanceId: fallbackModelSelection.instanceId,
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  });
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  serverThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.serverThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.serverThread.environmentId === input.routeThreadRef.environmentId &&
    input.serverThread.id === input.targetThreadId,
  );
}

export function resolveComposerProviderSelection(input: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  candidateInstanceIds: ReadonlyArray<ProviderInstanceId | null | undefined>;
  lockedProvider: ProviderDriverKind | null;
  lockedInstanceId: ProviderInstanceId | null | undefined;
}) {
  const requestedInstanceId = input.candidateInstanceIds.find(
    (candidate) => candidate != null && candidate !== NO_PROVIDER_MODEL_SELECTION.instanceId,
  );
  const requestedDriverKind =
    input.lockedProvider ??
    input.entries.find((entry) => entry.instanceId === requestedInstanceId)?.driverKind ??
    input.entries[0]?.driverKind ??
    ProviderDriverKind.make("unconfigured");
  const lockedContinuationGroupKey = input.lockedProvider
    ? (input.entries.find((entry) => entry.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey ?? null)
    : null;
  // Missing metadata must not move Antigravity history into another Google profile.
  const requiresExactInstance =
    input.lockedProvider === "antigravity" &&
    input.lockedInstanceId != null &&
    lockedContinuationGroupKey === null;
  const compatibleEntries = input.entries.filter(
    (entry) =>
      (!input.lockedProvider || entry.driverKind === input.lockedProvider) &&
      (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey) &&
      (!requiresExactInstance || entry.instanceId === input.lockedInstanceId),
  );
  const selectedProviderEntry =
    input.candidateInstanceIds
      .map((candidate) =>
        compatibleEntries.find(
          (entry) => entry.instanceId === candidate && entry.enabled && entry.isAvailable,
        ),
      )
      .find((entry) => entry !== undefined) ??
    resolveSelectableProviderInstanceEntry(
      compatibleEntries.filter((entry) => entry.driverKind === requestedDriverKind),
      undefined,
    ) ??
    resolveSelectableProviderInstanceEntry(compatibleEntries, undefined);
  const unavailableProviderInstanceId = selectedProviderEntry
    ? undefined
    : input.lockedProvider
      ? (input.lockedInstanceId ?? requestedInstanceId)
      : requestedInstanceId;
  return {
    selectedProviderEntry,
    requestedInstanceId,
    requestedDriverKind,
    lockedContinuationGroupKey,
    unavailableProviderInstanceId,
  };
}

export function resolveComposerInteractionMode(input: {
  planModeEnabled: boolean;
  provider: Pick<ServerProvider, "showInteractionModeToggle"> | null | undefined;
  interactionMode: ProviderInteractionMode;
}): { enabled: boolean; interactionMode: ProviderInteractionMode } {
  const enabled =
    input.planModeEnabled &&
    input.provider != null &&
    input.provider.showInteractionModeToggle !== false;
  return {
    enabled,
    interactionMode: enabled ? input.interactionMode : "default",
  };
}

export function getAntigravitySendBlockReason(
  provider:
    | Pick<ServerProvider, "driver" | "installed" | "auth" | "models" | "status">
    | null
    | undefined,
  model: string,
  resolve: MessageResolver = m,
): string | null {
  if (provider?.driver !== "antigravity") return null;
  if (!provider.installed) {
    return resolve(msg("Install Antigravity in provider settings before sending."));
  }
  if (provider.auth.status === "unauthenticated") {
    return resolve(msg("Sign in to Antigravity in provider settings before sending."));
  }
  const slug = model.trim();
  if (slug.length === 0) return resolve(msg("Choose an Antigravity model before sending."));
  if (provider.auth.status === "unknown") return null;
  if (provider.models.length === 0) {
    return resolve(msg("Refresh Antigravity models in provider settings before sending."));
  }
  if (
    provider.status === "ready" &&
    slug !== ANTIGRAVITY_DEFAULT_MODEL &&
    !provider.models.some((entry) => entry.slug === slug || entry.aliases?.includes(slug))
  ) {
    return resolve(msg("That Antigravity model is no longer available. Choose another model."));
  }
  return null;
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) => threadId !== input.activeThreadId && openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(
    0,
    input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  );
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadTerminalOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (!isImageAttachment(attachment)) {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function timelineHasEphemeralPreviewUrls(
  entries: ReadonlyArray<Pick<TimelineEntry, "kind"> & { message?: ChatMessage }>,
): boolean {
  return entries.some(
    (entry) =>
      entry.kind === "message" &&
      entry.message !== undefined &&
      collectUserMessageBlobPreviewUrls(entry.message).length > 0,
  );
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (!isImageAttachment(attachment)) continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export { readFileAsDataUrl } from "../lib/imageCompression";

export { resolveSendEnvMode } from "@d4research/shared/projectSettings";

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  existingAttachmentCount?: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  elementContextCount?: number;
  /** Large-paste and dropped-text attachments are independently sendable. */
  pastedContextCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineContextReferences(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const elementContextCount = options.elementContextCount ?? 0;
  const pastedContextCount = options.pastedContextCount ?? 0;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      (options.existingAttachmentCount ?? 0) > 0 ||
      sendableTerminalContexts.length > 0 ||
      elementContextCount > 0 ||
      pastedContextCount > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
  resolve: MessageResolver = m,
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  if (variant === "empty") {
    return {
      title: resolve(
        msg(
          "{count, plural, =1 {Expired terminal context won't be sent} other {Expired terminal contexts won't be sent}}",
          { count },
        ),
      ),
      description: resolve(
        msg(
          "{count, plural, =1 {Remove it or re-add it to include terminal output.} other {Remove them or re-add them to include terminal output.}}",
          { count },
        ),
      ),
    };
  }
  return {
    title: resolve(
      msg(
        "{count, plural, =1 {Expired terminal context omitted from message} other {Expired terminal contexts omitted from message}}",
        { count },
      ),
    ),
    description: resolve(
      msg(
        "{count, plural, =1 {Re-add it if you want that terminal output included.} other {Re-add them if you want that terminal output included.}}",
        { count },
      ),
    ),
  };
}

export function branchMismatchKey(
  threadId: string | null,
  mismatch: { threadBranch: string; currentBranch: string } | null,
): string | null {
  if (!threadId || !mismatch) {
    return null;
  }
  return `${threadId}:${mismatch.threadBranch}:${mismatch.currentBranch}`;
}

// Draft content is the intent signal — composer focus is useless here because
// ChatView autofocuses the composer on every thread open.
export function shouldShowBranchMismatchBanner(input: {
  hasMismatch: boolean;
  isDismissed: boolean;
  composerHasContent: boolean;
  wasShownForCurrentMismatch: boolean;
}): boolean {
  if (!input.hasMismatch || input.isDismissed) {
    return false;
  }
  return input.composerHasContent || input.wasShownForCurrentMismatch;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes). Durable cross-device dismissal is planned as a server-side ack.
const sessionDismissedBranchMismatchKeys = new Set<string>();

export function dismissBranchMismatchForSession(key: string): void {
  sessionDismissedBranchMismatchKeys.add(key);
}

export function isBranchMismatchDismissedForSession(key: string | null): boolean {
  return key !== null && sessionDismissedBranchMismatchKeys.has(key);
}

// Git status for a checkout arrives after the composer paints, and the branch
// strip mounts on the assumption that a project is a Git repo. Without a
// memory, a non-Git project would mount the strip and drop it on every visit.
const sessionCheckoutIsRepo = new Map<string, boolean>();

function checkoutIsRepoKey(environmentId: EnvironmentId, cwd: string): string {
  return JSON.stringify([environmentId, cwd]);
}

export function rememberCheckoutIsRepo(
  environmentId: EnvironmentId,
  cwd: string,
  isRepo: boolean,
): void {
  sessionCheckoutIsRepo.set(checkoutIsRepoKey(environmentId, cwd), isRepo);
}

export function recallCheckoutIsRepo(
  environmentId: EnvironmentId,
  cwd: string | null,
): boolean | undefined {
  return cwd === null
    ? undefined
    : sessionCheckoutIsRepo.get(checkoutIsRepoKey(environmentId, cwd));
}

export function threadShellHasStarted(
  shell:
    | Pick<EnvironmentThreadShell, "latestRun" | "latestUserMessageAt" | "runtime">
    | null
    | undefined,
): boolean {
  return Boolean(
    shell &&
    (shell.latestRun !== null || shell.latestUserMessageAt !== null || shell.runtime !== null),
  );
}

// Imported history has no session until its first prompt. Resolve its instance
// through the environment's provider catalog before locking to a driver.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  const sessionProvider = input.thread?.runtime?.providerName ?? null;
  if (sessionProvider && isProviderDriverKind(sessionProvider)) {
    return sessionProvider;
  }
  // Keep the lock when an instance disappears instead of moving imported history
  // to another driver before the user explicitly requests a handoff.
  const threadProvider =
    input.providers.find((provider) => provider.instanceId === input.threadProvider)?.driver ??
    input.threadProvider;
  const selectedProvider =
    input.providers.find((provider) => provider.instanceId === input.selectedProvider)?.driver ??
    input.selectedProvider;
  const narrowedThreadProvider =
    threadProvider && isProviderDriverKind(threadProvider) ? threadProvider : null;
  const narrowedSelectedProvider =
    selectedProvider && isProviderDriverKind(selectedProvider) ? selectedProvider : null;
  return narrowedThreadProvider ?? narrowedSelectedProvider ?? null;
}

// Provider model locks apply within one instance. Cross-instance picks replace the
// session through handoff and follow the server reactor scope.
export function getStartedThreadModelChangeBlockReason(
  input: {
    providers: ReadonlyArray<
      Pick<ServerProvider, "instanceId"> & { readonly requiresNewThreadForModelChange?: boolean }
    >;
    hasStartedSession: boolean;
    supportsProviderSwitchingViaHandoff?: boolean;
    currentModelSelection: ModelSelection;
    currentProviderInstanceId?: ModelSelection["instanceId"] | null | undefined;
    nextModelSelection: ModelSelection;
  },
  resolve: MessageResolver = m,
): { title: string; description: string } | null {
  if (!input.hasStartedSession || input.supportsProviderSwitchingViaHandoff) {
    return null;
  }
  const currentInstanceId =
    input.currentProviderInstanceId ?? input.currentModelSelection.instanceId;
  if (
    currentInstanceId !== input.nextModelSelection.instanceId ||
    input.currentModelSelection.model === input.nextModelSelection.model
  ) {
    return null;
  }
  const currentProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === currentInstanceId,
  );
  if (currentProvider?.requiresNewThreadForModelChange !== true) {
    return null;
  }
  return {
    title: resolve(msg("Start a new chat to change models")),
    description: resolve(
      msg("This provider does not allow switching models after a conversation has started."),
    ),
  };
}

/**
 * Whether an outgoing model selection would hand off, and whether its target can
 * actually receive one. `unavailable` exists so the dispatch can refuse: a
 * required handoff whose target is unhealthy must abort, never downgrade to a
 * plain send that switches the provider-native session behind Memo's back.
 */
export type ProviderHandoffResolution =
  | { readonly kind: "none" }
  | { readonly kind: "ready"; readonly target: ModelSelection; readonly displayName: string }
  | { readonly kind: "unavailable"; readonly displayName: string };

export const NO_PROVIDER_HANDOFF: ProviderHandoffResolution = { kind: "none" };

/**
 * The one resolver every send path shares: the composer, the staged-handoff
 * banner, direct sends, and queued sends. `thread` is null for anything that
 * is not a server thread. `entries` are the environment's provider instances
 * with settings applied; `sessionLockedProvider` comes from `deriveLockedProvider`.
 */
export function resolveProviderHandoff(input: {
  readonly thread: Pick<Thread, "runtime" | "modelSelection"> | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly sessionLockedProvider: ProviderDriverKind | null;
  readonly nextModelSelection: ModelSelection;
}): ProviderHandoffResolution {
  const { thread, providers, nextModelSelection, sessionLockedProvider } = input;
  if (!thread) return NO_PROVIDER_HANDOFF;
  const currentInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  // A session record with no provider name was never a native session:
  // an inline delegation synthesizes one purely to say "this thread is
  // busy". Handing off from a provider that never ran would stage a
  // pointless Memo bridge, so it does not count as started.
  const hasStartedSession = thread.runtime !== null && thread.runtime.providerName !== null;
  const driverKind =
    providers.find((snapshot) => snapshot.instanceId === nextModelSelection.instanceId)?.driver ??
    null;
  // Derive required handoff from the outgoing selection, independently of target health.
  // A sibling instance must still require Memo proof before switching sessions.
  const requiresHandoff = shouldHandoffModelSelection({
    hasStartedSession,
    currentInstanceId,
    nextInstanceId: nextModelSelection.instanceId,
    modelChangeRequiresNewThread:
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession,
        currentModelSelection: thread.modelSelection,
        currentProviderInstanceId: thread.runtime?.providerInstanceId ?? null,
        nextModelSelection,
      }) !== null,
    providerChanged:
      sessionLockedProvider !== null && driverKind !== null && driverKind !== sessionLockedProvider,
  });
  if (!requiresHandoff) return NO_PROVIDER_HANDOFF;

  const entry = input.entries.find(
    (candidate) => candidate.instanceId === nextModelSelection.instanceId,
  );
  const displayName = entry?.displayName ?? String(nextModelSelection.instanceId);
  // Target health decides whether the handoff can happen, not whether one is
  // needed. Staging hides an unhealthy target (the banner would promise a
  // switch the composer silently declines) and the dispatch refuses it.
  // Same-instance model changes skip this: there is no other target to vet.
  const targetUnusable =
    nextModelSelection.instanceId !== currentInstanceId &&
    (!entry || !isProviderHandoffCandidate(entry, currentInstanceId));
  return targetUnusable
    ? { kind: "unavailable", displayName }
    : { kind: "ready", target: nextModelSelection, displayName };
}

/**
 * Wraps an outgoing message in the handoff its resolution requires. Returns
 * null when no handoff applies and `error` when the send must abort: an
 * unavailable target, or a message too long to carry the context.
 */
export function applyProviderHandoffToMessage(input: {
  readonly resolution: ProviderHandoffResolution;
  readonly composedText: string;
  readonly thread: { readonly id: ThreadId; readonly title: string };
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  readonly projectTitle: string | undefined;
  readonly enabledSkills: ReadonlyArray<string>;
}): { readonly text: string } | { readonly error: string } | null {
  const { resolution } = input;
  if (resolution.kind === "none") return null;
  if (resolution.kind === "unavailable") {
    return { error: `${resolution.displayName} is not available to receive a handoff.` };
  }
  try {
    const text = buildImmediateProviderHandoffMessage({
      promptText: input.composedText,
      messages: input.messages,
      context: {
        sourceThreadId: input.thread.id,
        sourceThreadTitle: input.thread.title,
        targetInstanceId: String(resolution.target.instanceId),
        targetModel: resolution.target.model,
        targetLabel: resolution.displayName,
        project: input.projectTitle,
        enabledSkills: input.enabledSkills,
      },
    });
    const lengthError = outgoingMessageLengthError(text);
    return lengthError !== null ? { error: lengthError } : { text };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The provider handoff failed." };
  }
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const threadAtom = environmentThreadShells.threadShellAtom(threadRef);
  return waitForAtomValue({
    registry: appAtomRegistry,
    atom: threadAtom,
    predicate: threadHasStarted,
    timeoutMs,
  });
}

export async function waitForRevertedMessage(
  threadRef: ScopedThreadRef,
  messageId: MessageId,
  turnCount: number,
  requestId: CommandId,
  revert: () => Promise<void>,
  timeoutMs = 120_000,
): Promise<ReadonlyArray<string>> {
  const threadAtom = environmentThreadDetails.stateAtom(threadRef);
  const readProjection = () => Option.getOrNull(appAtomRegistry.get(threadAtom).data);
  const initial = readProjection();
  if (!initial?.messages.some((message) => message.id === messageId)) {
    throw new Error("The message to rewind is no longer available.");
  }
  const messageRunId = initial.messages.find((message) => message.id === messageId)?.runId;
  return new Promise<ReadonlyArray<string>>((resolve, reject) => {
    let settled = false;
    let accepted = false;
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      unsubscribe();
      if (error !== undefined) return reject(error);
      const unrestored = readProjection()?.thread.rollbackUnrestored;
      resolve(unrestored?.requestId === requestId ? unrestored.repositories : []);
    };
    const inspect = () => {
      const thread = readProjection();
      if (!thread) return;
      const failure = thread.thread.rollbackFailure;
      if (failure?.requestId === requestId) {
        finish(new Error(failure.message));
        return;
      }
      if (
        accepted &&
        thread.runs.some(
          (run) =>
            run.id === messageRunId && run.ordinal > turnCount && run.status === "rolled_back",
        )
      )
        finish();
    };
    unsubscribe = appAtomRegistry.subscribe(threadAtom, inspect);
    timeout = globalThis.setTimeout(() => {
      finish(new Error(m(msg("Timed out waiting for the thread to rewind."))));
    }, timeoutMs);
    Promise.resolve()
      .then(revert)
      .then(() => {
        accepted = true;
        inspect();
      }, finish);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  submissionIntent: ComposerSubmissionIntent;
  latestUserMessageId: ChatMessage["id"] | null;
  latestRunId: RunId | null;
  latestRunRequestedAt: string | null;
  latestRunStartedAt: string | null;
  latestRunCompletedAt: string | null;
  runtimeStatus: NonNullable<Thread["runtime"]>["status"] | null;
  runtimeUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: {
    environmentId?: EnvironmentId;
    preparingWorktree?: boolean;
    latestUserMessageId?: ChatMessage["id"] | null;
    submissionIntent?: ComposerSubmissionIntent;
  },
): LocalDispatchSnapshot {
  const environmentId = options?.environmentId ?? activeThread?.environmentId;
  const latestRun = activeThread?.latestRun ?? null;
  const runtime = activeThread?.runtime ?? null;
  return {
    startedAt: new Date(
      environmentId === undefined ? Date.now() : toServerClock(environmentId, Date.now()),
    ).toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    submissionIntent: options?.submissionIntent ?? "foreground",
    latestUserMessageId: options?.latestUserMessageId ?? null,
    latestRunId: latestRun?.runId ?? null,
    latestRunRequestedAt: latestRun?.requestedAt ?? null,
    latestRunStartedAt: latestRun?.startedAt ?? null,
    latestRunCompletedAt: latestRun?.completedAt ?? null,
    runtimeStatus: runtime?.status ?? null,
    runtimeUpdatedAt: runtime?.updatedAt ?? null,
  };
}

/**
 * The timeline renders committed user rows from `visibleTurnItems`, but
 * `message.updated` can land in `projection.messages` one event earlier than
 * the matching `turn-item.updated`. Basing optimistic eviction on visible user
 * turn items avoids dropping steer rows in that gap.
 */
export function deriveCommittedServerUserMessageIds(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlySet<ChatMessage["id"]> {
  return new Set(
    visibleTurnItems.flatMap((row) =>
      row.item.type === "user_message" ? [row.item.messageId] : [],
    ),
  );
}

/**
 * The server checks the full history, but the first page of an
 * agent-started thread or a long turn can hold no user message.
 */
export function hasCompactableConversation(input: {
  readonly visibleTurnItems: ThreadStructure["visibleTurnItems"];
  readonly hasMoreHistory: boolean;
  readonly latestUserMessageAt: string | null;
}): boolean {
  return (
    input.visibleTurnItems.some(
      ({ item }) =>
        item.type === "user_message" &&
        (item.text.trim().toLowerCase() !== "/compact" || item.attachments.length > 0),
    ) ||
    (input.hasMoreHistory && input.latestUserMessageAt !== null)
  );
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestRun: Thread["latestRun"] | null;
  latestUserMessageId?: ChatMessage["id"] | null;
  runtime: Thread["runtime"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }
  const latestUserMessageChanged =
    input.localDispatch.latestUserMessageId !== (input.latestUserMessageId ?? null);
  if (input.phase === "connecting" || derivePhase(input.runtime ?? null) === "connecting") {
    // A message queued behind other work, such as an idle compaction the shell hides, has landed.
    return input.runtime?.status === "queued" && latestUserMessageChanged;
  }

  const latestRun = input.latestRun ?? null;
  const runtime = input.runtime ?? null;
  const latestRunChanged =
    input.localDispatch.latestRunId !== (latestRun?.runId ?? null) ||
    input.localDispatch.latestRunRequestedAt !== (latestRun?.requestedAt ?? null) ||
    input.localDispatch.latestRunStartedAt !== (latestRun?.startedAt ?? null) ||
    input.localDispatch.latestRunCompletedAt !== (latestRun?.completedAt ?? null);

  if (input.phase === "running") {
    if (latestUserMessageChanged) {
      return true;
    }
    if (!latestRunChanged) {
      return false;
    }
    if (latestRun?.startedAt === null || latestRun === null) {
      return false;
    }
    if (
      runtime?.activeRunId !== null &&
      runtime?.activeRunId !== undefined &&
      latestRun?.runId !== runtime.activeRunId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestRunChanged ||
    input.localDispatch.runtimeStatus !== (runtime?.status ?? null) ||
    input.localDispatch.runtimeUpdatedAt !== (runtime?.updatedAt ?? null)
  );
}

// Window return puts the caret in the composer unless focus or a selection is deliberate: another
// text field, a terminal, an open dialog, menu, or popup, a region, timeline, or sidebar row reached
// from the keyboard, a region with its own keys (aria-keyshortcuts), or selected text the composer
// would clear. A plain focused button or a clicked row yields to the composer.
export function shouldRefocusComposerOnWindowFocus(
  activeElement:
    | (Pick<Element, "tagName" | "closest" | "getAttribute"> & { isContentEditable?: boolean })
    | null,
  selection: Pick<Selection, "isCollapsed"> | null,
): boolean {
  if (selection !== null && !selection.isCollapsed) return false;
  if (activeElement === null || activeElement.tagName === "BODY") return true;
  if (
    activeElement.tagName === "INPUT" ||
    activeElement.tagName === "TEXTAREA" ||
    activeElement.tagName === "SELECT" ||
    activeElement.tagName === "IFRAME" ||
    activeElement.tagName === "WEBVIEW" ||
    activeElement.isContentEditable === true ||
    activeElement.getAttribute("role") === "textbox"
  ) {
    return false;
  }
  return (
    activeElement.closest(
      '[data-workspace-keyboard-focus], [data-sidebar-row]:focus-visible, [role="dialog"], [role="alertdialog"], [role="application"], [role="menu"], [role="listbox"], [data-slot$="-popup"], [data-terminal-owner], [aria-keyshortcuts]',
    ) === null
  );
}

export interface PlanFollowUpComposerSnapshot {
  readonly prompt: string;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly environmentContexts: ReadonlyArray<EnvironmentContextRecord>;
}

// A draft typed while the send was in flight is newer and stays. Composer refs and the cursor
// belong to the thread on screen, so they follow only while the follow-up's route is current.
export function restorePlanFollowUpComposer(input: {
  readonly snapshot: PlanFollowUpComposerSnapshot;
  readonly draftHasUserContent: boolean;
  readonly routeIsCurrent: boolean;
  readonly writeComposerRefs: (snapshot: PlanFollowUpComposerSnapshot) => void;
  readonly writePrompt: (prompt: string) => void;
  readonly writeTerminalContexts: (contexts: ReadonlyArray<TerminalContextDraft>) => void;
  readonly writeReviewComments: (comments: ReadonlyArray<ReviewCommentContext>) => void;
  readonly writePreviewAnnotations: (annotations: ReadonlyArray<PreviewAnnotationPayload>) => void;
  readonly writeThreadContexts: (records: ReadonlyArray<ThreadContextRecord>) => void;
  readonly writeEnvironmentContexts: (records: ReadonlyArray<EnvironmentContextRecord>) => void;
  readonly resetCursor: (options: {
    cursor: number;
    prompt: string;
    detectTrigger: boolean;
  }) => void;
}): void {
  if (input.draftHasUserContent) return;
  if (input.routeIsCurrent) input.writeComposerRefs(input.snapshot);
  input.writePrompt(input.snapshot.prompt);
  input.writeTerminalContexts(input.snapshot.terminalContexts);
  input.writeReviewComments(input.snapshot.reviewComments);
  input.writePreviewAnnotations(input.snapshot.previewAnnotations);
  input.writeThreadContexts(input.snapshot.threadContexts);
  input.writeEnvironmentContexts(input.snapshot.environmentContexts);
  if (!input.routeIsCurrent) return;
  input.resetCursor({
    cursor: collapseExpandedComposerCursor(input.snapshot.prompt, input.snapshot.prompt.length),
    prompt: input.snapshot.prompt,
    detectTrigger: true,
  });
}

/**
 * The caller clears the composer before awaiting the send, so every field it
 * held has to be written back here: a dropped field silently discards user
 * context.
 */
/**
 * Adds a directly sent preview annotation to the composer's images and
 * annotations. Its screenshot rides along only while the turn has room for
 * another attachment; over the cap the server rejects the whole turn.
 */
export function mergeDirectPreviewAnnotation(input: {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly fileCount: number;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly direct:
    | {
        readonly annotation: PreviewAnnotationPayload;
        readonly image: ComposerImageAttachment | null;
      }
    | undefined;
}): {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
} {
  const { direct } = input;
  if (!direct) return { images: input.images, previewAnnotations: input.previewAnnotations };
  const imageAlreadyAttached =
    direct.image !== null && input.images.some((image) => image.id === direct.image?.id);
  const imageAppended =
    direct.image !== null &&
    !imageAlreadyAttached &&
    input.images.length + input.fileCount < PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
  const images = direct.image && imageAppended ? [...input.images, direct.image] : input.images;
  const previewAnnotations = input.previewAnnotations.some(
    (annotation) => annotation.id === direct.annotation.id,
  )
    ? input.previewAnnotations
    : [
        ...input.previewAnnotations,
        {
          ...direct.annotation,
          // Claim an attached crop only when the screenshot really rides
          // along; a cap-dropped image must not produce a lying prompt.
          screenshot:
            direct.annotation.screenshot && (imageAppended || imageAlreadyAttached)
              ? { ...direct.annotation.screenshot, dataUrl: "" }
              : null,
        },
      ];
  return { images, previewAnnotations };
}

/**
 * Whether a woken thread woke after the user last saw it. A run that completed
 * after the last visit counts as seeing it, since the user watched it finish.
 */
export function isThreadWokeUnseen(input: {
  readonly wokeAt: string | null;
  readonly settled: boolean;
  readonly lastVisitedAt: string | null | undefined;
  readonly latestRunCompletedAt: string | null;
}): boolean {
  if (input.wokeAt === null || input.settled) return false;
  const wokeAtMs = Date.parse(input.wokeAt);
  if (Number.isNaN(wokeAtMs)) return false;
  const seenAt = [input.lastVisitedAt, input.latestRunCompletedAt]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((ms) => !Number.isNaN(ms));
  return seenAt.every((ms) => ms < wokeAtMs);
}

// Null identifies the project checkout when a launch or session is known.
export function resolveTerminalWorktreePath(input: {
  launchContext: { readonly worktreePath: string | null } | null;
  summary: { readonly worktreePath: string | null } | null;
  threadWorktreePath: string | null;
}): string | null {
  if (input.launchContext !== null) return input.launchContext.worktreePath;
  if (input.summary !== null) return input.summary.worktreePath;
  return input.threadWorktreePath;
}

// Errors surface through two maps (draft-keyed and thread-keyed) whose entries
// can race around promotion, so each write carries its time to let the latest
// one win when they collide.
export type LocalThreadErrorEntry = {
  readonly message: string | null;
  readonly at: number;
};

export function chatActionErrorMessage(error: unknown, resolve: MessageResolver = m): string {
  return thrownErrorMessage(error, resolve) ?? resolve(msg("An error occurred."));
}

/** A local copy of the runtime's error shares the runtime's key, so one dismissal covers both. */
function threadErrorIsServerRuntime(input: {
  readonly isServerThread: boolean;
  readonly localServerError: string | null;
  readonly runtimeError: string | null;
}): boolean {
  return (
    input.isServerThread &&
    (input.localServerError === null || input.localServerError === input.runtimeError)
  );
}

// Only server runtime errors get a session dismissal: they persist in projections across
// remounts. Local and draft errors are cleared on dismiss, so a repeat shows again.
export function resolveThreadErrorBanner(input: {
  readonly isServerThread: boolean;
  readonly localServerError: string | null;
  readonly localDraftError: string | null;
  readonly runtimeError: string | null;
  readonly runtimeErrorSource: string | null;
}): {
  readonly threadError: string | null;
  readonly sessionDismissal: {
    readonly error: string;
    readonly source: string | null;
  } | null;
} {
  const threadError = input.isServerThread
    ? (input.localServerError ?? input.runtimeError ?? null)
    : input.localDraftError;
  if (
    threadError === null ||
    !threadErrorIsServerRuntime({
      isServerThread: input.isServerThread,
      localServerError: input.localServerError,
      runtimeError: input.runtimeError,
    })
  ) {
    return { threadError, sessionDismissal: null };
  }
  return {
    threadError,
    sessionDismissal: {
      error: threadError,
      source: input.runtimeErrorSource,
    },
  };
}

export function releaseChatTimelineAnchor<T extends { readonly messageId: MessageId | null }>(
  current: T,
): T {
  return current.messageId === null ? current : { ...current, messageId: null };
}

// The factories below build functions ChatView calls during render, or hands
// to ChatComposer, which can call them after an await. They live outside the
// component so each closure keeps only its inputs, not a whole render scope
// (see useStableCallback), while still acting on the render that made them.

/** Records a thread error in local state, keyed by the route the making render saw. */
export function makeThreadErrorSetter(input: {
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly draftId: DraftId | null;
  readonly serverThreadRef: ScopedThreadRef | null;
  readonly setLocalServerErrorsByThreadKey: (
    update: SetStateAction<Record<string, LocalThreadErrorEntry>>,
  ) => void;
  readonly setLocalDraftErrorsByDraftId: (
    update: SetStateAction<Record<string, LocalThreadErrorEntry>>,
  ) => void;
}) {
  return (targetThreadId: ThreadId | null, error: string | null) => {
    if (!targetThreadId) return;
    const nextError = sanitizeThreadErrorMessage(error);
    const nextEntry: LocalThreadErrorEntry = { message: nextError, at: Date.now() };
    const { routeThreadRef, serverThreadRef } = input;
    if (
      serverThreadRef &&
      targetThreadId === routeThreadRef.threadId &&
      serverThreadRef.environmentId === routeThreadRef.environmentId &&
      serverThreadRef.threadId === targetThreadId
    ) {
      input.setLocalServerErrorsByThreadKey((existing) => {
        if ((existing[input.routeThreadKey]?.message ?? null) === nextError) {
          return existing;
        }
        return { ...existing, [input.routeThreadKey]: nextEntry };
      });
      return;
    }
    const localDraftErrorKey = input.draftId ?? targetThreadId;
    input.setLocalDraftErrorsByDraftId((existing) => {
      if ((existing[localDraftErrorKey]?.message ?? null) === nextError) {
        return existing;
      }
      return { ...existing, [localDraftErrorKey]: nextEntry };
    });
  };
}

/** Why the model picker should disable a model, or null when it can be chosen. */
export function makeModelDisabledReason(
  context: Omit<
    Parameters<typeof getStartedThreadModelChangeBlockReason>[0],
    "nextModelSelection"
  > | null,
  resolve: MessageResolver = m,
) {
  return (instanceId: ProviderInstanceId, model: string): string | null => {
    if (!context) return null;
    const reason = getStartedThreadModelChangeBlockReason(
      { ...context, nextModelSelection: { instanceId, model } },
      resolve,
    );
    return reason
      ? resolve(
          msg("{reason} Start a new thread to use this model.", { reason: reason.description }),
        )
      : null;
  };
}

/** What the composer held when the user pressed send, after a direct annotation merged in. */
export interface ComposerSendContents {
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly sendableTerminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly environmentContexts: ReadonlyArray<EnvironmentContextRecord>;
  /** The response the message replies to. `prompt` already leads with its reference. */
  readonly replyTo: ResponseContextRecord | null;
}

/**
 * Copies the composer contents a send dispatches, so a failed send can put the
 * same draft back. Terminal contexts that lost their text are dropped from both
 * the contexts and the prompt's inline references.
 */
export function snapshotComposerSend(contents: ComposerSendContents) {
  const images = [...contents.images];
  const files = [...contents.files];
  const terminalContexts = [...contents.sendableTerminalContexts];
  const messageText = contents.terminalContexts
    .filter((context) => !terminalContexts.includes(context))
    .reduce(
      (text, context) =>
        removeInlineContextReference(text, terminalContextReference(context).contextId).prompt,
      contents.prompt,
    )
    .trim();
  return {
    images,
    files,
    attachments: [...images, ...files],
    terminalContexts,
    previewAnnotations: [...contents.previewAnnotations],
    reviewComments: [...contents.reviewComments],
    threadContexts: [...contents.threadContexts],
    environmentContexts: [...contents.environmentContexts],
    replyTo: contents.replyTo,
    messageText,
    /** What a failed send puts back in the composer: the reply returns above it, not in the text. */
    draftText: contents.replyTo
      ? removeInlineContextReference(messageText, contents.replyTo.contextId).prompt.trimStart()
      : messageText,
  };
}

export type ComposerSendSnapshot = ReturnType<typeof snapshotComposerSend>;

/** Derived from the persisted run phase, so a starting run still reads as work after a reload. */
export function deriveTimelineWorking(input: {
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
  readonly isCompacting: boolean;
  readonly runlessWorkStartedAt: string | null;
}): boolean {
  return (
    input.phase === "connecting" ||
    input.phase === "running" ||
    input.isSendBusy ||
    input.isCompacting ||
    input.runlessWorkStartedAt !== null
  );
}

/** How a composer send dispatches: where it runs and whether it waits behind other work. */
export function planComposerTurn(input: {
  readonly messageText: string;
  readonly sendQueuesBehindSetup: boolean;
  readonly isServerThread: boolean;
  readonly activeMessageCount: number;
  readonly sendEnvMode: DraftThreadEnvMode;
  readonly worktreePath: string | null;
  readonly activeThreadBranch: string | null;
  /** False for a plain folder that tracks repositories: each starts from its own default branch. */
  readonly projectIsGitRepo: boolean;
  /** For such a plain folder: the branch its repositories start from where they have it. */
  readonly plainProjectBaseBranch?: string | undefined;
  /** The server launches a No project worktree request at its root, so it needs no base. */
  readonly isScratchProject: boolean;
  readonly resumeCompactionTokens: number | null;
  readonly keepFullHistory: boolean;
  readonly phase: SessionPhase;
  readonly dispatchMode: ComposerDispatchMode;
  /** The turn starts a new provider session, so it neither compacts first nor steers. */
  readonly freshContext: boolean;
}) {
  const isFirstMessage =
    !input.sendQueuesBehindSetup && (!input.isServerThread || input.activeMessageCount === 0);
  const shouldCreateWorktree =
    isFirstMessage && input.sendEnvMode === "worktree" && !input.worktreePath;
  // A stale Claude session compacts before this message so the turn does not re-read the
  // old history. The message queues behind the /compact run, since steering into it is
  // rejected.
  const compactBeforeSend =
    !input.freshContext &&
    input.resumeCompactionTokens !== null &&
    !input.keepFullHistory &&
    !COMPACT_COMMAND_PATTERN.test(input.messageText);
  const dispatchMode =
    input.freshContext && (input.dispatchMode === "steer" || input.dispatchMode === "restart")
      ? "queue"
      : input.dispatchMode;
  return {
    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    missingWorktreeBaseBranch:
      shouldCreateWorktree &&
      input.projectIsGitRepo &&
      !input.activeThreadBranch &&
      !input.isScratchProject,
    // The launch schema requires a base ref; `HEAD` leaves each repository on its default branch.
    baseBranchForWorktree: !shouldCreateWorktree
      ? null
      : input.projectIsGitRepo
        ? input.activeThreadBranch
        : input.plainProjectBaseBranch || "HEAD",
    compactBeforeSend,
    turnDispatchMode:
      compactBeforeSend || (input.sendQueuesBehindSetup && dispatchMode !== "steer")
        ? ("queue" as const)
        : dispatchMode,
    shouldQueueBehindActiveRun:
      compactBeforeSend ||
      input.sendQueuesBehindSetup ||
      (input.phase === "running" && dispatchMode === "queue"),
  };
}

/**
 * The attachment ids a message's context records bind to: the upload id the
 * server returned, or the local id on the data-URL path.
 */
export function boundAttachmentIds(
  turnAttachments: ReadonlyArray<{ readonly id?: string | undefined }>,
  attachments: ReadonlyArray<{ readonly id: string }>,
): string[] {
  return turnAttachments.map((attachment, index) =>
    "id" in attachment && attachment.id !== undefined ? attachment.id : attachments[index]!.id,
  );
}

export function withMessageContext(input: {
  readonly text: string;
  readonly context: OrchestrationMessageContext | undefined;
}): { readonly text: string; readonly context?: OrchestrationMessageContext } {
  const { text, context } = input;
  if (context === undefined) return { text };
  return { text, context };
}

/** The attachments the optimistic user row shows before the server echoes the message. */
export function optimisticMessageAttachments(
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
) {
  return attachments.map((attachment) =>
    attachment.type === "image"
      ? {
          type: "image" as const,
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          previewUrl: attachment.previewUrl,
          ...(attachment.source ? { source: attachment.source } : {}),
        }
      : {
          type: "file" as const,
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          downloadable: false,
          ...(attachment.source ? { source: attachment.source } : {}),
        },
  );
}

/** Fallback title sources for a message with no text of its own. */
export function sendTitleFallbackLabels(
  snapshot: Pick<
    ComposerSendSnapshot,
    "terminalContexts" | "reviewComments" | "previewAnnotations"
  >,
  resolve: MessageResolver = m,
) {
  const terminalContext = snapshot.terminalContexts[0];
  const reviewComment = snapshot.reviewComments[0];
  const previewAnnotation = snapshot.previewAnnotations[0];
  return [
    terminalContext ? formatTerminalContextLabel(terminalContext) : undefined,
    reviewComment
      ? resolve(
          msg("Review: {label}", {
            label: reviewCommentContextLabel(reviewComment, resolve),
            $context: "title seed for a new thread started from a review comment",
          }),
        )
      : undefined,
    previewAnnotation ? previewAnnotationContextLabel(previewAnnotation, resolve) : undefined,
  ];
}

/**
 * A thread shell built from its loaded detail, for direct links that hydrate the detail first.
 * `updatedAt` and `lastVisitedAt` are passed live: the thread structure leaves them out.
 */
export function presentThreadShellFromProjection(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projection: ThreadStructure,
  live: {
    readonly updatedAt: ThreadProjection["updatedAt"];
    readonly lastVisitedAt: ThreadProjection["thread"]["lastVisitedAt"];
  },
) {
  const { updatedAt, lastVisitedAt } = live;
  const latestRun = deriveLatestThreadRun(projection);
  const runtime = deriveThreadRuntime({ ...projection, updatedAt });
  const pendingRuntimeRequest =
    projection.runtimeRequests.findLast((request) => request.status === "pending") ?? null;
  // Direct links can hydrate detail before the thread enters the shell index.
  return {
    ...presentThreadShell(environmentId, {
      ...projection.thread,
      lastVisitedAt,
      latestRunId: latestRun?.runId ?? null,
      activeRunId: runtime?.activeRunId ?? null,
      status: runtime?.status ?? "idle",
      pendingRuntimeRequest,
      latestVisibleMessage: null,
      latestUserMessageAt:
        projection.messages.findLast((message) => message.role === "user")?.updatedAt ?? null,
      hasActionableProposedPlan: projection.plans.some(
        (plan) => plan.kind === "proposed_plan" && plan.status === "active",
      ),
      providerInstanceHistory: [
        ...new Set(
          projection.providerThreads
            .filter((thread) => thread.appThreadId === threadId && thread.ownerNodeId === null)
            .map((thread) => thread.providerInstanceId),
        ),
      ],
      goal:
        projection.providerThreads.find(
          (thread) => thread.id === projection.thread.activeProviderThreadId,
        )?.goal ?? null,
      itemCount: projection.turnItems.length,
      visibleItemCount: projection.visibleTurnItems.length,
      updatedAt,
    }),
    latestRun,
    runtime,
  };
}

// Excludes `waiting`: that is post-terminal checkpoint drain, so its agent turn is over.
const LIVE_RUN_STATUSES = new Set(["queued", "preparing", "starting", "running"]);

/**
 * Background work the provider still runs after an earlier run ended. It
 * stays listed while a later run is live; that live run's own items are its
 * foreground work, so they never count as background. The provider roster is
 * not run-tied, so it drops entries naming a live run's item by native id.
 */
export function deriveThreadPendingBackgroundTasks(projection: ThreadStructure | null) {
  if (projection === null) return [];
  const sessionError =
    projection.providerSessions.findLast(
      (session) => session.providerInstanceId === projection.thread.providerInstanceId,
    )?.lastError ?? null;
  const liveRunIds = new Set(
    projection.runs.filter((run) => LIVE_RUN_STATUSES.has(run.status)).map((run) => run.id),
  );
  const foregroundTaskIds = new Set<string>();
  for (const item of projection.turnItems) {
    if (item.runId === null || !liveRunIds.has(item.runId)) continue;
    if (item.nativeItemRef?.nativeId) foregroundTaskIds.add(item.nativeItemRef.nativeId);
  }
  const latestRun =
    usageLimitRunPresentedAsLatest(projection.runs, projection.turnItems, sessionError) ??
    latestUnheldRun(projection.runs.filter((run) => !liveRunIds.has(run.id)));
  return [
    ...derivePendingBackgroundWork({
      latestRun,
      providerThreads: projection.providerThreads.map((thread) => ({
        ...thread,
        pendingBackgroundTasks: thread.pendingBackgroundTasks?.filter(
          (task) => !foregroundTaskIds.has(task.taskId),
        ),
      })),
      turnItems: projection.turnItems.filter(
        (item) => item.runId === null || !liveRunIds.has(item.runId),
      ),
      activeProviderThreadId: projection.thread.activeProviderThreadId,
      hasActiveRun: false,
      runs: projection.runs,
      pullRequests: projection.thread.pullRequests,
    }),
  ];
}

/**
 * Run ordinals the conversation can be reverted to: those whose provider turn belongs to the
 * active provider thread, plus 0 for the thread start. Empty without a live provider session
 * on the thread's selected instance.
 */
export function deriveAvailableRevertTurnCounts(projection: ThreadStructure | null) {
  const available = new Set<number>();
  const providerThread = projection?.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  if (
    !providerThread?.providerSessionId ||
    providerThread.providerInstanceId !== projection?.thread.modelSelection.instanceId
  )
    return available;
  available.add(0);
  const attemptsById = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
  const providerTurnsById = new Map<
    OrchestrationV2ProviderTurn["id"],
    OrchestrationV2ProviderTurn
  >();
  const latestTurnByAttempt = new Map<RunAttemptId, OrchestrationV2ProviderTurn>();
  for (const turn of projection.providerTurns) {
    providerTurnsById.set(turn.id, turn);
    if (turn.runAttemptId === null) continue;
    const latest = latestTurnByAttempt.get(turn.runAttemptId);
    if (latest === undefined || turn.ordinal > latest.ordinal) {
      latestTurnByAttempt.set(turn.runAttemptId, turn);
    }
  }
  for (const run of projection.runs) {
    if (run.activeAttemptId === null) continue;
    const attempt = attemptsById.get(run.activeAttemptId);
    const providerTurn =
      latestTurnByAttempt.get(run.activeAttemptId) ??
      (attempt?.providerTurnId == null ? undefined : providerTurnsById.get(attempt.providerTurnId));
    // A ready file checkpoint alone cannot restore the provider conversation.
    if (providerTurn?.providerThreadId === providerThread.id) available.add(run.ordinal);
  }
  return available;
}

/** An imported native session is bound before it has messages or runs, and its cwd is fixed. */
export function isThreadEnvironmentLocked(input: {
  readonly messageCount: number;
  readonly hasRuntime: boolean;
  readonly activeProviderThreadId: ProviderThreadId | null;
}): boolean {
  return input.messageCount > 0 || input.hasRuntime || input.activeProviderThreadId !== null;
}
