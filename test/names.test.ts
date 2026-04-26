import { describe, expect, test } from "bun:test";
import { baseFontName, fontMatches, namesReferToSameFont } from "../src/names";
import { normalizeSelectionFontName } from "../src/pdf";

describe("font names", () => {
  test("strips subset prefixes", () => {
    expect(baseFontName("ABCDEF+jf-openhuninn")).toBe("jf-openhuninn");
    expect(baseFontName("Helvetica")).toBe("Helvetica");
  });

  test("matches prefixes and exact names", () => {
    expect(fontMatches("jf-openhuninn", ["jf-"], [])).toBe(true);
    expect(fontMatches("MyFont-Bold", [], ["MyFont-Bold"])).toBe(true);
    expect(fontMatches("Other", ["jf-"], ["MyFont-Bold"])).toBe(false);
  });

  test("allows MuPDF-truncated span names", () => {
    expect(namesReferToSameFont("Regul", "Regular")).toBe(true);
    expect(namesReferToSameFont("ABCDEF+Regular", "Regular")).toBe(true);
    expect(namesReferToSameFont("Bold", "Regular")).toBe(false);
  });

  test("maps PyMuPDF-era CJK aliases to MuPDF.js aliases", () => {
    expect(normalizeSelectionFontName("china-t")).toBe("zh-Hant");
    expect(normalizeSelectionFontName("china-s")).toBe("zh-Hans");
    expect(normalizeSelectionFontName("Helvetica")).toBe("Helvetica");
  });
});
