import { describe, expect, test } from "bun:test";
import { buildPathContentStream } from "../src/pdf-path";

describe("buildPathContentStream", () => {
  test("emits filled glyph paths in PDF coordinates", () => {
    const stream = new TextDecoder().decode(
      buildPathContentStream(
        [
          {
            origin: [10, 25],
            size: 12,
            scale: 0.001,
            color: [1, 0.5, 0],
            ops: [
              ["m", 0, 0],
              ["l", 100, 0],
              ["c", 100, 10, 90, 20, 80, 30],
              ["h"],
            ],
          },
        ],
        100,
      ),
    );

    expect(stream).toContain("1.0000 0.5000 0.0000 rg");
    expect(stream).toContain("0.012000 0 0 0.012000 10.0000 75.0000 cm");
    expect(stream).toContain("100.0000 10.0000 90.0000 20.0000 80.0000 30.0000 c");
    expect(stream.endsWith("Q\n")).toBe(true);
  });
});
