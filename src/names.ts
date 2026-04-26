export function baseFontName(nameWithSubset: string): string {
  const plus = nameWithSubset.indexOf("+");
  return plus >= 0 ? nameWithSubset.slice(plus + 1) : nameWithSubset;
}

export function fontMatches(name: string, prefixes: readonly string[], exacts: readonly string[]): boolean {
  return prefixes.some((prefix) => name.startsWith(prefix)) || exacts.includes(name);
}

export function namesReferToSameFont(spanFont: string, fullFontName: string): boolean {
  const spanBase = baseFontName(spanFont);
  const fullBase = baseFontName(fullFontName);
  return spanBase === fullBase || fullBase.startsWith(spanBase) || spanBase.startsWith(fullBase);
}
