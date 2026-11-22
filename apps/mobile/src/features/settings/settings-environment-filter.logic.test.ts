import { EnvironmentId } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  settingsTargetsForProject,
  toggleSettingsEnvironment,
} from "./settings-environment-filter.logic";

const laptop = { environmentId: EnvironmentId.make("laptop") };
const server = { environmentId: EnvironmentId.make("server") };
const group = { members: [{ project: server }] };

describe("settingsTargetsForProject", () => {
  it("keeps an explicitly empty environment selection empty", () => {
    expect(settingsTargetsForProject([], null)).toEqual([]);
    expect(settingsTargetsForProject([], group)).toEqual([]);
  });
  it("does not fall back outside the selected project or a missing group", () => {
    expect(settingsTargetsForProject([laptop], group)).toEqual([]);
    expect(settingsTargetsForProject([laptop, server], undefined)).toEqual([]);
  });
  it("keeps selected environments in order and narrows to project members", () => {
    expect(settingsTargetsForProject([laptop, server], null)).toEqual([laptop, server]);
    expect(settingsTargetsForProject([laptop, server], group)).toEqual([server]);
  });
});

describe("settings selection across disconnected environments", () => {
  const a = EnvironmentId.make("a");
  const b = EnvironmentId.make("b");
  const c = EnvironmentId.make("c");
  const d = EnvironmentId.make("d");
  const all = [a, b, c, d].map((environmentId) => ({ environmentId }));
  const connected = all.filter((entry) => entry.environmentId !== b);

  it.each([
    {
      name: "keeps offline environments selected from All",
      selected: null,
      toggles: [c],
      expected: [a, b, d],
    },
    {
      name: "keeps offline environments deselected after toggling off and on",
      selected: new Set([a, c, d]),
      toggles: [c, c],
      expected: [a, c, d],
    },
    {
      name: "ignores toggles of offline environments",
      selected: new Set([a]),
      toggles: [b],
      expected: [a],
    },
    {
      name: "returns to All when every known environment is selected",
      selected: new Set([a, b, d]),
      toggles: [c],
      expected: null,
    },
  ])("$name", ({ selected, toggles, expected }) => {
    let next: ReadonlySet<EnvironmentId> | null = selected;
    for (const id of toggles) {
      next = toggleSettingsEnvironment(next, connected, id, all);
    }
    expect(next).toEqual(expected === null ? null : new Set(expected));
  });
});
