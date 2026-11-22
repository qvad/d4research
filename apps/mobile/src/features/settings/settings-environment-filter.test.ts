import type { EnvironmentId } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";

import { toggleSettingsEnvironment } from "./settings-environment-filter.logic";

const first = "first" as EnvironmentId;
const second = "second" as EnvironmentId;
const connected = [{ environmentId: first }, { environmentId: second }];

describe("settings environment filter", () => {
  it("starts with all connected environments and can narrow to either or neither", () => {
    const withoutFirst = toggleSettingsEnvironment(null, connected, first);
    expect([...withoutFirst!]).toEqual([second]);

    const none = toggleSettingsEnvironment(withoutFirst, connected, second);
    expect([...none!]).toEqual([]);

    const onlyFirst = toggleSettingsEnvironment(none, connected, first);
    expect([...onlyFirst!]).toEqual([first]);

    expect(toggleSettingsEnvironment(onlyFirst, connected, second)).toBeNull();
  });

  it("ignores toggles for offline environments and keeps their selection", () => {
    const onlyFirst = new Set([first]);
    expect(toggleSettingsEnvironment(onlyFirst, [{ environmentId: second }], first)).toEqual(
      onlyFirst,
    );
    expect(
      toggleSettingsEnvironment(onlyFirst, [{ environmentId: second }], second, connected),
    ).toBeNull();
  });
});
