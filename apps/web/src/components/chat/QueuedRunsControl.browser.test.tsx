import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentThreadState } from "@d4research/client-runtime/state/threads";
import { CommandId, MessageId, OrchestrationV2DispatchCommandError } from "@d4research/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { Profiler, useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  threadState: null as unknown as Atom.Writable<AsyncResult.AsyncResult<EnvironmentThreadState>>,
  projection: null as { projection: { messages: unknown[] } } | null,
  workflow: null as unknown,
  commandResult: undefined as unknown,
}));

vi.mock(import("@d4research/client-runtime/state/thread-workflows"), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveThreadQueueWorkflowState: (() => state.workflow) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
}));

// The thread detail atoms are real, fed by one state atom the test writes.
vi.mock(import("../../state/threads"), async (importOriginal) => {
  const { createEnvironmentThreadDetailAtoms, EMPTY_ENVIRONMENT_THREAD_STATE } =
    await import("@d4research/client-runtime/state/threads");
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  const { makeThreadProjectionFixture } = await import("../../test-fixtures");
  state.threadState = Atom.make<AsyncResult.AsyncResult<EnvironmentThreadState>>(
    AsyncResult.success({
      ...EMPTY_ENVIRONMENT_THREAD_STATE,
      data: Option.some(makeThreadProjectionFixture()),
    }),
  ).pipe(Atom.keepAlive);
  return {
    ...(await importOriginal()),
    environmentThreadDetails: createEnvironmentThreadDetailAtoms(() => state.threadState),
  };
});

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async () => state.commandResult) as never,
}));

vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`)) as never,
}));

import { act, render as renderUi, render as renderComponent } from "../../../test/render";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@d4research/client-runtime/state/threads";
import { makeStreamingTimelineFixture, makeThreadProjectionFixture } from "../../test-fixtures";
import { ToastProvider } from "../ui/toast";
import "~/index.css";

function setup() {
  state.projection = null;
  state.workflow = null;
  state.commandResult = undefined;
}

import { QueuedRunsControl } from "./QueuedRunsControl";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

const baseProps = {
  environmentId: "environment:test" as never,
  optimisticMessages: [],
  threadId: "thread:test" as never,
  editingRunId: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

async function render(props: Partial<ComponentProps<typeof QueuedRunsControl>> = {}) {
  const registry = AtomRegistry.make();
  if (state.projection)
    registry.set(
      state.threadState,
      AsyncResult.success({
        ...EMPTY_ENVIRONMENT_THREAD_STATE,
        data: Option.some({
          ...makeThreadProjectionFixture(),
          messages: state.projection.projection.messages,
        } as ReturnType<typeof makeThreadProjectionFixture>),
      }),
    );
  await using stack = new AsyncDisposableStack();
  stack.defer(() => registry.dispose());
  const screen = await renderComponent(
    <RegistryContext.Provider value={registry}>
      <QueuedRunsControl {...baseProps} {...props} />
    </RegistryContext.Provider>,
    { router: false },
  );
  const disposeScreen = screen[Symbol.asyncDispose].bind(screen);
  stack.defer(disposeScreen);
  const resources = stack.move();
  return Object.assign(screen, { [Symbol.asyncDispose]: () => resources[Symbol.asyncDispose]() });
}

it.each([false, true])(
  "opens queued images in the existing gallery, pending=%s",
  async (pending) => {
    setup();
    const attachments = ["first.png", "second.png"].map((name) => ({
      type: "image" as const,
      id: name,
      name,
      mimeType: "image/png",
      sizeBytes: 128,
    }));
    state.workflow = {
      activeRun: null,
      queuedRuns: pending
        ? []
        : [
            {
              run: { id: "run:queued", userMessageId: "message:queued" },
              text: "Later",
              attachments,
            },
          ],
    };
    function QueueWithGallery() {
      const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
      return (
        <>
          <QueuedRunsControl
            {...baseProps}
            optimisticMessages={
              pending
                ? [
                    {
                      id: MessageId.make("message:pending"),
                      inputIntent: "queued_turn",
                      text: "Later",
                      attachments: attachments.map((attachment) => ({
                        ...attachment,
                        previewUrl: `https://assets.test/${attachment.id}`,
                      })),
                    },
                  ]
                : []
            }
            onImageExpand={setPreview}
          />
          {preview ? (
            <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} />
          ) : null}
        </>
      );
    }
    await using _screen = await renderUi(<QueueWithGallery />);

    await page.getByRole("button", { name: "Preview second.png", exact: true }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByText("second.png (2/2)", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Previous media", exact: true }).click();
    await expect.element(page.getByText("first.png (1/2)", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back, close image preview", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(page.getByText("Later", { exact: true })).toBeVisible();
  },
);

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("[aria-label]")].map((element) =>
    element.getAttribute("aria-label"),
  );

describe("QueuedRunsControl automatic completion delivery", () => {
  it("does not render a queue control when only hidden delivery remains", async () => {
    state.projection = {
      projection: {
        messages: [
          {
            delegatedCompletion: {
              parentRunId: "run:parent",
              generation: 1,
              taskIds: ["task:child"],
            },
            id: "message:completion",
          },
        ],
      },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    await using screen = await render();

    expect(screen.container.childElementCount).toBe(0);
  });
});

describe("QueuedRunsControl attachments and edit mode", () => {
  const workflowWithAttachment = () => ({
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Queued with a screenshot",
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 128,
          },
        ],
      },
    ],
  });

  it("renders an attachment thumbnail on the queued row", async () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    await using screen = await render();

    expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(
      "https://assets.test/attachment-1",
    );
    expect(screen.container.textContent).toContain("Queued with a screenshot");
    expect(labels(screen.container)).toContain("Edit queued message");
    expect(labels(screen.container)).toContain(
      "Reorder queued message (drag, or press the arrow keys)",
    );
    expect(labels(screen.container)).not.toContain("Move queued message up");
  });

  it("drops the optimistic pending row once the projection holds its message", async () => {
    state.projection = {
      projection: { messages: [{ id: "message:acknowledged", text: "hello" }] },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    await using screen = await render({
      optimisticMessages: [
        {
          id: "message:acknowledged" as never,
          inputIntent: "queued_turn",
          text: "hello",
          attachments: [],
        },
      ],
    });

    expect(screen.container.childElementCount).toBe(0);
  });

  it("keeps the original queued message visible while editing", async () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    await using screen = await render({ editingRunId: "run:queued" as never });

    expect(screen.container.textContent).toContain("Queued with a screenshot");
  });
});

