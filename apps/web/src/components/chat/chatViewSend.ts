import {
  CommandId,
  type EnvironmentId,
  type ScopedThreadRef,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ModelSelection,
  type ProviderInteractionMode,
  type ThreadId,
} from "@d4research/contracts";
import { msg } from "gt-react";
import { Atom } from "effect/reactivity";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@d4research/client-runtime/state/runtime";
import { m } from "../../i18n/messages";
import { findRevertCheckpoint } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { randomUUID } from "../../lib/utils";
import { toastManager } from "../ui/toast";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { prepareRevertedMessageAttachments, waitForRevertedMessage } from "../ChatView.logic";
import { readPreparedConnection } from "../../state/session";
import { recallComposerMessage } from "./composerPromptHistory";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import {
  cloneComposerImageForRetry,
  readFileAsDataUrl,
  type ComposerSendSnapshot,
} from "../ChatView.logic";
import {
  refreshExpiredAttachmentUploads,
  getUploadedAttachments,
} from "../../lib/attachmentUploadQueue";

const draftSendStateByRouteKey = new Map<
  string,
  {
    readonly sendInFlight: { current: boolean };
    readonly uncertainSubmissions: { current: Map<string, ThreadId> };
  }
>();
export const draftFanoutSelectionsAtom = Atom.family((_routeKey: string) =>
  Atom.make<ReadonlyArray<ModelSelection> | null>(null).pipe(Atom.keepAlive),
);
export function draftSendState(routeKey: string) {
  let state = draftSendStateByRouteKey.get(routeKey);
  if (!state) {
    state = { sendInFlight: { current: false }, uncertainSubmissions: { current: new Map() } };
    draftSendStateByRouteKey.set(routeKey, state);
  }
  return state;
}

export interface MultipleModelTarget {
  readonly selection: ModelSelection;
  readonly text: string;
  readonly interactionMode: ProviderInteractionMode;
}

