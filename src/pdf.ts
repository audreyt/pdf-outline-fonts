import mupdf, {
  type Color,
  type Font,
  type Matrix,
  type PDFDocument,
  type PDFObject,
  type PDFPage,
  type Point,
  type Quad,
  type Rect,
  type Text,
} from "mupdf";
import { CffFont } from "./cff";
import { invertCidToUnicode, parseToUnicodeCMap } from "./cmap";
import { baseFontName, fontMatches, namesReferToSameFont } from "./names";
import { buildPathContentStream, type GlyphPathDraw, type RGB } from "./pdf-path";

export interface OutlineOptions {
  prefixes: string[];
  exacts: string[];
  selectionFont?: string | null;
  verbose?: boolean;
}

export interface OutlineResult {
  fontsOutlined: string[];
  pagesChanged: number;
  glyphCount: number;
}

interface TargetFontInfo {
  xref: number;
  name: string;
  cff: CffFont;
  unicodeToCid: Map<number, number>;
  fontMatrixScale: number;
}

interface FontListItem {
  name: string;
  type: string;
}

interface InvisibleSpan {
  origin: Point;
  size: number;
  text: string;
}

interface SelectionFontState {
  font: Font;
  ref: PDFObject;
}

export class NoFontsMatchedError extends Error {
  constructor(
    readonly fonts: FontListItem[],
    readonly prefixes: string[],
    readonly exacts: string[],
  ) {
    super(`no fonts matched prefixes=${JSON.stringify(prefixes)} exacts=${JSON.stringify(exacts)}`);
    this.name = "NoFontsMatchedError";
  }
}

export function normalizeSelectionFontName(name: string): string {
  const aliases: Record<string, string> = {
    "china-t": "zh-Hant",
    "china-s": "zh-Hans",
    japan: "ja",
    korea: "ko",
  };
  return aliases[name] ?? name;
}

