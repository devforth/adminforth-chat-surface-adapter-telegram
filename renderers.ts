type PlaywrightChromium = typeof import("playwright").chromium;

export type RenderTableColumn =
  | string
  | {
      key: string;
      label: string;
    };

export type RenderTablePngInput = {
  columns: RenderTableColumn[];
  rows: Record<string, unknown>[];
  title?: string;
};

export type VegaLiteSpec = Record<string, unknown>;

export type RenderedMessageImage = {
  buffer: Buffer;
  filename: string;
};

export type RenderedMessage = {
  text: string;
  images: RenderedMessageImage[];
};

type RenderableBlock =
  | {
      type: "vega-lite";
      source: string;
      spec: VegaLiteSpec;
      start: number;
      end: number;
    }
  | {
      type: "table";
      source: string;
      table: RenderTablePngInput;
      start: number;
      end: number;
    };

const DEFAULT_VIEWPORT_WIDTH = 1200;
const DEFAULT_VIEWPORT_HEIGHT = 800;
const HTML_ESCAPE_RE = /[&<>"']/g;
const VEGA_LITE_BLOCK_RE = /```vega-lite\s*([\s\S]*?)```/g;
const MARKDOWN_TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const MARKDOWN_TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const VEGA_LITE_FENCE_START = "```vega-lite";
const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(HTML_ESCAPE_RE, (char) => HTML_ESCAPE_MAP[char]);
}

function splitMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  const withoutOuterPipes = trimmed.startsWith("|") && trimmed.endsWith("|")
    ? trimmed.slice(1, -1)
    : trimmed;

  return withoutOuterPipes.split("|").map((cell) => cell.trim());
}

function parseMarkdownTable(lines: string[]): RenderTablePngInput | null {
  if (lines.length < 3) {
    return null;
  }

  const headers = splitMarkdownTableRow(lines[0]);
  const rows = lines.slice(2).map((line) => splitMarkdownTableRow(line));
  const columns = headers.map((header, index) => ({
    key: String(index),
    label: header || `Column ${index + 1}`,
  }));

  return {
    columns,
    rows: rows.map((row) => Object.fromEntries(
      columns.map((column, index) => [column.key, row[index] ?? ""]),
    )),
  };
}

function findVegaLiteBlocks(text: string): RenderableBlock[] {
  const blocks: RenderableBlock[] = [];

  for (const match of text.matchAll(VEGA_LITE_BLOCK_RE)) {
    const source = match[0];
    const json = match[1];
    const start = match.index;

    if (start === undefined) {
      continue;
    }

    blocks.push({
      type: "vega-lite",
      source,
      spec: JSON.parse(json),
      start,
      end: start + source.length,
    });
  }

  return blocks;
}

function findMarkdownTableBlocks(text: string, occupiedBlocks: RenderableBlock[]): RenderableBlock[] {
  const blocks: RenderableBlock[] = [];
  const lines = text.split("\n");
  let offset = 0;

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerLine = lines[index];
    const separatorLine = lines[index + 1];
    const tableStart = offset;

    if (
      occupiedBlocks.some((block) => tableStart >= block.start && tableStart < block.end)
      || !MARKDOWN_TABLE_ROW_RE.test(headerLine)
      || !MARKDOWN_TABLE_SEPARATOR_RE.test(separatorLine)
    ) {
      offset += headerLine.length + 1;
      continue;
    }

    const tableLines = [headerLine, separatorLine];
    let endLineIndex = index + 2;
    let tableEnd = tableStart + headerLine.length + 1 + separatorLine.length;

    while (endLineIndex < lines.length && MARKDOWN_TABLE_ROW_RE.test(lines[endLineIndex])) {
      tableEnd += 1 + lines[endLineIndex].length;
      tableLines.push(lines[endLineIndex]);
      endLineIndex += 1;
    }

    const table = parseMarkdownTable(tableLines);

    if (table) {
      blocks.push({
        type: "table",
        source: tableLines.join("\n"),
        table,
        start: tableStart,
        end: tableEnd,
      });
    }

    for (; index < endLineIndex - 1; index += 1) {
      offset += lines[index].length + 1;
    }
    index -= 1;
  }

  return blocks;
}

function findFirstMarkdownTableStart(text: string) {
  const lines = text.split("\n");
  let offset = 0;

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerLine = lines[index];
    const separatorLine = lines[index + 1];

    if (
      MARKDOWN_TABLE_ROW_RE.test(headerLine)
      && MARKDOWN_TABLE_SEPARATOR_RE.test(separatorLine)
    ) {
      return offset;
    }

    offset += headerLine.length + 1;
  }

  return -1;
}

function getPartialVegaLiteFenceStartLength(text: string) {
  for (let length = Math.min(text.length, VEGA_LITE_FENCE_START.length - 1); length > 0; length -= 1) {
    if (VEGA_LITE_FENCE_START.startsWith(text.slice(-length))) {
      return length;
    }
  }

  return 0;
}

