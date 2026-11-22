import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PullRequestDetail } from "@d4research/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { usePullRequestAgentActions } from "./usePullRequestAgentActions";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

const state = vi.hoisted(() => ({
  connected: false,
  canAsk: true,
  ask: vi.fn(),
}));
vi.mock("./usePullRequestConnected", () => ({
  usePullRequestConnected: () => state.connected,
}));
vi.mock("./usePullRequestThreads", () => ({
  usePullRequestThreads: () => ({
    threads: [],
    canAsk: state.canAsk,
    canWatch: true,
    busy: false,
    isPending: true,
    ask: state.ask,
  }),
}));
const params = {
  environmentId: "environment",
  projectId: "project",
  repository: "owner/repo",
  number: 1,
};
const pr = { state: "open", mergeability: "conflicting" } as PullRequestDetail;

function renderActions() {
  let actions: ReturnType<typeof usePullRequestAgentActions> | undefined;
  function Probe() {
    actions = usePullRequestAgentActions(params, pr);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (!actions) throw new Error("Actions were not rendered");
  return actions;
}

beforeEach(() => {
  state.connected = false;
  state.canAsk = true;
  state.ask.mockClear();
});

describe("PR agent drafts", () => {
  it("opens offline drafts without waiting for linked-thread discovery", () => {
    const actions = renderActions();
    expect(actions.disabled).toBe(false);
    actions.start("ask");
    actions.start("explain");
    expect(state.ask.mock.calls).toEqual([
      [undefined, "ask"],
      [undefined, "explain"],
    ]);
  });

  it("does not open drafts when the connection denies task access", () => {
    state.connected = true;
    state.canAsk = false;
    renderActions().start("explain");
    expect(state.ask).not.toHaveBeenCalled();
  });
});
