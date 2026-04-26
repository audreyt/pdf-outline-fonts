import { describe, expect, test } from "bun:test";
import { CffFont } from "../src/cff";

describe("CffFont", () => {
  test("decodes a minimal Type 2 charstring into path operations", () => {
    const font = new CffFont(minimalCffWithSquareGlyph());

    expect(font.fontMatrixScale).toBe(0.001);
    expect(font.hasGlyph(0)).toBe(true);
    expect(font.hasGlyph(1)).toBe(true);
    expect(font.hasGlyph(2)).toBe(false);
    expect(font.glyphIdForCid(1)).toBe(1);
    expect(font.glyphToPathOps(1)).toEqual([
      ["m", 0, 0],
      ["l", 100, 0],
      ["l", 100, 100],
      ["l", 0, 100],
      ["l", 0, 0],
      ["h"],
    ]);
  });

  test("throws when a glyph id is out of range", () => {
    const font = new CffFont(minimalCffWithSquareGlyph());
    expect(() => font.glyphToPathOps(9)).toThrow("glyph id out of range");
  });

  test("maps sparse CID-keyed charsets to compact glyph ids", () => {
    const font = new CffFont(minimalCffWithSquareGlyph({ cid: 668 }));

    expect(font.glyphIdForCid(668)).toBe(1);
    expect(font.glyphIdForCid(1)).toBeNull();
    expect(font.glyphToPathOps(font.glyphIdForCid(668)!)[1]).toEqual(["l", 100, 0]);
  });
});

function minimalCffWithSquareGlyph(options: { cid?: number } = {}): Uint8Array {
  const header = [1, 0, 4, 4];
  const nameIndex = indexFromItems([[...bytes("Test")]]);
  const stringIndex = [0, 0];
  const globalSubrIndex = [0, 0];
  const notdef = [14];
  const square = [
    139,
    139,
    21,
    239,
    139,
    139,
    239,
    39,
    139,
    139,
    39,
    5,
    14,
  ];
  const charStrings = indexFromItems([notdef, square]);

  const charset =
    options.cid === undefined ? [] : [0, (options.cid >> 8) & 0xff, options.cid & 0xff];
  let topDict: number[] = [];
  let topIndex: number[] = [];

  for (let i = 0; i < 3; i += 1) {
    topIndex = indexFromItems([topDict]);
    const dataOffset = header.length + nameIndex.length + topIndex.length + stringIndex.length + globalSubrIndex.length;
    const charStringsOffset = dataOffset + charset.length;
    topDict =
      options.cid === undefined
        ? [encodeCffNumber(charStringsOffset), 17].flat()
        : [encodeCffNumber(dataOffset), 15, encodeCffNumber(charStringsOffset), 17].flat();
  }

  topIndex = indexFromItems([topDict]);
  return Uint8Array.from([
    ...header,
    ...nameIndex,
    ...topIndex,
    ...stringIndex,
    ...globalSubrIndex,
    ...charset,
    ...charStrings,
  ]);
}

function indexFromItems(items: number[][]): number[] {
  if (items.length === 0) {
    return [0, 0];
  }

  const offsets = [1];
  let next = 1;
  for (const item of items) {
    next += item.length;
    offsets.push(next);
  }

  return [items.length >> 8, items.length & 0xff, 1, ...offsets, ...items.flat()];
}

function encodeCffNumber(value: number): number[] {
  if (value >= -107 && value <= 107) {
    return [value + 139];
  }
  throw new Error("test helper only encodes compact integers");
}

function bytes(value: string): number[] {
  return [...new TextEncoder().encode(value)];
}
