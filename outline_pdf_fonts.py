#!/usr/bin/env python3
"""Selectively convert specific PDF fonts to vector outlines.

Use this when a PDF embeds a licensed font that you can't redistribute (or just
want to drop) but still want the document to render identically — and ideally
keep text selection working.

Strategy
--------
For every text span using a targeted font:
  1. Look up the embedded CFF/CID font and resolve each character's glyph path
     from its CharStrings (with the ToUnicode CMap, plus a CID==codepoint
     fallback for Keynote-style mis-mapped punctuation).
  2. Emit the path at the original baseline + color — visually identical.
  3. Redact the original visible text (text-only, leaves images/lines intact).
  4. Stamp an invisible (rendering-mode-3) text layer with the same content
     using a fallback CJK-capable font, so select/copy still returns the
     original text.
  5. Save with garbage collection so the targeted font dictionaries are
     dropped entirely (no longer "embedded" or even "referenced").

Other fonts in the document remain embedded and untouched.
"""

from __future__ import annotations

import argparse
import re
import sys
from io import BytesIO
from pathlib import Path

import fitz  # PyMuPDF
from fontTools.cffLib import CFFFontSet
from fontTools.pens.basePen import BasePen


# ---------- ToUnicode CMap parsing ----------

_HEX = r"<([0-9A-Fa-f]+)>"


def parse_tounicode_cmap(cmap_text: str) -> dict[int, int]:
    """Parse a ToUnicode CMap stream. Returns {cid: first_unicode_codepoint}.

    Handles `bfchar` and `bfrange` entries, including bfrange with explicit
    arrays (`<src1> <src2> [ <dst1> <dst2> ... ]`).
    """
    mapping: dict[int, int] = {}

    # bfchar
    for m in re.finditer(r"beginbfchar(.*?)endbfchar", cmap_text, re.DOTALL):
        block = m.group(1)
        for cm in re.finditer(rf"{_HEX}\s+{_HEX}", block):
            cid = int(cm.group(1), 16)
            uni_hex = cm.group(2)
            if len(uni_hex) >= 4:
                mapping[cid] = int(uni_hex[:4], 16)

    # bfrange
    for m in re.finditer(r"beginbfrange(.*?)endbfrange", cmap_text, re.DOTALL):
        block = m.group(1)
        tokens = re.findall(r"<[0-9A-Fa-f]+>|\[|\]", block)
        i = 0
        while i < len(tokens):
            t = tokens[i]
            if t.startswith("<"):
                src1 = int(t[1:-1], 16)
                src2 = int(tokens[i + 1][1:-1], 16)
                if tokens[i + 2] == "[":
                    j = i + 3
                    cid = src1
                    while tokens[j] != "]":
                        uni_hex = tokens[j][1:-1]
                        if len(uni_hex) >= 4:
                            mapping[cid] = int(uni_hex[:4], 16)
                        cid += 1
                        j += 1
                    i = j + 1
                else:
                    dst = int(tokens[i + 2][1:-1], 16)
                    for off in range(src2 - src1 + 1):
                        mapping[src1 + off] = dst + off
                    i += 3
            else:
                i += 1

    return mapping


# ---------- glyph -> PDF path operators ----------

class PdfPathPen(BasePen):
    """fontTools pen that records ops in PDF content-stream form.

    Records: ('m', x, y), ('l', x, y),
             ('c', x1, y1, x2, y2, x3, y3), ('h',).
    Coordinates stay in font units; the caller scales/translates via `cm`.
    """

    def __init__(self, glyphSet=None):
        super().__init__(glyphSet or {})
        self.ops: list[tuple] = []

    def _moveTo(self, pt):
        self.ops.append(("m", pt[0], pt[1]))

    def _lineTo(self, pt):
        self.ops.append(("l", pt[0], pt[1]))

    def _curveToOne(self, pt1, pt2, pt3):
        self.ops.append(("c", pt1[0], pt1[1], pt2[0], pt2[1], pt3[0], pt3[1]))

    def _qCurveToOne(self, pt1, pt2):
        cur = self._getCurrentPoint()
        c1 = (cur[0] + 2 / 3 * (pt1[0] - cur[0]),
              cur[1] + 2 / 3 * (pt1[1] - cur[1]))
        c2 = (pt2[0] + 2 / 3 * (pt1[0] - pt2[0]),
              pt2[1] + 2 / 3 * (pt1[1] - pt2[1]))
        self.ops.append(("c", c1[0], c1[1], c2[0], c2[1], pt2[0], pt2[1]))

    def _closePath(self):
        self.ops.append(("h",))