function normalizeTextAfterBlockRemoval(text: string) {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function getFinalMessageStreamPreview(text: string) {
  const vegaLiteStart = text.indexOf(VEGA_LITE_FENCE_START);
  const tableStart = findFirstMarkdownTableStart(text);
  const renderableStarts = [vegaLiteStart, tableStart].filter((start) => start >= 0);

  if (renderableStarts.length) {
    return text.slice(0, Math.min(...renderableStarts)).trimEnd();
  }

  const partialVegaLiteFenceStartLength = getPartialVegaLiteFenceStartLength(text);

  if (!partialVegaLiteFenceStartLength) {
    return text;
  }

  return text.slice(0, -partialVegaLiteFenceStartLength);
}

async function getChromium(): Promise<PlaywrightChromium> {
  const { chromium } = await import("playwright");

  return chromium;
}

export async function renderHtmlBlockToPng(html: string, selector: string): Promise<Buffer> {
  const chromium = await getChromium();
  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const page = await browser.newPage({
      viewport: {
        width: DEFAULT_VIEWPORT_WIDTH,
        height: DEFAULT_VIEWPORT_HEIGHT,
      },
    });

    await page.setContent(html, {
      waitUntil: "networkidle",
    });
    await page.evaluate(() => document.fonts.ready);
    const hasRenderReady = await page.evaluate(() => (
      Boolean((window as typeof window & {
        __adminforthRenderReady?: Promise<void>;
      }).__adminforthRenderReady)
    ));

    if (hasRenderReady) {
      await page.waitForFunction(() => {
        const renderState = window as typeof window & {
          __adminforthRenderDone?: boolean;
          __adminforthRenderError?: string;
        };

        return renderState.__adminforthRenderDone || renderState.__adminforthRenderError;
      });

      const renderError = await page.evaluate(() => (
        (window as typeof window & {
          __adminforthRenderError?: string;
        }).__adminforthRenderError
      ));

      if (renderError) {
        throw new Error(renderError);
      }
    }

    const block = page.locator(selector);
    await block.waitFor({
      state: "visible",
    });

    return await block.screenshot({
      type: "png",
      animations: "disabled",
    });
  } finally {
    await browser.close();
  }
}

export async function renderTablePng(input: RenderTablePngInput): Promise<Buffer> {
  const normalizedColumns = input.columns.map((column) => (
    typeof column === "string"
      ? { key: column, label: column }
      : column
  ));

  const headerHtml = normalizedColumns
    .map((column) => `<th>${escapeHtml(column.label)}</th>`)
    .join("");
  const rowsHtml = input.rows
    .map((row) => (
      `<tr>${
        normalizedColumns
          .map((column) => `<td>${escapeHtml(row[column.key])}</td>`)
          .join("")
      }</tr>`
    ))
    .join("");

  return renderHtmlBlockToPng(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body {
            margin: 0;
            background: #f6f8fa;
            color: #17202a;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }

          #adminforth-table-render {
            display: inline-block;
            padding: 28px;
            background: #ffffff;
          }

          h1 {
            margin: 0 0 18px;
            font-size: 24px;
            font-weight: 700;
          }

          table {
            border-collapse: collapse;
            min-width: 560px;
            max-width: 1120px;
            font-size: 15px;
            line-height: 1.45;
          }

          th,
          td {
            padding: 11px 14px;
            border: 1px solid #d8dee4;
            text-align: left;
            vertical-align: top;
          }

          th {
            background: #eef2f6;
            font-weight: 700;
          }

          tr:nth-child(even) td {
            background: #f9fbfc;
          }
        </style>
      </head>
      <body>
        <section id="adminforth-table-render">
          ${input.title ? `<h1>${escapeHtml(input.title)}</h1>` : ""}
          <table>
            <thead>
              <tr>${headerHtml}</tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </section>
      </body>
    </html>
  `, "#adminforth-table-render");
}

export async function renderVegaLitePng(spec: VegaLiteSpec): Promise<Buffer> {
  return renderHtmlBlockToPng(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <script src="https://cdn.jsdelivr.net/npm/vega@5"></script>
        <script src="https://cdn.jsdelivr.net/npm/vega-lite@5"></script>
        <script src="https://cdn.jsdelivr.net/npm/vega-embed@6"></script>
        <style>
          body {
            margin: 0;
            background: #ffffff;
            color: #17202a;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }

          #adminforth-vega-lite-render {
            display: inline-block;
            padding: 24px;
            background: #ffffff;
          }

          #adminforth-vega-lite-render details {
            display: none;
          }
        </style>
      </head>
      <body>
        <section id="adminforth-vega-lite-render"></section>
        <script>
          window.__adminforthRenderReady = vegaEmbed(
            "#adminforth-vega-lite-render",
            ${JSON.stringify(spec)},
            { actions: false, renderer: "svg" }
          )
            .then(function () {
              window.__adminforthRenderDone = true;
            })
            .catch(function (error) {
              window.__adminforthRenderError = String(error && error.message ? error.message : error);
            });
        </script>
      </body>
    </html>
  `, "#adminforth-vega-lite-render");
}

export async function renderFinalMessageImages(text: string): Promise<RenderedMessage> {
  const vegaLiteBlocks = findVegaLiteBlocks(text);
  const tableBlocks = findMarkdownTableBlocks(text, vegaLiteBlocks);
  const blocks = [...vegaLiteBlocks, ...tableBlocks].sort((a, b) => a.start - b.start);

  if (!blocks.length) {
    return {
      text,
      images: [],
    };
  }

  const remainingTextParts: string[] = [];
  const images: RenderedMessageImage[] = [];
  let cursor = 0;

  for (const [index, block] of blocks.entries()) {
    remainingTextParts.push(text.slice(cursor, block.start));
    cursor = block.end;

    if (block.type === "vega-lite") {
      images.push({
        buffer: await renderVegaLitePng(block.spec),
        filename: `chart-${index + 1}.png`,
      });
      continue;
    }

    images.push({
      buffer: await renderTablePng(block.table),
      filename: `table-${index + 1}.png`,
    });
  }

  remainingTextParts.push(text.slice(cursor));

  return {
    text: normalizeTextAfterBlockRemoval(remainingTextParts.join("")),
    images,
  };
}
