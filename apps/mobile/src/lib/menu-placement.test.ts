import { describe, expect, it } from "vite-plus/test";

import { deriveMenuHorizontalPlacement } from "./menu-placement";

const horizontalBase = { anchorWidth: 48, overlayWidth: 852, desiredWidth: 224, margin: 12 };

describe("deriveMenuHorizontalPlacement", () => {
  it("opens toward the roomier side of the whole screen without a hinge", () => {
    expect(deriveMenuHorizontalPlacement({ ...horizontalBase, anchorX: 300, hinge: null })).toEqual(
      {
        left: 300,
        width: 224,
      },
    );
  });

  it("keeps a menu on its anchor's side of a creased hinge", () => {
    // The filter button sits near the crease, so the menu right-aligns to it instead of crossing.
    expect(
      deriveMenuHorizontalPlacement({
        ...horizontalBase,
        anchorX: 340,
        hinge: { x: 426, width: 0 },
      }),
    ).toEqual({ left: 164, width: 224 });
    expect(
      deriveMenuHorizontalPlacement({
        ...horizontalBase,
        anchorX: 430,
        hinge: { x: 426, width: 0 },
      }),
    ).toEqual({ left: 438, width: 224 });
  });
});

import { deriveMenuVerticalPlacement } from "./menu-placement";

const verticalBase = { gap: 6, margin: 12, minHeight: 110 };

describe("deriveMenuVerticalPlacement", () => {
  it.each([
    {
      name: "anchor taller than the keyboard-free area stays on screen",
      input: { anchorY: -100, anchorHeight: 1000, overlayHeight: 800, keyboardInset: 300 },
      expected: { maxHeight: 476, top: 12 },
    },
    {
      name: "room below opens down",
      input: { anchorY: 100, anchorHeight: 40, overlayHeight: 800, keyboardInset: 300 },
      expected: { maxHeight: 342, top: 146 },
    },
    {
      name: "room above opens up",
      input: { anchorY: 400, anchorHeight: 40, overlayHeight: 800, keyboardInset: 300 },
      expected: { maxHeight: 382, bottom: 406 },
    },
  ])("$name", ({ input, expected }) => {
    expect(deriveMenuVerticalPlacement({ ...verticalBase, ...input })).toEqual(expected);
  });
});
