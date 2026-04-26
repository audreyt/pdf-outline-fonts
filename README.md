# pdf-outline-fonts

Selectively convert specific PDF fonts to vector outlines while leaving the
rest of the document untouched — and keep text selection working.

Useful when:
- A PDF embeds a licensed font you can't redistribute, but you want to share
  the visual exactly as designed.
- A specific subset font is causing problems for downstream tools, but you
  don't want to flatten *everything* to outlines.

## What it does

For every span using a targeted font:
1. Reads the embedded CFF/CID font program and resolves each character's
   glyph path from its CharStrings (using the ToUnicode CMap, with a CID ==
   codepoint fallback for Keynote-style mis-mapped punctuation).
2. Emits the path at the original baseline + color — visually identical.
3. Redacts the original visible text (text-only, leaves images/lines intact).
4. Stamps an invisible (`render_mode=3`) text layer with the same content
   using a fallback CJK-capable font, so select/copy still returns the text.
5. Saves with garbage collection so the targeted font dictionaries are dropped
   entirely (no longer "embedded" or even "referenced").

Fonts that don't match the prefix / exact-name list are left as-is.

## Limitations

- Only **CFF/Type 1C** subsets inside Type-0 composite fonts are supported
  (the most common form for CJK PDFs from Keynote / Pages / Word).
  Plain TrueType fonts are skipped with a notice.
- Selection round-trip is as good as the input PDF's ToUnicode CMap. If the
  source PDF doesn't map a glyph to real Unicode (e.g. Keynote often uses
  CJK Extension-A codepoints for punctuation), copy/paste will skip those
  characters — but the visible outline is still correct.
- The invisible-selection layer adds a subsetted Droid Sans Fallback to the
  output (~few hundred KB). Use `--no-selection-layer` to skip it.

## Install

Requires Python 3.10+.

```sh
pip install -r requirements.txt
```

## Use

```sh
# Outline every font whose BaseFont starts with "jf-"
python outline_pdf_fonts.py deck.pdf deck.outlined.pdf --prefix jf-

# Multiple prefixes / exact names
python outline_pdf_fonts.py in.pdf out.pdf --prefix jf- --prefix gen- --exact MyFont-Bold

# No invisible selection layer (smaller file, outlined text is not selectable)
python outline_pdf_fonts.py in.pdf out.pdf --prefix jf- --no-selection-layer
```

If you don't pass `--prefix` or `--exact`, or no fonts match, the script
prints the list of fonts in the input so you can pick the right filter.

## Verify

```sh
# fonts in the output (the targeted ones should be gone entirely)
pdffonts deck.outlined.pdf

# eyeball a page
mutool draw -o page1.png deck.outlined.pdf 1
```

## License

MIT