# ---------- font matching + loading ----------

def base_font_name(name_with_subset: str) -> str:
    """Strip a 6-letter+`+` PDF font subset prefix."""
    return name_with_subset.split("+", 1)[1] if "+" in name_with_subset else name_with_subset


def font_matches(name: str, prefixes: list[str], exacts: list[str]) -> bool:
    return any(name.startswith(p) for p in prefixes) or name in exacts


def load_target_fonts(
    doc: fitz.Document, prefixes: list[str], exacts: list[str]
) -> dict[int, dict]:
    """Find xrefs for fonts to outline; load CFF + ToUnicode info per xref."""
    out: dict[int, dict] = {}
    seen: set[int] = set()
    for pno in range(doc.page_count):
        for f in doc.get_page_fonts(pno):
            xref = f[0]
            if xref in seen:
                continue
            seen.add(xref)
            base = base_font_name(f[3])
            if not font_matches(base, prefixes, exacts):
                continue
            ext = f[1]
            if ext != "cid":
                # CFF/Type1C inside Type 0 is what we know how to render.
                # TrueType (TTF inside Type 0) would need a different reader.
                print(f"  skip {base!r}: unsupported font program type {ext!r}")
                continue

            _name, _ext, _ftype, content = doc.extract_font(xref)
            cff_set = CFFFontSet()
            cff_set.decompile(BytesIO(content), otFont=None)
            top = cff_set.topDictIndex[0]

            # ToUnicode CMap -> CID -> Unicode, then invert
            font_obj = doc.xref_object(xref)
            uni2cid: dict[int, int] = {}
            m = re.search(r"/ToUnicode\s+(\d+)\s+\d+\s+R", font_obj)
            if m:
                cmap_xref = int(m.group(1))
                cmap_text = doc.xref_stream(cmap_xref).decode("latin-1", "replace")
                cid2uni = parse_tounicode_cmap(cmap_text)
                for cid, uni in cid2uni.items():
                    if uni not in uni2cid:
                        uni2cid[uni] = cid

            # FontMatrix scale: typically 0.001 for 1000-unit em
            scale = 0.001
            try:
                fd = top.FDArray[0]
                if hasattr(fd, "FontMatrix") and fd.FontMatrix:
                    scale = float(fd.FontMatrix[0])
            except Exception:
                pass

            out[xref] = {
                "name": base,
                "cff_top": top,
                "uni2cid": uni2cid,
                "fontmatrix_scale": scale,
            }
    return out


def name_matches_xref(span_font: str, target_info: dict[int, dict]) -> int | None:
    """PyMuPDF sometimes truncates font names in get_text() output (e.g.
    'Regul' for 'Regular'). Match by full BaseFont or prefix."""
    for xref, info in target_info.items():
        full = info["name"]
        if span_font == full or full.startswith(span_font):
            return xref
    return None


def color_int_to_rgb(c: int) -> tuple[float, float, float]:
    return (((c >> 16) & 0xFF) / 255.0,
            ((c >> 8) & 0xFF) / 255.0,
            (c & 0xFF) / 255.0)