export function outlinePdf(inputPath: string, outputPath: string, options: OutlineOptions): OutlineResult {
  const verbose = options.verbose ?? true;
  const doc = new mupdf.PDFDocument(inputPath);
  const targetInfo = loadTargetFonts(doc, options.prefixes, options.exacts, verbose);

  if (targetInfo.length === 0) {
    throw new NoFontsMatchedError(listDocumentFonts(doc), options.prefixes, options.exacts);
  }

  if (verbose) {
    console.log(`outlining: ${JSON.stringify(targetInfo.map((info) => info.name))}`);
  }

  let selectionState: SelectionFontState | null = null;
  let pagesChanged = 0;
  let glyphCount = 0;

  for (let pageNumber = 0; pageNumber < doc.countPages(); pageNumber += 1) {
    const page = doc.loadPage(pageNumber);
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];
    const cidByOrigin = collectGlyphCids(page);
    const pathsToDraw: GlyphPathDraw[] = [];
    const redactRects: Rect[] = [];
    const invisibleSpans: InvisibleSpan[] = [];
    let activeInvisibleSpan: InvisibleSpan | null = null;

    const flushInvisibleSpan = () => {
      if (activeInvisibleSpan && activeInvisibleSpan.text.length > 0) {
        invisibleSpans.push(activeInvisibleSpan);
      }
      activeInvisibleSpan = null;
    };

    const appendInvisibleChar = (origin: Point, size: number, text: string) => {
      if (
        !activeInvisibleSpan ||
        Math.abs(activeInvisibleSpan.size - size) > 0.001 ||
        Math.abs(activeInvisibleSpan.origin[1] - origin[1]) > 0.001
      ) {
        flushInvisibleSpan();
        activeInvisibleSpan = { origin, size, text: "" };
      }
      activeInvisibleSpan.text += text;
    };

    page.toStructuredText().walk({
      beginLine() {
        flushInvisibleSpan();
      },
      onChar(char, origin, font, size, quad, color) {
        const target = findTargetFont(font.getName(), targetInfo);
        if (!target) {
          flushInvisibleSpan();
          return;
        }

        const codePoint = char.codePointAt(0);
        if (codePoint === undefined) {
          flushInvisibleSpan();
          return;
        }

        redactRects.push(quadToRect(quad));
        appendInvisibleChar(origin, size, char);

        const cidFromDevice = cidByOrigin.get(glyphKey(font.getName(), origin));
        const glyphId = resolveGlyphId(target, codePoint, cidFromDevice);
        if (glyphId === null) {
          return;
        }

        let ops;
        try {
          ops = target.cff.glyphToPathOps(glyphId);
        } catch {
          flushInvisibleSpan();
          return;
        }

        pathsToDraw.push({
          origin,
          size,
          color: colorToRgb(color),
          ops,
          scale: target.fontMatrixScale,
        });
        glyphCount += 1;
      },
      endLine() {
        flushInvisibleSpan();
      },
      endTextBlock() {
        flushInvisibleSpan();
      },
    });
    flushInvisibleSpan();

    if (redactRects.length === 0) {
      continue;
    }

    for (const rect of redactRects) {
      const annot = page.createAnnotation("Redact");
      annot.setRect(rect);
      annot.update();
    }

    page.applyRedactions(
      false,
      mupdf.PDFPage.REDACT_IMAGE_NONE,
      mupdf.PDFPage.REDACT_LINE_ART_NONE,
      mupdf.PDFPage.REDACT_TEXT_REMOVE,
    );

    if (pathsToDraw.length > 0) {
      appendContentStream(doc, page, buildPathContentStream(pathsToDraw, pageHeight));
    }

    if (options.selectionFont !== null && invisibleSpans.length > 0) {
      if (!selectionState) {
        const selectionFont = new mupdf.Font(normalizeSelectionFontName(options.selectionFont ?? "zh-Hant"));
        selectionState = {
          font: selectionFont,
          ref: doc.addFont(selectionFont),
        };
      }
      appendInvisibleSelectionLayer(doc, page, pageHeight, invisibleSpans, selectionState);
    }

    pagesChanged += 1;
    if (verbose) {
      console.log(
        `  page ${pageNumber + 1}: ${pathsToDraw.length} glyph(s) in ${invisibleSpans.length} span(s)`,
      );
    }
  }

  removeTargetFontResources(doc, targetInfo);

  if (verbose) {
    console.log(`changed ${pagesChanged} page(s), outlined ${glyphCount} glyph(s) total`);
  }

  try {
    doc.subsetFonts();
  } catch (error) {
    if (verbose) {
      console.log(`subsetFonts skipped: ${(error as Error).message}`);
    }
  }

  doc.save(outputPath, {
    garbage: 4,
    deflate: true,
    deflateFonts: true,
    clean: true,
  });

  if (verbose) {
    console.log(`saved -> ${outputPath}`);
  }

  return {
    fontsOutlined: targetInfo.map((info) => info.name),
    pagesChanged,
    glyphCount,
  };
}

function loadTargetFonts(
  doc: PDFDocument,
  prefixes: readonly string[],
  exacts: readonly string[],
  verbose: boolean,
): TargetFontInfo[] {
  const out: TargetFontInfo[] = [];
  const seen = new Set<number>();

  for (let pageNumber = 0; pageNumber < doc.countPages(); pageNumber += 1) {
    for (const fontRef of pageFontRefs(doc, pageNumber)) {
      const xref = fontRef.isIndirect() ? fontRef.asIndirect() : -1;
      if (seen.has(xref)) {
        continue;
      }
      seen.add(xref);

      const fontObj = dereference(fontRef);
      const base = getBaseFontName(fontObj);
      if (!base || !fontMatches(base, prefixes, exacts)) {
        continue;
      }

      const fontProgram = extractCffFontProgram(fontObj);
      if (!fontProgram.bytes) {
        if (verbose) {
          console.log(`  skip ${JSON.stringify(base)}: unsupported font program type ${JSON.stringify(fontProgram.type)}`);
        }
        continue;
      }

      const cff = new CffFont(fontProgram.bytes);
      const cidToUnicode = readToUnicode(fontObj);
      out.push({
        xref,
        name: base,
        cff,
        unicodeToCid: invertCidToUnicode(cidToUnicode),
        fontMatrixScale: cff.fontMatrixScale,
      });
    }
  }

  return out;
}

