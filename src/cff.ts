import type { PathOp } from "./pdf-path";

interface Slice {
  offset: number;
  length: number;
}

interface CffIndex {
  items: Slice[];
  end: number;
}

interface ParsedDict {
  charset?: number;
  charStrings?: number;
  fdArray?: number;
  fdSelect?: number;
  fontMatrix?: number[];
  private?: { size: number; offset: number };
  subrs?: number;
  nominalWidthX?: number;
}

interface PrivateDict {
  subrs: Slice[];
  nominalWidthX: number;
}

interface FontDict {
  fontMatrix?: number[];
  privateDict: PrivateDict;
}

class BytesReader {
  constructor(
    private readonly data: Uint8Array,
    public pos = 0,
  ) {}

  readUInt8(): number {
    if (this.pos >= this.data.length) {
      throw new Error("unexpected end of CFF data");
    }
    return this.data[this.pos++]!;
  }

  readUInt16(): number {
    const a = this.readUInt8();
    const b = this.readUInt8();
    return (a << 8) | b;
  }

  readInt16(): number {
    const value = this.readUInt16();
    return value & 0x8000 ? value - 0x10000 : value;
  }

  readUInt32(): number {
    const a = this.readUInt8();
    const b = this.readUInt8();
    const c = this.readUInt8();
    const d = this.readUInt8();
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  }

  readInt32(): number {
    const value = this.readUInt32();
    return value > 0x7fffffff ? value - 0x100000000 : value;
  }
}

function readOffset(reader: BytesReader, offSize: number): number {
  let value = 0;
  for (let i = 0; i < offSize; i += 1) {
    value = (value << 8) | reader.readUInt8();
  }
  return value;
}

function parseIndex(data: Uint8Array, offset: number): CffIndex {
  const reader = new BytesReader(data, offset);
  const count = reader.readUInt16();
  if (count === 0) {
    return { items: [], end: reader.pos };
  }

  const offSize = reader.readUInt8();
  const offsets: number[] = [];
  for (let i = 0; i <= count; i += 1) {
    offsets.push(readOffset(reader, offSize));
  }

  const dataStart = reader.pos;
  const items: Slice[] = [];
  for (let i = 0; i < count; i += 1) {
    const itemStart = dataStart + offsets[i]! - 1;
    const itemEnd = dataStart + offsets[i + 1]! - 1;
    items.push({ offset: itemStart, length: itemEnd - itemStart });
  }

  return { items, end: dataStart + offsets[count]! - 1 };
}

function parseDictNumber(data: Uint8Array, reader: BytesReader, firstByte: number): number {
  if (firstByte === 28) {
    return reader.readInt16();
  }
  if (firstByte === 29) {
    return reader.readInt32();
  }
  if (firstByte === 30) {
    let text = "";
    while (reader.pos < data.length) {
      const byte = reader.readUInt8();
      for (const nibble of [byte >> 4, byte & 0x0f]) {
        if (nibble === 0x0f) {
          const value = Number.parseFloat(text);
          return Number.isFinite(value) ? value : 0;
        }
        if (nibble <= 9) {
          text += String(nibble);
        } else if (nibble === 0x0a) {
          text += ".";
        } else if (nibble === 0x0b) {
          text += "E";
        } else if (nibble === 0x0c) {
          text += "E-";
        } else if (nibble === 0x0e) {
          text += "-";
        }
      }
    }
    throw new Error("unterminated CFF real number");
  }
  if (firstByte >= 32 && firstByte <= 246) {
    return firstByte - 139;
  }
  if (firstByte >= 247 && firstByte <= 250) {
    return (firstByte - 247) * 256 + reader.readUInt8() + 108;
  }
  if (firstByte >= 251 && firstByte <= 254) {
    return -(firstByte - 251) * 256 - reader.readUInt8() - 108;
  }
  throw new Error(`invalid CFF dict number byte: ${firstByte}`);
}

function parseDict(data: Uint8Array, slice: Slice): ParsedDict {
  const reader = new BytesReader(data, slice.offset);
  const end = slice.offset + slice.length;
  const stack: number[] = [];
  const parsed: ParsedDict = {};

  while (reader.pos < end) {
    const byte = reader.readUInt8();
    if (byte <= 21 && byte !== 12) {
      applyDictOperator(parsed, String(byte), stack);
      stack.length = 0;
    } else if (byte === 12) {
      const escaped = reader.readUInt8();
      applyDictOperator(parsed, `12 ${escaped}`, stack);
      stack.length = 0;
    } else {
      stack.push(parseDictNumber(data, reader, byte));
    }
  }

  return parsed;
}

