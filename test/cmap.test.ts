import { describe, expect, test } from "bun:test";
import { invertCidToUnicode, parseToUnicodeCMap } from "../src/cmap";

describe("parseToUnicodeCMap", () => {
  test("parses bfchar entries", () => {
    const mapping = parseToUnicodeCMap(`
      2 beginbfchar
        <0001> <0041>
        <0002> <4F60>
      endbfchar
    `);

    expect(mapping.get(1)).toBe(0x41);
    expect(mapping.get(2)).toBe(0x4f60);
  });

  test("parses sequential and array bfrange entries", () => {
    const mapping = parseToUnicodeCMap(`
      1 beginbfrange
        <0010> <0012> <0061>
      endbfrange
      1 beginbfrange
        <0020> <0022> [ <4E00> <4E8C> <4E09> ]
      endbfrange
    `);

    expect(mapping.get(0x10)).toBe(0x61);
    expect(mapping.get(0x11)).toBe(0x62);
    expect(mapping.get(0x12)).toBe(0x63);
    expect(mapping.get(0x20)).toBe(0x4e00);
    expect(mapping.get(0x21)).toBe(0x4e8c);
    expect(mapping.get(0x22)).toBe(0x4e09);
  });

  test("inverts without overwriting the first cid for duplicate unicode values", () => {
    const inverted = invertCidToUnicode(
      new Map([
        [10, 0x41],
        [11, 0x41],
        [12, 0x42],
      ]),
    );

    expect(inverted.get(0x41)).toBe(10);
    expect(inverted.get(0x42)).toBe(12);
  });
});
