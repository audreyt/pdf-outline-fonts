export type RGB = readonly [number, number, number];
export type Point = readonly [number, number];

export type PathOp =
  | readonly ["m", number, number]
  | readonly ["l", number, number]
  | readonly ["c", number, number, number, number, number, number]
  | readonly ["h"];

export interface GlyphPathDraw {
  origin: Point;
  size: number;
  scale: number;
  color: RGB;
  ops: PathOp[];
}

function fmt(value: number, digits: number): string {
  return value.toFixed(digits);
}

export function buildPathContentStream(pathsToDraw: GlyphPathDraw[], pageHeight: number): Uint8Array {
  const parts = ["q"];
  let lastColor: string | null = null;

  for (const item of pathsToDraw) {
    if (item.ops.length === 0) {
      continue;
    }

    const [originX, originYDown] = item.origin;
    const originY = pageHeight - originYDown;
    const scale = item.size * item.scale;
    const colorKey = item.color.join(",");

    if (colorKey !== lastColor) {
      parts.push(`${fmt(item.color[0], 4)} ${fmt(item.color[1], 4)} ${fmt(item.color[2], 4)} rg`);
      lastColor = colorKey;
    }

    parts.push("q");
    parts.push(`${fmt(scale, 6)} 0 0 ${fmt(scale, 6)} ${fmt(originX, 4)} ${fmt(originY, 4)} cm`);

    for (const op of item.ops) {
      if (op[0] === "m") {
        parts.push(`${fmt(op[1], 4)} ${fmt(op[2], 4)} m`);
      } else if (op[0] === "l") {
        parts.push(`${fmt(op[1], 4)} ${fmt(op[2], 4)} l`);
      } else if (op[0] === "c") {
        parts.push(
          `${fmt(op[1], 4)} ${fmt(op[2], 4)} ${fmt(op[3], 4)} ${fmt(op[4], 4)} ${fmt(op[5], 4)} ${fmt(op[6], 4)} c`,
        );
      } else {
        parts.push("h");
      }
    }

    parts.push("f");
    parts.push("Q");
  }

  parts.push("Q");
  return new TextEncoder().encode(`${parts.join("\n")}\n`);
}