function pageFontRefs(doc: PDFDocument, pageNumber: number): PDFObject[] {
  const page = doc.loadPage(pageNumber);
  const pageObj = page.getObject();
  const resources = dereference(pageObj.getInheritable("Resources"));
  if (resources.isNull()) {
    return [];
  }

  const fontDict = dereference(resources.get("Font"));
  if (fontDict.isNull() || !fontDict.isDictionary()) {
    return [];
  }

  const refs: PDFObject[] = [];
  fontDict.forEach((fontRef) => refs.push(fontRef));
  return refs;
}

function removeTargetFontResources(doc: PDFDocument, targetInfo: readonly TargetFontInfo[]): void {
  const targetNames = new Set(targetInfo.map((info) => info.name));

  for (let pageNumber = 0; pageNumber < doc.countPages(); pageNumber += 1) {
    const page = doc.loadPage(pageNumber);
    const resources = dereference(page.getObject().getInheritable("Resources"));
    if (resources.isNull()) {
      continue;
    }

    const fontDict = dereference(resources.get("Font"));
    if (fontDict.isNull() || !fontDict.isDictionary()) {
      continue;
    }

    const keysToDelete: Array<string | number | PDFObject> = [];
    fontDict.forEach((fontRef, key) => {
      const fontObj = dereference(fontRef);
      const name = getBaseFontName(fontObj);
      if (name && targetNames.has(name)) {
        keysToDelete.push(key);
      }
    });

    for (const key of keysToDelete) {
      fontDict.delete(key);
    }
  }
}

function listDocumentFonts(doc: PDFDocument): FontListItem[] {
  const seen = new Set<number>();
  const fonts: FontListItem[] = [];

  for (let pageNumber = 0; pageNumber < doc.countPages(); pageNumber += 1) {
    for (const fontRef of pageFontRefs(doc, pageNumber)) {
      const xref = fontRef.isIndirect() ? fontRef.asIndirect() : -1;
      if (seen.has(xref)) {
        continue;
      }
      seen.add(xref);

      const fontObj = dereference(fontRef);
      const name = getBaseFontName(fontObj);
      if (name) {
        fonts.push({ name, type: describeFontProgram(fontObj) });
      }
    }
  }

  return fonts;
}

function getBaseFontName(fontObj: PDFObject): string | null {
  const baseFont = fontObj.get("BaseFont");
  if (!baseFont.isNull() && baseFont.isName()) {
    return baseFontName(baseFont.asName());
  }

  const descendant = dereference(fontObj.get("DescendantFonts", 0));
  if (!descendant.isNull()) {
    const descendantBaseFont = descendant.get("BaseFont");
    if (!descendantBaseFont.isNull() && descendantBaseFont.isName()) {
      return baseFontName(descendantBaseFont.asName());
    }
  }

  return null;
}

function describeFontProgram(fontObj: PDFObject): string {
  const descriptor = getFontDescriptor(fontObj);
  if (!descriptor) {
    return "unknown";
  }
  const file3 = descriptor.get("FontFile3");
  if (!file3.isNull()) {
    const subtype = file3.get("Subtype");
    return subtype.isName() ? subtype.asName() : "FontFile3";
  }
  if (!descriptor.get("FontFile2").isNull()) {
    return "TrueType";
  }
  if (!descriptor.get("FontFile").isNull()) {
    return "Type1";
  }
  return "unknown";
}

