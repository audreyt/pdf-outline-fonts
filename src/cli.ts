#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { Command } from "commander";
import { formatNoFontsMatched, NoFontsMatchedError, outlinePdf } from "./pdf";

const program = new Command()
  .name("outline-pdf-fonts")
  .description("Selectively convert specific PDF fonts to vector outlines.")
  .argument("<input>", "input PDF")
  .argument("<output>", "output PDF")
  .option("--prefix <str>", "match BaseFonts whose name starts with STR (after subset prefix); repeatable", collect, [])
  .option("--exact <name>", "match BaseFonts equal to NAME (after subset prefix); repeatable", collect, [])
  .option("--no-selection-layer", "skip the invisible text overlay")
  .option(
    "--selection-font <name>",
    "MuPDF built-in font alias for the invisible selection layer (default: zh-Hant; accepts old china-t alias)",
    "zh-Hant",
  )
  .option("-q, --quiet", "suppress progress")
  .showHelpAfterError();

program.parse();

const [input, output] = program.args as [string, string];
const opts = program.opts<{
  prefix: string[];
  exact: string[];
  noSelectionLayer?: boolean;
  selectionFont: string;
  quiet?: boolean;
}>();

if (opts.prefix.length === 0 && opts.exact.length === 0) {
  program.error("at least one --prefix or --exact is required");
}

if (!existsSync(input)) {
  program.error(`input not found: ${input}`);
}

try {
  outlinePdf(input, output, {
    prefixes: opts.prefix,
    exacts: opts.exact,
    selectionFont: opts.noSelectionLayer ? null : opts.selectionFont,
    verbose: !opts.quiet,
  });
} catch (error) {
  if (error instanceof NoFontsMatchedError) {
    console.error(formatNoFontsMatched(error));
    process.exit(2);
  }
  throw error;
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}