function applyDictOperator(parsed: ParsedDict, op: string, stack: number[]): void {
  if (op === "17") {
    parsed.charStrings = stack.at(-1);
  } else if (op === "15") {
    parsed.charset = stack.at(-1);
  } else if (op === "18") {
    const size = stack.at(-2);
    const offset = stack.at(-1);
    if (size !== undefined && offset !== undefined) {
      parsed.private = { size, offset };
    }
  } else if (op === "19") {
    parsed.subrs = stack.at(-1);
  } else if (op === "21") {
    parsed.nominalWidthX = stack.at(-1);
  } else if (op === "12 7") {
    parsed.fontMatrix = [...stack];
  } else if (op === "12 36") {
    parsed.fdArray = stack.at(-1);
  } else if (op === "12 37") {
    parsed.fdSelect = stack.at(-1);
  }
}

function bias(subrs: readonly Slice[]): number {
  if (subrs.length < 1240) {
    return 107;
  }
  if (subrs.length < 33900) {
    return 1131;
  }
  return 32768;
}

function sliceBytes(data: Uint8Array, slice: Slice): Uint8Array {
  return data.subarray(slice.offset, slice.offset + slice.length);
}

function parsePrivateDict(data: Uint8Array, privateInfo?: { size: number; offset: number }): PrivateDict {
  if (!privateInfo) {
    return { subrs: [], nominalWidthX: 0 };
  }

  const parsed = parseDict(data, { offset: privateInfo.offset, length: privateInfo.size });
  const subrs =
    parsed.subrs === undefined ? [] : parseIndex(data, privateInfo.offset + parsed.subrs).items;

  return {
    subrs,
    nominalWidthX: parsed.nominalWidthX ?? 0,
  };
}

function parseFdSelect(data: Uint8Array, offset: number | undefined, glyphCount: number): number[] {
  if (offset === undefined) {
    return Array.from({ length: glyphCount }, () => 0);
  }

  const reader = new BytesReader(data, offset);
  const format = reader.readUInt8();
  if (format === 0) {
    return Array.from({ length: glyphCount }, () => reader.readUInt8());
  }

  if (format === 3) {
    const ranges = reader.readUInt16();
    const result = Array.from({ length: glyphCount }, () => 0);
    const starts: Array<{ first: number; fd: number }> = [];
    for (let i = 0; i < ranges; i += 1) {
      starts.push({ first: reader.readUInt16(), fd: reader.readUInt8() });
    }
    const sentinel = reader.readUInt16();
    for (let i = 0; i < starts.length; i += 1) {
      const start = starts[i]!;
      const end = starts[i + 1]?.first ?? sentinel;
      for (let gid = start.first; gid < Math.min(end, glyphCount); gid += 1) {
        result[gid] = start.fd;
      }
    }
    return result;
  }

  if (format === 4) {
    const ranges = reader.readUInt32();
    const result = Array.from({ length: glyphCount }, () => 0);
    const starts: Array<{ first: number; fd: number }> = [];
    for (let i = 0; i < ranges; i += 1) {
      starts.push({ first: reader.readUInt32(), fd: reader.readUInt16() });
    }
    const sentinel = reader.readUInt32();
    for (let i = 0; i < starts.length; i += 1) {
      const start = starts[i]!;
      const end = starts[i + 1]?.first ?? sentinel;
      for (let gid = start.first; gid < Math.min(end, glyphCount); gid += 1) {
        result[gid] = start.fd;
      }
    }
    return result;
  }

  throw new Error(`unsupported FDSelect format: ${format}`);
}

function parseCharset(data: Uint8Array, offset: number | undefined, glyphCount: number): Map<number, number> {
  const mapping = new Map<number, number>();
  mapping.set(0, 0);

  if (glyphCount <= 1) {
    return mapping;
  }

  if (offset === undefined || offset <= 2) {
    for (let gid = 1; gid < glyphCount; gid += 1) {
      mapping.set(gid, gid);
    }
    return mapping;
  }

  const reader = new BytesReader(data, offset);
  const format = reader.readUInt8();
  let gid = 1;

  if (format === 0) {
    while (gid < glyphCount) {
      mapping.set(reader.readUInt16(), gid);
      gid += 1;
    }
    return mapping;
  }

  if (format === 1 || format === 2) {
    while (gid < glyphCount) {
      let cid = reader.readUInt16();
      const left = format === 1 ? reader.readUInt8() : reader.readUInt16();
      for (let i = 0; i <= left && gid < glyphCount; i += 1) {
        mapping.set(cid, gid);
        cid += 1;
        gid += 1;
      }
    }
    return mapping;
  }

  throw new Error(`unsupported CFF charset format: ${format}`);
}

