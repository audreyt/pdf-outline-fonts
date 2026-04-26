interface Strings {
  intro: string;
  drop: string;
  prefixesLabel: string;
  prefixesPlaceholder: string;
  exactsLabel: string;
  exactsPlaceholder: string;
  selectionLayer: string;
  download: string;
  sourceLink: string;
  statusIdle: string;
  statusReading: (file: string) => string;
  statusOutlining: (file: string) => string;
  statusDone: (glyphs: number, pages: number) => string;
  statusNoFonts: string;
  statusFailed: (message: string) => string;
  statusNotPdf: (file: string) => string;
  fontsOutlinedHeader: string;
  pageTitle: string;
  htmlLang: string;
}

const en: Strings = {
  intro:
    "Convert specific PDF fonts to vector outlines, in your browser. The file never leaves this page. Defaults to every font whose BaseFont starts with <code>jf-</code>.",
  drop: "Drop a PDF here, or click to choose.",
  prefixesLabel: "Prefixes",
  prefixesPlaceholder: "jf-, gen-",
  exactsLabel: "Exact BaseFonts",
  exactsPlaceholder: "MyFont-Bold",
  selectionLayer: "Add invisible selection layer (Droid Sans Fallback)",
  download: "Download outlined PDF",
  sourceLink: "Source on GitHub",
  statusIdle:
    "Drop a PDF or click to choose. Default: outline every font whose BaseFont starts with jf-.",
  statusReading: (file) => `Reading ${file}…`,
  statusOutlining: (file) => `Outlining ${file}…`,
  statusDone: (glyphs, pages) =>
    `Done: outlined ${glyphs} glyph(s) across ${pages} page(s). Click below to download.`,
  statusNoFonts: "No fonts matched the current prefixes / exacts.",
  statusFailed: (message) => `Failed: ${message}`,
  statusNotPdf: (file) => `Not a PDF: ${file}`,
  fontsOutlinedHeader: "Fonts outlined:",
  pageTitle: "pdf-outline-fonts",
  htmlLang: "en",
};

const zh: Strings = {
  intro:
    "在瀏覽器中把指定的 PDF 字型轉成向量外框；檔案不會離開這個頁面。預設處理 BaseFont 以 <code>jf-</code> 開頭的所有字型。",
  drop: "把 PDF 拖到這裡，或點擊選取檔案。",
  prefixesLabel: "字型名稱前綴",
  prefixesPlaceholder: "jf-, gen-",
  exactsLabel: "完整 BaseFont 名稱",
  exactsPlaceholder: "MyFont-Bold",
  selectionLayer: "加入隱形選取文字層（Droid Sans Fallback）",
  download: "下載已轉外框的 PDF",
  sourceLink: "GitHub 原始碼",
  statusIdle:
    "把 PDF 拖進來，或點擊選取檔案。預設：處理 BaseFont 以 jf- 開頭的所有字型。",
  statusReading: (file) => `讀取 ${file} 中…`,
  statusOutlining: (file) => `轉換 ${file} 中…`,
  statusDone: (glyphs, pages) =>
    `完成：在 ${pages} 頁中轉換了 ${glyphs} 個字符。點擊下方下載。`,
  statusNoFonts: "沒有字型符合目前的前綴 / 完整名稱。",
  statusFailed: (message) => `失敗：${message}`,
  statusNotPdf: (file) => `這不是 PDF：${file}`,
  fontsOutlinedHeader: "已轉外框的字型：",
  pageTitle: "PDF 字型外框轉換",
  htmlLang: "zh-Hant",
};

export function pickStrings(languages: readonly string[]): Strings {
  return languages.some((lang) => /^zh\b/i.test(lang)) ? zh : en;
}

export type { Strings };