function extractCffFontProgram(fontObj: PDFObject): { bytes: Uint8Array | null; type: string } {
  const subtype = fontObj.get("Subtype");
  if (subtype.isName() && subtype.asName() !== "Type0") {
    return { bytes: null, type: subtype.asName() };
  }

  const descriptor = getFontDescriptor(fontObj);
  if (!descriptor) {
    return { bytes: null, type: "missing-descriptor" };
  }

  const file3 = descriptor.get("FontFile3");
  if (!file3.isNull() && file3.isStream()) {
    const fileSubtype = file3.get("Subtype");
    const type = fileSubtype.isName() ? fileSubtype.asName() : "FontFile3";
    if (type === "CIDFontType0C" || type === "Type1C") {
      return { bytes: new Uint8Array(file3.readStream().asUint8Array()), type };
    }
    return { bytes: null, type };
  }

  if (!descriptor.get("FontFile2").isNull()) {
    return { bytes: null, type: "TrueType" };
  }
  if (!descriptor.get("FontFile").isNull()) {
    return { bytes: null, type: "Type1" };
  }
  return { bytes: null, type: "unknown" };
}

function getFontDescriptor(fontObj: PDFObject): PDFObject | null {
  const direct = dereference(fontObj.get("FontDescriptor"));
  if (!direct.isNull()) {
    return direct;
  }

  const descendant = dereference(fontObj.get("DescendantFonts", 0));
  if (!descendant.isNull()) {
    const descriptor = dereference(descendant.get("FontDescriptor"));
    if (!descriptor.isNull()) {
      return descriptor;
    }
  }

  return null;
}

function readToUnicode(fontObj: PDFObject): Map<number, number> {
  const toUnicode = fontObj.get("ToUnicode");
  if (toUnicode.isNull() || !toUnicode.isStream()) {
    return new Map();
  }

  return parseToUnicodeCMap(latin1FromBytes(toUnicode.readStream().asUint8Array()));
}

function findTargetFont(spanFont: string, targetInfo: readonly TargetFontInfo[]): TargetFontInfo | null {
  for (const info of targetInfo) {
    if (namesReferToSameFont(spanFont, info.name)) {
      return info;
    }
  }
  return null;
}

function glyphIdForCodePoint(info: TargetFontInfo, codePoint: number): number | null {
  const cid = info.unicodeToCid.get(codePoint);
  if (cid !== undefined) {
    const glyphId = info.cff.glyphIdForCid(cid);
    if (glyphId !== null) {
      return glyphId;
    }
  }

  const fallbackGlyphId = info.cff.glyphIdForCid(codePoint);
  if (fallbackGlyphId !== null) {
    return fallbackGlyphId;
  }

  return null;
}

function resolveGlyphId(
  info: TargetFontInfo,
  codePoint: number,
  cidFromDevice: number | undefined,
): number | null {
  const fromCodePoint = glyphIdForCodePoint(info, codePoint);
  if (fromCodePoint !== null) {
    return fromCodePoint;
  }
  if (cidFromDevice !== undefined) {
    return info.cff.glyphIdForCid(cidFromDevice);
  }
  return null;
}

function glyphKey(fontName: string, origin: Point): string {
  return `${fontName}|${Math.round(origin[0] * 100)},${Math.round(origin[1] * 100)}`;
}

function collectGlyphCids(page: PDFPage): Map<string, number> {
  const cids = new Map<string, number>();

  const captureGlyphs = (text: Text, ctm: Matrix): void => {
    text.walk({
      showGlyph(font, trm, glyph) {
        const m = mupdf.Matrix.concat(trm, ctm);
        cids.set(glyphKey(font.getName(), [m[4], m[5]]), glyph);
      },
    });
  };

  const device = new mupdf.Device({
    fillText(text, ctm) {
      captureGlyphs(text, ctm);
    },
    strokeText(text, _stroke, ctm) {
      captureGlyphs(text, ctm);
    },
    clipText(text, ctm) {
      captureGlyphs(text, ctm);
    },
    clipStrokeText(text, _stroke, ctm) {
      captureGlyphs(text, ctm);
    },
    ignoreText(text, ctm) {
      captureGlyphs(text, ctm);
    },
  });

  try {
    page.run(device, mupdf.Matrix.identity);
  } finally {
    device.close();
  }
  return cids;
}