def build_path_content_stream(paths_to_draw: list[dict], page_height: float) -> bytes:
    """Emit PDF content-stream bytes that draw all given glyphs.

    PyMuPDF rawdict origins are Y-down; PDF content streams and CFF charstrings
    are Y-up. Convert origin Y by `page_height - y`, and apply scale on both
    axes (no Y-flip).
    """
    parts: list[str] = ["q"]
    last_color = None
    for item in paths_to_draw:
        ops = item["ops"]
        if not ops:
            continue
        ox, oy_down = item["origin"]
        oy = page_height - oy_down
        s = item["size"] * item["scale"]
        color = item["color"]
        if color != last_color:
            parts.append(f"{color[0]:.4f} {color[1]:.4f} {color[2]:.4f} rg")
            last_color = color
        parts.append("q")
        parts.append(f"{s:.6f} 0 0 {s:.6f} {ox:.4f} {oy:.4f} cm")
        for op in ops:
            tag = op[0]
            if tag == "m":
                parts.append(f"{op[1]:.4f} {op[2]:.4f} m")
            elif tag == "l":
                parts.append(f"{op[1]:.4f} {op[2]:.4f} l")
            elif tag == "c":
                parts.append(
                    f"{op[1]:.4f} {op[2]:.4f} "
                    f"{op[3]:.4f} {op[4]:.4f} "
                    f"{op[5]:.4f} {op[6]:.4f} c"
                )
            elif tag == "h":
                parts.append("h")
        parts.append("f")
        parts.append("Q")
    parts.append("Q")
    return ("\n".join(parts) + "\n").encode("latin-1")


def append_content_stream(doc: fitz.Document, page: fitz.Page, stream_bytes: bytes) -> None:
    """Add a new content stream xref and append it to the page's /Contents."""
    new_xref = doc.get_new_xref()
    doc.update_object(new_xref, "<<>>")
    doc.update_stream(new_xref, stream_bytes)
    contents = doc.xref_get_key(page.xref, "Contents")
    if contents[0] == "array":
        body = contents[1].rstrip().rstrip("]").rstrip()
        new_contents = f"{body} {new_xref} 0 R ]"
    elif contents[0] == "xref":
        new_contents = f"[ {contents[1]} {new_xref} 0 R ]"
    else:
        raise RuntimeError(f"unexpected /Contents form: {contents}")
    doc.xref_set_key(page.xref, "Contents", new_contents)


# ---------- main ----------