export async function rewindToMessage(input: {
  readonly message: ChatMessage;
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly turnCount: number;
  readonly restoreFiles: boolean;
  readonly checkpoint: ReturnType<typeof findRevertCheckpoint>;
  readonly draftTarget: ScopedThreadRef | DraftId;
  readonly composerHasPendingAttachments: boolean;
  readonly createAssetUrl: Parameters<
    typeof prepareRevertedMessageAttachments
  >[0]["createAssetUrl"];
  readonly revertThreadCheckpoint: (value: {
    environmentId: EnvironmentId;
    input: {
      commandId: CommandId;
      threadId: ThreadId;
      turnCount: number;
      restoreFiles: boolean;
      checkpointId?: string;
      scopeId?: string;
    };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<
  | { readonly error: string; readonly prompt?: never }
  | { readonly error: null; readonly prompt: string }
> {
  const { message, environmentId, draftTarget } = input;
  try {
    if (input.composerHasPendingAttachments) {
      throw new Error(m(msg("Wait for attachments to finish preparing before rewinding.")));
    }
    const connection = readPreparedConnection(environmentId);
    if (!connection) throw new Error(m(msg("The environment is not connected.")));
    const files = await prepareRevertedMessageAttachments({
      message,
      environmentId,
      httpBaseUrl: connection.httpBaseUrl,
      createAssetUrl: input.createAssetUrl,
    });
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(draftTarget);
    if (
      (draft?.images.length ?? 0) + (draft?.files.length ?? 0) + files.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      throw new Error(
        m(msg("Make room for this message's attachments in the composer before rewinding.")),
      );
    }
    const commandId = CommandId.make(randomUUID());
    const unrestored = await waitForRevertedMessage(
      input.routeThreadRef,
      message.id,
      input.turnCount,
      commandId,
      async () => {
        const result = await input.revertThreadCheckpoint({
          environmentId,
          input: {
            commandId,
            threadId: input.threadId,
            turnCount: input.turnCount,
            restoreFiles: input.restoreFiles,
            ...(input.checkpoint === undefined
              ? {}
              : { checkpointId: input.checkpoint.id, scopeId: input.checkpoint.scopeId }),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      },
    );
    if (unrestored.length > 0) {
      toastManager.add({
        type: "warning",
        title: m(msg("Some repositories were not rewound")),
        description: m(
          msg(
            "{count, plural, one {{repositories} had no snapshot from before these turns, so it keeps the changes. Check the uncommitted changes there.} other {{repositories} had no snapshot from before these turns, so they keep the changes. Check the uncommitted changes there.}}",
            { repositories: unrestored.join(", "), count: unrestored.length },
          ),
        ),
      });
    }
    const currentPrompt = store.getComposerDraft(draftTarget)?.prompt ?? "";
    const { prompt: restoredPrompt, mentions } = recallComposerMessage(message);
    const nextPrompt =
      restoredPrompt.length === 0
        ? currentPrompt
        : currentPrompt.length > 0
          ? `${currentPrompt}\n\n${restoredPrompt}`
          : restoredPrompt;
    store.setPrompt(draftTarget, nextPrompt);
    // The restored prompt already carries the chips; these add only their records.
    store.addThreadContexts(draftTarget, mentions.threadContexts, { appendReference: false });
    store.addEnvironmentContexts(draftTarget, mentions.environmentContexts, {
      appendReference: false,
    });
    const images: ComposerImageAttachment[] = [];
    const restoredFiles: ComposerFileAttachment[] = [];
    files.forEach((file, index) => {
      const attachment = {
        id: randomUUID(),
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      };
      if (message.attachments?.[index]?.type === "image") {
        images.push({ ...attachment, type: "image", previewUrl: URL.createObjectURL(file) });
      } else {
        restoredFiles.push({ ...attachment, type: "file" });
      }
    });
    store.addImages(draftTarget, images, { allowDuplicates: true });
    store.addFiles(draftTarget, restoredFiles, { allowDuplicates: true });
    return { error: null, prompt: nextPrompt };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : m(msg("Failed to revert thread state.")),
    };
  }
}

function withRestored<T>(
  existing: ReadonlyArray<T> | undefined,
  restored: ReadonlyArray<T>,
  key: (item: T) => string,
): T[] {
  const kept = existing ?? [];
  return [...kept, ...restored.filter((item) => !kept.some((other) => key(other) === key(item)))];
}

/**
 * Writes a failed send's composer contents back into its draft, after anything
 * typed since. Returns the restored images, which are fresh copies so their
 * preview URLs outlive the optimistic row that held the originals.
 */
export function restoreComposerDraft(
  draftTarget: ScopedThreadRef | DraftId,
  snapshot: ComposerSendSnapshot,
): ComposerImageAttachment[] {
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(draftTarget);
  const images = snapshot.images.map(cloneComposerImageForRetry);
  store.setPrompt(
    draftTarget,
    current?.prompt.trim() ? `${current.prompt}\n\n${snapshot.draftText}` : snapshot.draftText,
  );
  store.setReplyTo(draftTarget, current?.replyTo ?? snapshot.replyTo);
  store.addImages(draftTarget, images);
  store.addFiles(draftTarget, snapshot.files);
  store.setTerminalContexts(
    draftTarget,
    withRestored(current?.terminalContexts, snapshot.terminalContexts, (context) => context.id),
  );
  store.setPreviewAnnotations(
    draftTarget,
    withRestored(current?.previewAnnotations, snapshot.previewAnnotations, (entry) => entry.id),
  );
  store.setReviewComments(
    draftTarget,
    withRestored(current?.reviewComments, snapshot.reviewComments, (comment) => comment.id),
  );
  store.setThreadContexts(
    draftTarget,
    withRestored(current?.threadContexts, snapshot.threadContexts, (record) => record.contextId),
  );
  store.setEnvironmentContexts(
    draftTarget,
    withRestored(
      current?.environmentContexts,
      snapshot.environmentContexts,
      (record) => record.contextId,
    ),
  );
  return images;
}

export function prepareTurnAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
  readonly usesAttachmentUploads: boolean;
  readonly draftTarget: ComposerThreadTarget;
}) {
  const { environmentId, usesAttachmentUploads, draftTarget } = input;
  return Promise.all(
    input.attachments.map(async (attachment) => {
      if (usesAttachmentUploads) {
        await refreshExpiredAttachmentUploads({
          environmentId,
          images: [attachment],
          draftTarget,
        });
        const uploaded = getUploadedAttachments({ environmentId, images: [attachment] })?.[0];
        if (!uploaded) {
          throw new Error(
            m(msg("Attachment ''{name}'' failed to upload.", { name: attachment.name })),
          );
        }
        return uploaded;
      }
      if (attachment.type !== "image") {
        throw new Error(m(msg("This server does not support file attachments.")));
      }
      return {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl: await readFileAsDataUrl(attachment.file),
        ...(attachment.source ? { source: attachment.source } : {}),
      };
    }),
  );
}