export class CffFont {
  private readonly charStrings: Slice[];
  private readonly cidToGlyphId: Map<number, number>;
  private readonly globalSubrs: Slice[];
  private readonly fontDicts: FontDict[];
  private readonly fdSelect: number[];
  readonly fontMatrixScale: number;

  constructor(private readonly data: Uint8Array) {
    const headerSize = data[2];
    if (data[0] !== 1 || headerSize === undefined) {
      throw new Error("only CFF version 1 fonts are supported");
    }

    const nameIndex = parseIndex(data, headerSize);
    const topIndex = parseIndex(data, nameIndex.end);
    if (topIndex.items.length !== 1) {
      throw new Error("only single-font CFF sets are supported");
    }

    const stringIndex = parseIndex(data, topIndex.end);
    const globalSubrIndex = parseIndex(data, stringIndex.end);
    const topDict = parseDict(data, topIndex.items[0]!);

    if (topDict.charStrings === undefined) {
      throw new Error("CFF font is missing CharStrings");
    }

    this.charStrings = parseIndex(data, topDict.charStrings).items;
    this.cidToGlyphId = parseCharset(data, topDict.charset, this.charStrings.length);
    this.globalSubrs = globalSubrIndex.items;
    this.fdSelect = parseFdSelect(data, topDict.fdSelect, this.charStrings.length);

    if (topDict.fdArray !== undefined) {
      const fdIndex = parseIndex(data, topDict.fdArray);
      this.fontDicts = fdIndex.items.map((item) => {
        const dict = parseDict(data, item);
        return {
          fontMatrix: dict.fontMatrix,
          privateDict: parsePrivateDict(data, dict.private),
        };
      });
    } else {
      this.fontDicts = [
        {
          fontMatrix: topDict.fontMatrix,
          privateDict: parsePrivateDict(data, topDict.private),
        },
      ];
    }

    this.fontMatrixScale = this.fontDicts[0]?.fontMatrix?.[0] ?? topDict.fontMatrix?.[0] ?? 0.001;
  }

  hasGlyph(gid: number): boolean {
    return Number.isInteger(gid) && gid >= 0 && gid < this.charStrings.length;
  }

  glyphIdForCid(cid: number): number | null {
    const glyphId = this.cidToGlyphId.get(cid);
    return glyphId !== undefined && this.hasGlyph(glyphId) ? glyphId : null;
  }

