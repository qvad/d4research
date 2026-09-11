import { Effect, Option } from "effect";
import { ThreadId } from "@d4research/contracts";
import { ServerSettingsService } from "./serverSettings.ts";
import { makeConfiguredMemoryConnector } from "./mcp/toolkits/memory/localConnector.ts";
import { saveMekoHandoff } from "./mekoHandoff.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";

export const persistHandoffMemory = Effect.fn("persistHandoffMemory")(function* (input: {
  text: string;
  project?: string | undefined;
  threadId?: string | undefined;
}) {
  const settings = yield* (yield* ServerSettingsService).getSettings;
  if (settings.handoff.memoryBackend === "none") return { ok: false };
  if (settings.handoff.memoryBackend === "meko") {
    const query = yield* ProjectionSnapshotQuery;
    const thread = input.threadId
      ? yield* query.getThreadShellById(ThreadId.make(input.threadId)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        )
      : undefined;
    const receipt = yield* saveMekoHandoff(settings.handoff.meko, {
      text: input.text,
      project: thread ? String(thread.projectId) : "",
      threadId: input.threadId ?? "",
    });
    return { ok: receipt.status === "SUCCESS_WITH_EVIDENCE", receipt };
  }
  if (!settings.memory.localEnabled) return { ok: false };
  return yield* Effect.gen(function* () {
    const connector = yield* makeConfiguredMemoryConnector();
    return yield* connector.add(input.text, "t3research-provider-handoff", input.project);
  }).pipe(Effect.orElseSucceed(() => ({ ok: false })));
});
