import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, useEffect, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Listener = (event: { readonly data?: { readonly closing: boolean } }) => void;

const harness = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>();
  const state = { focused: true };
  return {
    state,
    listeners,
    navigation: {
      isFocused: () => state.focused,
      addListener(type: string, listener: Listener) {
        let set = listeners.get(type);
        if (set === undefined) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(listener);
        return () => set.delete(listener);
      },
    },
    emit(type: string, data?: { readonly closing: boolean }) {
      for (const listener of listeners.get(type) ?? []) listener({ data });
    },
  };
});

vi.mock("@react-navigation/native", () => ({
  useNavigation: () => harness.navigation,
}));

import {
  recordHomeFocus,
  recordHomeTransitionEnd,
  recordHomeTransitionStart,
  useAtomValueWhileVisible,
  useHomeRouteVisible,
} from "./home-route-visibility";
import {
  NativePrimaryColumnContext,
  NativeWorkspaceTabActivityContext,
} from "../../native/v5-workspace-context";

const shellsAtom = Atom.make(0).pipe(Atom.keepAlive);
let registry: AtomRegistry.AtomRegistry;
let root: Root | null = null;
let renders: Array<{ readonly visible: boolean; readonly value: number }> = [];

function Probe() {
  const visible = useHomeRouteVisible();
  const value = useAtomValueWhileVisible(shellsAtom, visible);
  useEffect(() => {
    renders.push({ visible, value });
  });
  return null;
}

function mount(primaryColumn: { readonly presented: boolean } | null = null) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  act(() =>
    root!.render(
      <RegistryContext.Provider value={registry}>
        <NativePrimaryColumnContext
          value={
            primaryColumn && {
              ...primaryColumn,
              selectedThreadKey: null,
              selectedPullRequestKey: null,
              selectedIssueKey: null,
            }
          }
        >
          <Probe />
        </NativePrimaryColumnContext>
      </RegistryContext.Provider>,
    ),
  );
}

function stream(count: number) {
  for (let index = 0; index < count; index += 1) {
    act(() => registry.update(shellsAtom, (value) => value + 1));
  }
}

function pushThread() {
  act(() => recordHomeTransitionStart(true));
  act(() => recordHomeTransitionEnd(true));
}

beforeEach(() => {
  registry = AtomRegistry.make();
  harness.listeners.clear();
  harness.state.focused = true;
  renders = [];
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  registry.dispose();
});

describe("Home route visibility", () => {
  it("re-renders for every shell update while Home is visible", () => {
    mount();
    stream(20);
    expect(renders.at(-1)).toEqual({ visible: true, value: 20 });
    expect(renders).toHaveLength(21);
  });

  it("stays live until the covering Thread finishes its push animation", () => {
    mount();
    act(() => recordHomeTransitionStart(true));
    stream(3);
    expect(renders.at(-1)).toEqual({ visible: true, value: 3 });
  });

  it("does no work for shell updates while a Thread covers Home", () => {
    mount();
    stream(2);
    pushThread();
    const before = renders.length;
    stream(600);
    expect(renders.length - before).toBe(0);
    expect(renders.at(-1)).toEqual({ visible: false, value: 2 });
  });

  it("shows the freshest list as soon as a back swipe starts revealing Home", () => {
    mount();
    pushThread();
    stream(50);
    act(() => recordHomeTransitionStart(false));
    expect(renders.at(-1)).toEqual({ visible: true, value: 50 });
    stream(1);
    expect(renders.at(-1)).toEqual({ visible: true, value: 51 });
  });

  it("refreshes on focus when no appear event arrives", () => {
    mount();
    pushThread();
    stream(5);
    act(() => recordHomeFocus());
    expect(renders.at(-1)).toEqual({ visible: true, value: 5 });
  });

  it("stays live when Home remounts in a presented sidebar beside a focused detail", () => {
    // Switching sidebar tabs remounts Home with no appearance event while a thread has focus.
    harness.state.focused = false;
    mount({ presented: true });
    stream(3);
    expect(renders.at(-1)).toEqual({ visible: true, value: 3 });
  });

  it("starts hidden when a deep link mounts Home under its Thread", () => {
    harness.state.focused = false;
    act(() => registry.set(shellsAtom, 7));
    mount();
    stream(10);
    expect(renders).toEqual([{ visible: false, value: 7 }]);
    act(() => recordHomeTransitionStart(false));
    expect(renders.at(-1)).toEqual({ visible: true, value: 17 });
  });
});

