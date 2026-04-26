# pdf-outline-fonts

Selectively convert specific PDF fonts to vector outlines while leaving the
rest of the document untouched, and keep text selection working.

Useful when:
- A PDF embeds a licensed font you can't redistribute, but you want to share
  the visual exactly as designed.
- A specific subset font is causing problems for downstream tools, but you
  don't want to flatten everything to outlines.

## What it does

For every character using a targeted font:
1. Reads the embedded CFF/CID font program and resolves the glyph path from its
   Type 2 CharStrings, using the ToUnicode CMap with a CID == codepoint fallback.
2. Emits the path at the original baseline and color.
3. Redacts the original visible text while leaving images and line art intact.
4. Stamps an invisible (`3 Tr`) text layer with a fallback CJK-capable MuPDF
   font, so select/copy still returns the original text.
5. Saves with garbage collection so the targeted font dictionaries can be
   dropped from the output.

Fonts that don't match the prefix or exact-name list are left as-is.

## Limitations

- Only CFF/Type 1C subsets inside Type-0 composite fonts are supported. Plain
  TrueType fonts are skipped with a notice.
- Selection round-trip is as good as the input PDF's ToUnicode CMap. If the
  source PDF doesn't map a glyph to real Unicode, copy/paste may skip that
  character, but the visible outline can still be drawn.
- The invisible-selection layer adds a subsetted Droid Sans Fallback font to the
  output. Use `--no-selection-layer` to skip it.

## Install

Requires Bun.

```sh
bun install
```

## Use

```sh
# Outline every font whose BaseFont starts with "jf-"
bun run outline deck.pdf deck.outlined.pdf --prefix jf-

# Multiple prefixes / exact names
bun run outline in.pdf out.pdf --prefix jf- --prefix gen- --exact MyFont-Bold

# No invisible selection layer
bun run outline in.pdf out.pdf --prefix jf- --no-selection-layer
```

If no fonts match, the CLI prints the list of fonts in the input so you can pick
the right filter.

## Verify

```sh
# fonts in the output; the targeted ones should be gone entirely
pdffonts deck.outlined.pdf

# unit tests and typecheck
bun test
bun run typecheck

# mutation testing
bun run stryker
```

## License

[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) — public domain dedication.
