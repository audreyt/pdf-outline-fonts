import { pickStrings, type Strings } from "./i18n";
import { formatNoFontsMatched, NoFontsMatchedError, outlinePdf, type OutlineOptions } from "./pdf";

interface RunOptions {
  prefixes: string[];
  exacts: string[];
  selectionLayer: boolean;
}

interface DomRefs {
  drop: HTMLElement;
  fileInput: HTMLInputElement;
  prefixes: HTMLInputElement;
  exacts: HTMLInputElement;
  selectionLayer: HTMLInputElement;
  status: HTMLElement;
  log: HTMLElement;
  download: HTMLAnchorElement;
}

const t: Strings = pickStrings(navigator.languages?.length ? navigator.languages : [navigator.language ?? "en"]);

applyTranslations(t);

const refs: DomRefs = {
  drop: required("drop"),
  fileInput: required<HTMLInputElement>("file"),
  prefixes: required<HTMLInputElement>("prefixes"),
  exacts: required<HTMLInputElement>("exacts"),
  selectionLayer: required<HTMLInputElement>("selectionLayer"),
  status: required("status"),
  log: required("log"),
  download: required<HTMLAnchorElement>("download"),
};

let lastDownloadUrl: string | null = null;

setStatus(t.statusIdle);

refs.fileInput.addEventListener("change", () => {
  const file = refs.fileInput.files?.[0];
  if (file) {
    void run(file);
  }
});

refs.drop.addEventListener("click", () => refs.fileInput.click());

["dragenter", "dragover"].forEach((event) => {
  refs.drop.addEventListener(event, (e) => {
    e.preventDefault();
    refs.drop.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((event) => {
  refs.drop.addEventListener(event, (e) => {
    e.preventDefault();
    refs.drop.classList.remove("dragging");
  });
});

refs.drop.addEventListener("drop", (event: DragEvent) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    void run(file);
  }
});

async function run(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    setStatus(t.statusNotPdf(file.name));
    return;
  }

  resetDownload();
  setStatus(t.statusReading(file.name));
  refs.log.textContent = "";

  const buffer = new Uint8Array(await file.arrayBuffer());
  const opts = readOptions();

  setStatus(t.statusOutlining(file.name));
  await yieldToPaint();

  try {
    const { output, result } = outlinePdf(buffer, toOutlineOptions(opts));
    const blob = new Blob([new Uint8Array(output)], { type: "application/pdf" });
    lastDownloadUrl = URL.createObjectURL(blob);
    refs.download.href = lastDownloadUrl;
    refs.download.download = suggestOutputName(file.name);
    refs.download.hidden = false;

    setStatus(t.statusDone(result.glyphCount, result.pagesChanged));
    refs.log.textContent = `${t.fontsOutlinedHeader}\n  ${result.fontsOutlined.join("\n  ")}`;
  } catch (error) {
    if (error instanceof NoFontsMatchedError) {
      setStatus(t.statusNoFonts);
      refs.log.textContent = formatNoFontsMatched(error);
      return;
    }
    setStatus(t.statusFailed((error as Error).message));
    refs.log.textContent = (error as Error).stack ?? "";
    throw error;
  }
}

function readOptions(): RunOptions {
  return {
    prefixes: splitList(refs.prefixes.value),
    exacts: splitList(refs.exacts.value),
    selectionLayer: refs.selectionLayer.checked,
  };
}

function toOutlineOptions(opts: RunOptions): OutlineOptions {
  return {
    prefixes: opts.prefixes,
    exacts: opts.exacts,
    selectionFont: opts.selectionLayer ? "zh-Hant" : null,
    verbose: false,
  };
}

function splitList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function setStatus(text: string): void {
  refs.status.textContent = text;
}

function resetDownload(): void {
  refs.download.hidden = true;
  refs.download.removeAttribute("href");
  if (lastDownloadUrl) {
    URL.revokeObjectURL(lastDownloadUrl);
    lastDownloadUrl = null;
  }
}

function suggestOutputName(input: string): string {
  return input.replace(/\.pdf$/i, "") + ".outlined.pdf";
}

function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`missing required element: #${id}`);
  }
  return el as T;
}

function applyTranslations(strings: Strings): void {
  document.documentElement.lang = strings.htmlLang;
  document.title = strings.pageTitle;

  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (!key) return;
    const value = (strings as unknown as Record<string, unknown>)[key];
    if (typeof value === "string") {
      el.innerHTML = value;
    }
  });

  document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => {
    const key = el.dataset.i18nPlaceholder;
    if (!key) return;
    const value = (strings as unknown as Record<string, unknown>)[key];
    if (typeof value === "string") {
      el.placeholder = value;
    }
  });
}
