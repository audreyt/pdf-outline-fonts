const HEX_TOKEN = /<([0-9A-Fa-f]+)>/;

function firstCodePointFromHex(hex: string): number | null {
  if (hex.length < 4) {
    return null;
  }
  return Number.parseInt(hex.slice(0, 4), 16);
}

export function parseToUnicodeCMap(cmapText: string): Map<number, number> {
  const mapping = new Map<number, number>();

  for (const blockMatch of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const block = blockMatch[1] ?? "";
    for (const charMatch of block.matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g)) {
      const cid = Number.parseInt(charMatch[1]!, 16);
      const codePoint = firstCodePointFromHex(charMatch[2]!);
      if (codePoint !== null) {
        mapping.set(cid, codePoint);
      }
    }
  }

  for (const blockMatch of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const block = blockMatch[1] ?? "";
    const tokens = [...block.matchAll(/<[0-9A-Fa-f]+>|\[|\]/g)].map((match) => match[0]);
    let i = 0;

    while (i < tokens.length) {
      if (!tokens[i]?.startsWith("<")) {
        i += 1;
        continue;
      }

      const srcStart = Number.parseInt(tokens[i]!.slice(1, -1), 16);
      const srcEndToken = tokens[i + 1];
      const dstToken = tokens[i + 2];
      if (!srcEndToken?.startsWith("<") || !dstToken) {
        break;
      }

      const srcEnd = Number.parseInt(srcEndToken.slice(1, -1), 16);
      if (dstToken === "[") {
        let cid = srcStart;
        let j = i + 3;
        while (j < tokens.length && tokens[j] !== "]") {
          const dst = tokens[j]!;
          const codePoint = firstCodePointFromHex(dst.slice(1, -1));
          if (codePoint !== null) {
            mapping.set(cid, codePoint);
          }
          cid += 1;
          j += 1;
        }
        i = j + 1;
      } else if (HEX_TOKEN.test(dstToken)) {
        const dstStart = Number.parseInt(dstToken.slice(1, -1), 16);
        for (let offset = 0; offset <= srcEnd - srcStart; offset += 1) {
          mapping.set(srcStart + offset, dstStart + offset);
        }
        i += 3;
      } else {
        i += 1;
      }
    }
  }

  return mapping;
}

export function invertCidToUnicode(cidToUnicode: Map<number, number>): Map<number, number> {
  const unicodeToCid = new Map<number, number>();
  for (const [cid, unicode] of cidToUnicode) {
    if (!unicodeToCid.has(unicode)) {
      unicodeToCid.set(unicode, cid);
    }
  }
  return unicodeToCid;
}