def outline_pdf(
    in_path: Path,
    out_path: Path,
    prefixes: list[str],
    exacts: list[str],
    selection_font: str | None = "china-t",
    verbose: bool = True,
) -> None:
    doc = fitz.open(in_path)
    target_info = load_target_fonts(doc, prefixes, exacts)
    if not target_info:
        print(f"no fonts matched prefixes={prefixes!r} exacts={exacts!r}; "
              "input fonts:")
        seen: set[int] = set()
        for pno in range(doc.page_count):
            for f in doc.get_page_fonts(pno):
                if f[0] in seen:
                    continue
                seen.add(f[0])
                print(f"  {base_font_name(f[3])} ({f[1]})")
        sys.exit(2)

    if verbose:
        print(f"outlining: {[i['name'] for i in target_info.values()]}")

    pages_changed = 0
    glyph_count = 0
    for pno in range(doc.page_count):
        page = doc[pno]
        text_dict = page.get_text("rawdict")

        paths_to_draw: list[dict] = []
        redact_rects: list[fitz.Rect] = []
        invisible_spans: list[dict] = []

        for block in text_dict["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    xref = name_matches_xref(span["font"], target_info)
                    if xref is None:
                        continue
                    info = target_info[xref]
                    cs = info["cff_top"].CharStrings
                    color = color_int_to_rgb(span["color"])
                    size = span["size"]
                    scale = info["fontmatrix_scale"]
                    span_chars: list[str] = []
                    for ch in span["chars"]:
                        c = ch["c"]
                        if len(c) != 1:
                            continue
                        cp = ord(c)
                        # Try ToUnicode CMap first; if absent, fall back to
                        # codepoint-as-CID (matches PyMuPDF's text extraction
                        # fallback for unmapped CIDs).
                        glyph_name = None
                        cid = info["uni2cid"].get(cp)
                        if cid is not None:
                            cand = f"cid{cid:05d}"
                            if cand in cs:
                                glyph_name = cand
                        if glyph_name is None:
                            cand = f"cid{cp:05d}"
                            if cand in cs:
                                glyph_name = cand
                        if glyph_name is None:
                            continue
                        pen = PdfPathPen()
                        try:
                            cs[glyph_name].draw(pen)
                        except Exception:
                            continue
                        paths_to_draw.append({
                            "origin": ch["origin"],
                            "size": size,
                            "color": color,
                            "ops": pen.ops,
                            "scale": scale,
                        })
                        redact_rects.append(fitz.Rect(*ch["bbox"]))
                        span_chars.append(c)
                        glyph_count += 1
                    if span_chars:
                        invisible_spans.append({
                            "origin": span["origin"],
                            "size": size,
                            "text": "".join(span_chars),
                        })

        if not paths_to_draw:
            continue

        for r in redact_rects:
            page.add_redact_annot(r)
        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_NONE,
            graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            text=fitz.PDF_REDACT_TEXT_REMOVE,
        )

        append_content_stream(
            doc, page, build_path_content_stream(paths_to_draw, page.rect.height)
        )

        if selection_font and invisible_spans:
            cjk_font = fitz.Font(selection_font)
            tw = fitz.TextWriter(page.rect)
            for inv in invisible_spans:
                tw.append(inv["origin"], inv["text"], font=cjk_font, fontsize=inv["size"])
            tw.write_text(page, render_mode=3)

        pages_changed += 1
        if verbose:
            print(f"  page {pno + 1}: {len(paths_to_draw)} glyph(s) "
                  f"in {len(invisible_spans)} span(s)")

    if verbose:
        print(f"changed {pages_changed} page(s), outlined {glyph_count} glyph(s) total")

    try:
        doc.subset_fonts(verbose=False)
    except Exception as e:
        if verbose:
            print(f"subset_fonts skipped: {e}")

    doc.save(out_path, garbage=4, deflate=True, deflate_fonts=True, clean=True)
    if verbose:
        print(f"saved -> {out_path}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="outline_pdf_fonts",
        description=__doc__.split("\n\n")[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples
--------
  # Outline every font whose BaseFont starts with "jf-"
  outline_pdf_fonts deck.pdf deck.outlined.pdf --prefix jf-

  # Multiple prefixes / exact names
  outline_pdf_fonts in.pdf out.pdf --prefix jf- --prefix gen- --exact MyFont-Bold

  # Skip the invisible selection layer (smaller file, no text-copy support)
  outline_pdf_fonts in.pdf out.pdf --prefix jf- --no-selection-layer
""",
    )
    p.add_argument("input", type=Path, help="input PDF")
    p.add_argument("output", type=Path, help="output PDF")
    p.add_argument(
        "--prefix",
        action="append",
        default=[],
        metavar="STR",
        help="match BaseFonts whose name starts with STR (after subset prefix);"
             " repeatable",
    )
    p.add_argument(
        "--exact",
        action="append",
        default=[],
        metavar="NAME",
        help="match BaseFonts equal to NAME (after subset prefix); repeatable",
    )
    p.add_argument(
        "--no-selection-layer",
        action="store_true",
        help="skip the invisible text overlay (outlined text won't be selectable)",
    )
    p.add_argument(
        "--selection-font",
        default="china-t",
        metavar="NAME",
        help="PyMuPDF built-in font alias for the invisible selection layer "
             "(default: china-t = Droid Sans Fallback, covers CJK + Latin)",
    )
    p.add_argument("-q", "--quiet", action="store_true", help="suppress progress")
    args = p.parse_args(argv)

    if not args.prefix and not args.exact:
        p.error("at least one --prefix or --exact is required")
    if not args.input.exists():
        p.error(f"input not found: {args.input}")

    outline_pdf(
        args.input,
        args.output,
        prefixes=args.prefix,
        exacts=args.exact,
        selection_font=None if args.no_selection_layer else args.selection_font,
        verbose=not args.quiet,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