  glyphToPathOps(gid: number): PathOp[] {
    if (!this.hasGlyph(gid)) {
      throw new Error(`glyph id out of range: ${gid}`);
    }

    const path: PathOp[] = [];
    const stack: number[] = [];
    const trans: number[] = [];
    const fd = this.fontDicts[this.fdSelect[gid] ?? 0] ?? this.fontDicts[0]!;
    const privateDict = fd.privateDict;
    const localSubrs = privateDict.subrs;
    const localBias = bias(localSubrs);
    const globalBias = bias(this.globalSubrs);

    let width: number | null = null;
    let nStems = 0;
    let x = 0;
    let y = 0;
    let open = false;

    const pop = () => stack.pop() ?? 0;
    const shift = () => stack.shift() ?? 0;

    const checkWidth = () => {
      if (width === null) {
        width = shift() + privateDict.nominalWidthX;
      }
    };

    const parseStems = () => {
      if (stack.length % 2 !== 0) {
        checkWidth();
      }
      nStems += stack.length >> 1;
      stack.length = 0;
    };

    const moveTo = (mx: number, my: number) => {
      if (open) {
        path.push(["h"]);
      }
      path.push(["m", mx, my]);
      open = true;
    };

    const parseBytes = (bytes: Uint8Array) => {
      const reader = new BytesReader(bytes);

      while (reader.pos < bytes.length) {
        let op = reader.readUInt8();
        if (op >= 32 || op === 28 || op === 255) {
          stack.push(parseCharStringNumber(bytes, reader, op));
          continue;
        }

        let phase = false;
        let c1x = 0;
        let c1y = 0;
        let c2x = 0;
        let c2y = 0;
        let pts: number[] = [];

        switch (op) {
          case 1:
          case 3:
          case 18:
          case 23:
            parseStems();
            break;

          case 4:
            if (stack.length > 1) {
              checkWidth();
            }
            y += shift();
            moveTo(x, y);
            break;

          case 5:
            while (stack.length >= 2) {
              x += shift();
              y += shift();
              path.push(["l", x, y]);
            }
            break;

          case 6:
          case 7:
            phase = op === 6;
            while (stack.length >= 1) {
              if (phase) {
                x += shift();
              } else {
                y += shift();
              }
              path.push(["l", x, y]);
              phase = !phase;
            }
            break;

          case 8:
            while (stack.length > 0) {
              c1x = x + shift();
              c1y = y + shift();
              c2x = c1x + shift();
              c2y = c1y + shift();
              x = c2x + shift();
              y = c2y + shift();
              path.push(["c", c1x, c1y, c2x, c2y, x, y]);
            }
            break;

          case 10: {
            const index = pop() + localBias;
            const subr = localSubrs[index];
            if (subr) {
              parseBytes(sliceBytes(this.data, subr));
            }
            break;
          }

          case 11:
            return;

          case 14:
            if (stack.length > 0) {
              checkWidth();
            }
            if (open) {
              path.push(["h"]);
              open = false;
            }
            return;

          case 19:
          case 20:
            parseStems();
            reader.pos += (nStems + 7) >> 3;
            break;

          case 21:
            if (stack.length > 2) {
              checkWidth();
            }
            x += shift();
            y += shift();
            moveTo(x, y);
            break;

          case 22:
            if (stack.length > 1) {
              checkWidth();
            }
            x += shift();
            moveTo(x, y);
            break;

          case 24:
            while (stack.length >= 8) {
              c1x = x + shift();
              c1y = y + shift();
              c2x = c1x + shift();
              c2y = c1y + shift();
              x = c2x + shift();
              y = c2y + shift();
              path.push(["c", c1x, c1y, c2x, c2y, x, y]);
            }
            x += shift();
            y += shift();
            path.push(["l", x, y]);
            break;

          case 25:
            while (stack.length >= 8) {
              x += shift();
              y += shift();
              path.push(["l", x, y]);
            }
            c1x = x + shift();
            c1y = y + shift();
            c2x = c1x + shift();
            c2y = c1y + shift();
            x = c2x + shift();
            y = c2y + shift();
            path.push(["c", c1x, c1y, c2x, c2y, x, y]);
            break;

          case 26:
            if (stack.length % 2) {
              x += shift();
            }
            while (stack.length >= 4) {
              c1x = x;
              c1y = y + shift();
              c2x = c1x + shift();
              c2y = c1y + shift();
              x = c2x;
              y = c2y + shift();
              path.push(["c", c1x, c1y, c2x, c2y, x, y]);
            }
            break;

          case 27:
            if (stack.length % 2) {
              y += shift();
            }
            while (stack.length >= 4) {
              c1x = x + shift();
              c1y = y;
              c2x = c1x + shift();
              c2y = c1y + shift();
              x = c2x + shift();
              y = c2y;
              path.push(["c", c1x, c1y, c2x, c2y, x, y]);
            }
            break;

          case 29: {
            const index = pop() + globalBias;
            const subr = this.globalSubrs[index];
            if (subr) {
              parseBytes(sliceBytes(this.data, subr));
            }
            break;
          }

          case 30:
          case 31:
            phase = op === 31;
            while (stack.length >= 4) {
              if (phase) {
                c1x = x + shift();
                c1y = y;
                c2x = c1x + shift();
                c2y = c1y + shift();
                y = c2y + shift();
                x = c2x + (stack.length === 1 ? shift() : 0);
              } else {
                c1x = x;
                c1y = y + shift();
                c2x = c1x + shift();
                c2y = c1y + shift();
                x = c2x + shift();
                y = c2y + (stack.length === 1 ? shift() : 0);
              }
              path.push(["c", c1x, c1y, c2x, c2y, x, y]);
              phase = !phase;
            }
            break;

          case 12:
            op = reader.readUInt8();
            if (op === 3) {
              const a = pop();
              const b = pop();
              stack.push(a && b ? 1 : 0);
            } else if (op === 4) {
              const a = pop();
              const b = pop();
              stack.push(a || b ? 1 : 0);
            } else if (op === 5) {
              stack.push(pop() ? 0 : 1);
            } else if (op === 9) {
              stack.push(Math.abs(pop()));
            } else if (op === 10) {
              const a = pop();
              const b = pop();
              stack.push(a + b);
            } else if (op === 11) {
              const a = pop();
              const b = pop();
              stack.push(b - a);
            } else if (op === 12) {
              const a = pop();
              const b = pop();
              stack.push(b / a);
            } else if (op === 14) {
              stack.push(-pop());
            } else if (op === 15) {
              const a = pop();
              const b = pop();
              stack.push(a === b ? 1 : 0);
            } else if (op === 18) {
              pop();
            } else if (op === 20) {
              const value = pop();
              const index = pop();
              trans[index] = value;
            } else if (op === 21) {
              stack.push(trans[pop()] ?? 0);
            } else if (op === 22) {
              const s1 = pop();
              const s2 = pop();
              const v1 = pop();
              const v2 = pop();
              stack.push(v1 <= v2 ? s1 : s2);
            } else if (op === 23) {
              stack.push(0.5);
            } else if (op === 24) {
              const a = pop();
              const b = pop();
              stack.push(a * b);
            } else if (op === 26) {
              stack.push(Math.sqrt(pop()));
            } else if (op === 27) {
              const a = pop();
              stack.push(a, a);
            } else if (op === 28) {
              const a = pop();
              const b = pop();
              stack.push(a, b);
            } else if (op === 29) {
              const index = Math.max(0, Math.min(pop(), stack.length - 1));
              stack.push(stack[index] ?? 0);
            } else if (op === 30) {
              rollStack(stack, pop(), pop());
            } else if (op === 34) {
              c1x = x + shift();
              c1y = y;
              c2x = c1x + shift();
              c2y = c1y + shift();
              const c3x = c2x + shift();
              const c3y = c2y;
              const c4x = c3x + shift();
              const c4y = c3y;
              const c5x = c4x + shift();
              const c5y = c4y;
              x = c5x + shift();
              y = c5y;
              path.push(["c", c1x, c1y, c2x, c2y, c3x, c3y]);
              path.push(["c", c4x, c4y, c5x, c5y, x, y]);
            } else if (op === 35) {
              pts = [];
              for (let i = 0; i <= 5; i += 1) {
                x += shift();
                y += shift();
                pts.push(x, y);
              }
              path.push(["c", pts[0]!, pts[1]!, pts[2]!, pts[3]!, pts[4]!, pts[5]!]);
              path.push(["c", pts[6]!, pts[7]!, pts[8]!, pts[9]!, pts[10]!, pts[11]!]);
              shift();
            } else if (op === 36) {
              c1x = x + shift();
              c1y = y + shift();
              c2x = c1x + shift();
              c2y = c1y + shift();
              const c3x = c2x + shift();
              const c3y = c2y;
              const c4x = c3x + shift();
              const c4y = c3y;
              const c5x = c4x + shift();
              const c5y = c4y + shift();
              x = c5x + shift();
              y = c5y;
              path.push(["c", c1x, c1y, c2x, c2y, c3x, c3y]);
              path.push(["c", c4x, c4y, c5x, c5y, x, y]);
            } else if (op === 37) {
              const startX = x;
              const startY = y;
              pts = [];
              for (let i = 0; i <= 4; i += 1) {
                x += shift();
                y += shift();
                pts.push(x, y);
              }
              if (Math.abs(x - startX) > Math.abs(y - startY)) {
                x += shift();
                y = startY;
              } else {
                x = startX;
                y += shift();
              }
              pts.push(x, y);
              path.push(["c", pts[0]!, pts[1]!, pts[2]!, pts[3]!, pts[4]!, pts[5]!]);
              path.push(["c", pts[6]!, pts[7]!, pts[8]!, pts[9]!, pts[10]!, pts[11]!]);
            } else {
              throw new Error(`unknown Type 2 escaped operator: 12 ${op}`);
            }
            break;

          default:
            throw new Error(`unknown Type 2 operator: ${op}`);
        }
      }
    };

    parseBytes(sliceBytes(this.data, this.charStrings[gid]!));

    if (open) {
      path.push(["h"]);
    }

    return path;
  }
}

function parseCharStringNumber(bytes: Uint8Array, reader: BytesReader, firstByte: number): number {
  if (firstByte === 28) {
    return reader.readInt16();
  }
  if (firstByte === 255) {
    return reader.readInt32() / 65536;
  }
  if (firstByte >= 32 && firstByte <= 246) {
    return firstByte - 139;
  }
  if (firstByte >= 247 && firstByte <= 250) {
    return (firstByte - 247) * 256 + reader.readUInt8() + 108;
  }
  if (firstByte >= 251 && firstByte <= 254) {
    return -(firstByte - 251) * 256 - reader.readUInt8() - 108;
  }
  throw new Error(`invalid Type 2 number byte: ${firstByte} at ${reader.pos - 1} of ${bytes.length}`);
}

function rollStack(stack: number[], n: number, j: number): void {
  if (n <= 0 || n > stack.length) {
    return;
  }

  const start = stack.length - n;
  const segment = stack.slice(start);
  const turns = ((j % n) + n) % n;
  const rolled = segment.slice(n - turns).concat(segment.slice(0, n - turns));
  stack.splice(start, n, ...rolled);
}
