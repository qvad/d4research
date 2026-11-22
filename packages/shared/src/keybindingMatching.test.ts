import { describe, expect, it } from "vite-plus/test";

import {
  isMacPlatform,
  matchesKeybindingShortcut,
  matchesKeybindingShortcutModifiers,
  resolveEventKeys,
  shortcutKeyFromEvent,
  type ShortcutEventLike,
} from "./keybindingMatching.ts";

const event = (key: string, overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

const shortcut = (key: string, shiftKey = false) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey,
  altKey: false,
  modKey: false,
});

describe("isMacPlatform", () => {
  it("matches navigator.platform values for Apple devices only", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("iPad")).toBe(true);
    expect(isMacPlatform("darwin")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
  });
});

describe("shortcutKeyFromEvent", () => {
  it("falls back to the physical code when the key is unidentified", () => {
    expect(shortcutKeyFromEvent(event("Unidentified", { code: "Comma" }))).toBe(",");
  });

  it("keeps an unshifted + as a zoom key unless it came from a digit row", () => {
    expect(shortcutKeyFromEvent(event("+", { code: "Equal" }))).toBe("+");
    expect(shortcutKeyFromEvent(event("+", { code: "Digit1" }))).toBe("1");
    expect(shortcutKeyFromEvent(event("+", { code: "Equal", shiftKey: true }))).toBe("=");
  });
});

describe("resolveEventKeys", () => {
  it("adds the physical letter when the layout types punctuation there", () => {
    const keys = resolveEventKeys(event(",", { code: "KeyW" }));
    expect(keys.has(",")).toBe(true);
    expect(keys.has("w")).toBe(true);
  });
});

describe("matchesKeybindingShortcutModifiers", () => {
  const modifiers = (m: Partial<ShortcutEventLike>) => ({ ...event(""), ...m });
  const modS = { ...shortcut("s"), modKey: true };

  it("maps modKey to meta on mac and ctrl elsewhere", () => {
    expect(matchesKeybindingShortcutModifiers(modifiers({ metaKey: true }), modS, "MacIntel")).toBe(
      true,
    );
    expect(matchesKeybindingShortcutModifiers(modifiers({ ctrlKey: true }), modS, "MacIntel")).toBe(
      false,
    );
    expect(matchesKeybindingShortcutModifiers(modifiers({ ctrlKey: true }), modS, "Win32")).toBe(
      true,
    );
    expect(matchesKeybindingShortcutModifiers(modifiers({ metaKey: true }), modS, "Win32")).toBe(
      false,
    );
  });

  it("rejects an extra modifier", () => {
    const ctrlShiftS = { ...shortcut("s"), ctrlKey: true, shiftKey: true };
    expect(
      matchesKeybindingShortcutModifiers(
        modifiers({ ctrlKey: true, shiftKey: true, altKey: true }),
        ctrlShiftS,
        "Win32",
      ),
    ).toBe(false);
  });
});

describe("matchesKeybindingShortcut", () => {
  it("treats AltGraph text entry as typing, not a Ctrl+Alt chord, off macOS", () => {
    const ctrlAltEuro = { ...shortcut("€"), ctrlKey: true, altKey: true };
    const typed = event("€", { ctrlKey: true, altKey: true });
    const altGraph = { ...typed, getModifierState: (k: "AltGraph") => k === "AltGraph" };

    expect(matchesKeybindingShortcut(typed, ctrlAltEuro, "Win32")).toBe(true);
    expect(matchesKeybindingShortcut(altGraph, ctrlAltEuro, "Win32")).toBe(false);
    expect(matchesKeybindingShortcut(altGraph, ctrlAltEuro, "MacIntel")).toBe(true);
  });
});

describe("ISO section-sign matching in desktop preview", () => {
  it("matches plain § with the layout's extra Option modifier", () => {
    for (const keyEvent of [
      event("Unidentified", { key: "§", altKey: true }),
      event("Unidentified", { code: "Backquote", altKey: true }),
      event("Unidentified", { code: "IntlBackslash", altKey: true }),
    ]) {
      expect(matchesKeybindingShortcut(keyEvent, shortcut("§"), "MacIntel")).toBe(true);
      expect(
        matchesKeybindingShortcut({ ...keyEvent, ctrlKey: true }, shortcut("§"), "MacIntel"),
      ).toBe(false);
    }
  });

  it("matches shifted ISO variants against legacy ± and recorded shift+§ bindings", () => {
    for (const keyEvent of [
      event("Unidentified", { key: "±", code: "Backquote" }),
      event("Unidentified", { key: "§", code: "Backquote", shiftKey: true }),
      event("Unidentified", { code: "IntlBackslash", shiftKey: true, altKey: true }),
    ]) {
      expect(matchesKeybindingShortcut(keyEvent, shortcut("±"), "MacIntel")).toBe(true);
      expect(matchesKeybindingShortcut(keyEvent, shortcut("§", true), "MacIntel")).toBe(true);
      expect(matchesKeybindingShortcut(keyEvent, shortcut("§"), "MacIntel")).toBe(false);
    }
  });
});
