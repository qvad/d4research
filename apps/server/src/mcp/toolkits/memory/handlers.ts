import * as Effect from "effect/Effect";

import { searchMemoAttachment } from "../../../memoAttachment.ts";
import { makeConfiguredMemoryConnector } from "./localConnector.ts";
import { MemoryToolkit } from "./tools.ts";
import { mekoHandoff } from "../../../mekoHandoff.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const getLocalConnector = makeConfiguredMemoryConnector;

const handlers = {
  handoff_status: () =>
    Effect.gen(function* () {
      const settings = yield* (yield* ServerSettingsService).getSettings;
      const invocation = yield* McpInvocationContext;
      if (settings.handoff.memoryBackend !== "meko")
        return { configured: false, recent: [], message: "Meko handoff memory is not selected." };
      return mekoHandoff.status(settings.handoff.meko, String(invocation.threadId));
    }),
  handoff_recall: (input) =>
    Effect.gen(function* () {
      const settings = yield* (yield* ServerSettingsService).getSettings;
      const invocation = yield* McpInvocationContext;
      const query = yield* ProjectionSnapshotQuery;
      const thread = yield* query.getThreadShellById(invocation.threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (settings.handoff.memoryBackend !== "meko" || !thread)
        return {
          receipt: {
            status: "ERROR_CONFIGURATION" as const,
            message: "Meko handoff memory is not selected or the thread is unavailable.",
            timestamp: DateTime.formatIso(yield* DateTime.now),
          },
        };
      return yield* Effect.promise(() =>
        mekoHandoff.read(settings.handoff.meko, {
          ...input,
          threadId: String(invocation.threadId),
          project: String(thread.projectId),
        }),
      );
    }),
  memory_search: (input) =>
    Effect.gen(function* () {
      const result = yield* (yield* getLocalConnector()).search(
        input.query,
        input.limit,
        input.project,
      );
      return { connector: "local" as const, results: result.results, count: result.results.length };
    }),
  memory_remember: (input) =>
    Effect.gen(function* () {
      const result = yield* (yield* getLocalConnector()).add(
        input.text,
        input.source,
        input.project,
      );
      return {
        connector: "local" as const,
        ok: result.ok,
        ...(result.id === undefined ? {} : { id: result.id }),
        ...(result.hash === undefined ? {} : { hash: result.hash }),
      };
    }),
  memory_status: () =>
    Effect.gen(function* () {
      const result = yield* (yield* getLocalConnector()).health();
      return { connector: "local" as const, ...result };
    }),
  memory_attachment_search: (input) =>
    Effect.gen(function* () {
      const memoConnector = yield* getLocalConnector();
      const searched = yield* searchMemoAttachment({
        connector: memoConnector,
        documentToken: input.documentToken,
        query: input.query,
        limit: input.limit,
        ...(input.project === undefined ? {} : { project: input.project }),
      });
      return {
        connector: "local" as const,
        documentToken: input.documentToken,
        status: searched.status,
        results: searched.results,
        count: searched.results.length,
      };
    }),
} satisfies Parameters<typeof MemoryToolkit.toLayer>[0];

export const MemoryToolkitHandlersLive = MemoryToolkit.toLayer(handlers);