it("does not re-render while assistant text streams into the thread", async () => {
  setup();
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Run the tests next",
        attachments: [],
      },
    ],
  };
  const base = makeThreadProjectionFixture();
  // Each delta replaces only the streaming reply; every other item keeps its identity.
  const timeline = makeStreamingTimelineFixture().visibleTurnItems;
  const thread = (text: string, done = false) => {
    const items = timeline.map((entry) =>
      entry.item.type === "assistant_message" && entry.item.streaming
        ? {
            ...entry,
            item: done
              ? { ...entry.item, text, streaming: false, status: "completed" as const }
              : { ...entry.item, text },
          }
        : entry,
    );
    return AsyncResult.success<EnvironmentThreadState>({
      ...EMPTY_ENVIRONMENT_THREAD_STATE,
      data: Option.some({
        ...base,
        turnItems: items.map(({ item }) => item),
        visibleTurnItems: items,
      }),
    });
  };
  const registry = AtomRegistry.make();
  await using stack = new AsyncDisposableStack();
  stack.defer(() => registry.dispose());
  registry.set(state.threadState, thread("Hel"));
  let renders = 0;
  await using _screen = await renderUi(
    <RegistryContext.Provider value={registry}>
      <Profiler id="queue" onRender={() => (renders += 1)}>
        <QueuedRunsControl {...baseProps} />
      </Profiler>
    </RegistryContext.Provider>,
  );
  await expect.element(page.getByText("Run the tests next", { exact: true })).toBeVisible();
  const settled = renders;

  await act(() => registry.set(state.threadState, thread("Hello")));
  await act(() => registry.set(state.threadState, thread("Hello there")));
  expect(renders).toBe(settled);

  await act(() => registry.set(state.threadState, thread("Hello there", true)));
  expect(renders).toBeGreaterThan(settled);
});

it("tells the user why Send now was rejected", async () => {
  setup();
  const reason = "Target run run:active is stopping and cannot be steered.";
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Follow up",
        attachments: [],
      },
    ],
  };
  state.commandResult = AsyncResult.failure(
    Cause.fail(
      new OrchestrationV2DispatchCommandError({
        commandId: CommandId.make("command:promote"),
        commandType: "queued-message.promote-to-steer",
        message: reason,
        detail: reason,
      }),
    ),
  );
  await using _screen = await renderUi(
    <ToastProvider timeout={0}>
      <QueuedRunsControl {...baseProps} />
    </ToastProvider>,
  );

  await page.getByRole("button", { name: "Steer" }).click();
  await vi.waitFor(() => expect(page.getByText(reason).element()).toBeVisible());
});