function setupTabVisibility() {
  harness.state.focused = false;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  let latest: number | undefined;
  function Probe() {
    const visible = useHomeRouteVisible();
    const value = useAtomValueWhileVisible(shellsAtom, visible);
    useLayoutEffect(() => {
      latest = value;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const sidebar = {
    presented: true,
    selectedThreadKey: "env-1:thread-1",
    selectedPullRequestKey: null,
    selectedIssueKey: null,
  };
  return {
    registry,
    get latest() {
      return latest;
    },
    showHome() {
      act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <NativePrimaryColumnContext value={sidebar}>
              <Probe />
            </NativePrimaryColumnContext>
          </RegistryContext.Provider>,
        ),
      );
    },
    /** A phone has no primary column: Home is the root page of its tab's slot. */
    showHomeInTabSlot(active: boolean) {
      act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <NativeWorkspaceTabActivityContext value={{ active, isActive: () => active }}>
              <Probe />
            </NativeWorkspaceTabActivityContext>
          </RegistryContext.Provider>,
        ),
      );
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
    },
  };
}

it("keeps the sidebar thread list live after switching tabs beside a focused Thread", () => {
  using home = setupTabVisibility();
  // The primary column appearing is the only navigation event Home gets on iPad.
  recordHomeTransitionStart(false);
  home.showHome();
  act(() => home.registry.set(shellsAtom, 1));
  expect(home.latest).toBe(1);

  // Chats → PRs → Chats: Chats' column will-appear, then the PRs column's did-disappear.
  act(() => {
    recordHomeTransitionEnd(true, false);
    recordHomeTransitionStart(false);
    recordHomeTransitionEnd(true, false);
  });
  act(() => home.registry.set(shellsAtom, 2));

  expect(home.latest, "new thread shells reach the sidebar list").toBe(2);
});

// Each phone tab slot shows its own copy of the Home route. PRs keeps Home focused; Settings
// is a route of its own.
it.each([
  { tab: "PRs", homeFocusedUnderTab: true },
  { tab: "Settings", homeFocusedUnderTab: false },
])(
  "keeps the phone thread list live after a round trip through $tab",
  ({ homeFocusedUnderTab }) => {
    using home = setupTabVisibility();
    recordHomeFocus();
    home.showHomeInTabSlot(true);
    act(() => home.registry.set(shellsAtom, 1));
    expect(home.latest).toBe(1);

    // To the other tab: its slot will-appear, then the Chats slot's did-disappear.
    act(() => {
      recordHomeTransitionStart(false);
      recordHomeTransitionEnd(true, homeFocusedUnderTab);
    });
    home.showHomeInTabSlot(false);
    act(() => home.registry.set(shellsAtom, 2));
    expect(home.latest, "the list under another tab holds its rows").toBe(1);

    // Back to Chats: its slot will-appear, then the other slot's did-disappear comes last.
    act(() => {
      recordHomeFocus();
      recordHomeTransitionStart(false);
      recordHomeTransitionEnd(true, true);
    });
    home.showHomeInTabSlot(true);
    act(() => home.registry.set(shellsAtom, 3));
    expect(home.latest, "a server rename reaches the list").toBe(3);

    // A pushed Thread takes the focus and still stops the list.
    act(() => recordHomeTransitionEnd(true, false));
    act(() => home.registry.set(shellsAtom, 4));
    expect(home.latest, "the list under a Thread holds its rows").toBe(3);
  },
);