function appendContentStream(doc: PDFDocument, page: PDFPage, streamBytes: Uint8Array): void {
  const streamRef = doc.addStream(streamBytes, {});
  const pageObj = page.getObject();
  const contentsRef = pageObj.get("Contents");
  const contents = dereference(contentsRef);

  if (contentsRef.isNull()) {
    pageObj.put("Contents", streamRef);
  } else if (contents.isArray()) {
    contents.push(streamRef);
  } else {
    const array = doc.newArray();
    array.push(contentsRef);
    array.push(streamRef);
    pageObj.put("Contents", array);
  }
}

function appendInvisibleSelectionLayer(
  doc: PDFDocument,
  page: PDFPage,
  pageHeight: number,
  spans: readonly InvisibleSpan[],
  selection: SelectionFontState,
): void {
  const resourceName = ensureFontResource(doc, page, selection.ref);
  const parts = ["q"];

  for (const span of spans) {
    const hex = textToGlyphHex(selection.font, span.text);
    if (!hex) {
      continue;
    }

    const x = span.origin[0].toFixed(4);
    const y = (pageHeight - span.origin[1]).toFixed(4);
    parts.push("BT");
    parts.push(`/${resourceName} ${span.size.toFixed(6)} Tf`);
    parts.push("3 Tr");
    parts.push(`1 0 0 1 ${x} ${y} Tm`);
    parts.push(`<${hex}> Tj`);
    parts.push("ET");
  }

  parts.push("Q");
  appendContentStream(doc, page, new TextEncoder().encode(`${parts.join("\n")}\n`));
}

function ensureFontResource(doc: PDFDocument, page: PDFPage, fontRef: PDFObject): string {
  const pageObj = page.getObject();
  let resources = dereference(pageObj.getInheritable("Resources"));
  if (resources.isNull() || !resources.isDictionary()) {
    resources = doc.newDictionary();
    pageObj.put("Resources", resources);
  }

  let fontDict = dereference(resources.get("Font"));
  if (fontDict.isNull() || !fontDict.isDictionary()) {
    fontDict = doc.newDictionary();
    resources.put("Font", fontDict);
  }

  for (let i = 0; ; i += 1) {
    const name = `Fsel${i}`;
    const existing = fontDict.get(name);
    if (existing.isNull()) {
      fontDict.put(name, fontRef);
      return name;
    }
    if (existing.isIndirect() && fontRef.isIndirect() && existing.asIndirect() === fontRef.asIndirect()) {
      return name;
    }
  }
}

function textToGlyphHex(font: Font, text: string): string {
  let out = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    const glyphId = font.encodeCharacter(codePoint);
    out += Math.max(0, glyphId).toString(16).padStart(4, "0");
  }
  return out;
}

function colorToRgb(color: Color): RGB {
  if (color.length === 1) {
    return [color[0], color[0], color[0]];
  }
  if (color.length >= 3) {
    if (color.length === 4) {
      const [c, m, y, k] = color;
      return [1 - Math.min(1, c + k), 1 - Math.min(1, m + k), 1 - Math.min(1, y + k)];
    }
    return [color[0], color[1], color[2]];
  }
  return [0, 0, 0];
}

function quadToRect(quad: Quad): Rect {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function dereference(obj: PDFObject): PDFObject {
  if (!obj.isNull() && obj.isIndirect()) {
    return obj.resolve();
  }
  return obj;
}

function latin1FromBytes(bytes: Uint8Array): string {
  let out = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return out;
}

export function formatNoFontsMatched(error: NoFontsMatchedError): string {
  const lines = [
    `no fonts matched prefixes=${JSON.stringify(error.prefixes)} exacts=${JSON.stringify(error.exacts)}; input fonts:`,
  ];
  for (const font of error.fonts) {
    lines.push(`  ${font.name} (${font.type})`);
  }
  return lines.join("\n");
}
