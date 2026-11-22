import type { NativeReviewDiffRow } from "../../diffs/nativeReviewDiffSurface";
import { describe, expect, it } from "vite-plus/test";
import { guideFocusedRows } from "./guideDiffFocus";

describe("guide diff focus", () => {
  const rows = [
    { id: "old", kind: "line" as const, fileId: "a", oldLineNumber: 10, change: "delete" as const },
    { id: "new", kind: "line" as const, fileId: "a", newLineNumber: 20, change: "add" as const },
    { id: "context", kind: "line" as const, fileId: "a", oldLineNumber: 11, newLineNumber: 21 },
    { id: "other", kind: "line" as const, fileId: "b", newLineNumber: 20 },
  ];
  it("uses the requested side and includes both range boundaries only in the target file", () => {
    expect(
      guideFocusedRows(rows, "a", { side: "old", start: 10, end: 11 }).map((r) => r.id),
    ).toEqual(["old", "context"]);
    expect(
      guideFocusedRows(rows, "a", { side: "new", start: 20, end: 21 }).map((r) => r.id),
    ).toEqual(["new", "context"]);
  });
  it("does not select unrelated rows while a later file is loading", () => {
    expect(guideFocusedRows(rows, undefined, { side: "new", start: 20, end: 21 })).toEqual([]);
    expect(guideFocusedRows(rows, "a", undefined)).toEqual([]);
  });
});

it("focuses a range that crosses diff sides in either direction", () => {
  const rows: NativeReviewDiffRow[] = [
    { kind: "file", id: "file", fileId: "f" },
    { kind: "line", id: "a", fileId: "f", oldLineNumber: 12 },
    { kind: "line", id: "b", fileId: "f", oldLineNumber: 13 },
    { kind: "line", id: "c", fileId: "f", newLineNumber: 12 },
    { kind: "line", id: "d", fileId: "f", newLineNumber: 13 },
    { kind: "line", id: "other", fileId: "other", newLineNumber: 13 },
  ];
  expect(
    guideFocusedRows(rows, "f", { side: "old", start: 12, endSide: "new", end: 13 }).map(
      (row) => row.id,
    ),
  ).toEqual(["a", "b", "c", "d"]);
  expect(
    guideFocusedRows(rows, "f", { side: "new", start: 13, endSide: "old", end: 12 }).map(
      (row) => row.id,
    ),
  ).toEqual(["a", "b", "c", "d"]);
  expect(
    guideFocusedRows(rows, "f", { side: "old", start: 12, end: 13 }).map((row) => row.id),
  ).toEqual(["a", "b"]);
  expect(guideFocusedRows(rows, "f", { side: "old", start: 99, endSide: "new", end: 13 })).toEqual(
    [],
  );
});
