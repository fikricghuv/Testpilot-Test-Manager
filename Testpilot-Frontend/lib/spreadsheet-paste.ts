export interface ParsedStep {
  stepNumber: number;
  action: string;
  expectedResult: string;
}

export interface ParsedSpreadsheetRow {
  externalId?: string;
  component?: string;
  title: string;
  preconditions?: string;
  testData?: string;
  steps: ParsedStep[];
  type: string;
  expectedResult?: string;
  detectedPrefix?: string;
  /** Optional execution columns if the user copied a full sheet including results. */
  executionResult?: string;
  actualResult?: string;
  notes?: string;
}

const PREFIX_TO_TYPE: Record<string, string> = {
  SMOKE: "Smoke",
  IT: "Functional",
  INT: "Integration",
  SIT: "Integration",
  UAT: "Acceptance",
  REG: "Regression",
  DT: "Functional",
};

/**
 * Parses RFC-4180-style TSV (Tab-Separated Values) copied from Google Sheets or Excel,
 * properly handling double-quoted cells that contain newlines or tabs.
 */
export function parseTsvGrid(raw: string): string[][] {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
    } else if (ch === "\t") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  row.push(cell.trim());
  if (row.some((c) => c.length > 0)) {
    rows.push(row);
  }

  return rows;
}

/** Splits multi-line numbered steps (e.g. "1. Buka...\n2. Input...") into structured Step objects. */
export function parseMultilineSteps(rawSteps: string, expectedResult?: string): ParsedStep[] {
  const lines = rawSteps
    .split(/\n+/)
    .map((line) => line.replace(/^\s*\d+[\.\)]\s*/, "").trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return expectedResult
      ? [{ stepNumber: 1, action: "", expectedResult: expectedResult.trim() }]
      : [];
  }

  return lines.map((action, idx) => ({
    stepNumber: idx + 1,
    action,
    expectedResult: idx === lines.length - 1 && expectedResult ? expectedResult.trim() : "",
  }));
}

export function detectPrefixFromExternalId(externalId?: string): string | undefined {
  if (!externalId) return undefined;
  const match = externalId.trim().toUpperCase().match(/^(SMOKE|IT|INT|SIT|UAT|REG|DT)[-_]/);
  return match ? match[1] : undefined;
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isHeaderRow(cells: string[]): boolean {
  const joined = cells.map(normalizeHeader).join(" | ");
  return (
    joined.includes("scenario") ||
    joined.includes("test case") ||
    joined.includes("test steps") ||
    joined.includes("expected result") ||
    joined.includes("pre condition") ||
    joined.includes("precondition")
  );
}

type ColumnMap = {
  no?: number;
  module?: number;
  title?: number;
  externalId?: number;
  preconditions?: number;
  testData?: number;
  steps?: number;
  testType?: number;
  expectedResult?: number;
  actualResult?: number;
  result?: number;
  notes?: number;
};

function buildHeaderMap(headerCells: string[]): ColumnMap {
  const map: ColumnMap = {};
  headerCells.forEach((raw, idx) => {
    const h = normalizeHeader(raw);
    if (h === "no" || h === "#") map.no = idx;
    else if (h.includes("module") || h.includes("menu") || h.includes("endpoint") || h === "component") map.module = idx;
    else if (h === "test case id" || h === "tc id" || h === "id") map.externalId = idx;
    else if (h.includes("scenario") || h.includes("test case") || h === "title") map.title = idx;
    else if (h.includes("pre condition") || h.includes("precondition")) map.preconditions = idx;
    else if (h.includes("test data")) map.testData = idx;
    else if (h.includes("test steps") || h === "steps") map.steps = idx;
    else if (h.includes("test type") || h === "type") map.testType = idx;
    else if (h.includes("expected result") || h === "expected") map.expectedResult = idx;
    else if (h.includes("actual result")) map.actualResult = idx;
    else if (h === "result" || h === "status") map.result = idx;
    else if (h === "notes" || h === "note") map.notes = idx;
  });
  return map;
}

/**
 * Parses pasted Google Sheet / Excel rows into Testpilot test cases.
 * Supports:
 * 1. Full QA Sheet with or without header row:
 *    No | Module / Menu / Endpoint | Scenario / Test Case | Test Case ID | Pre-Condition | Test Data | Test Steps | Test Type | Expected Result | ...
 * 2. Compact paste: Title only (1 col) or Title | Expected Result (2 cols) or ID | Title | Expected (3 cols)
 */
export function parseSpreadsheetPaste(raw: string): ParsedSpreadsheetRow[] {
  const grid = parseTsvGrid(raw);
  if (grid.length === 0) return [];

  let colMap: ColumnMap | null = null;
  let dataRows = grid;

  if (isHeaderRow(grid[0])) {
    colMap = buildHeaderMap(grid[0]);
    dataRows = grid.slice(1);
  }

  const results: ParsedSpreadsheetRow[] = [];

  for (const cells of dataRows) {
    if (cells.length === 0) continue;

    // Header-mapped mode
    if (colMap && colMap.title !== undefined) {
      const title = cells[colMap.title] ?? "";
      if (!title) continue;
      const externalId = colMap.externalId !== undefined ? cells[colMap.externalId] || undefined : undefined;
      const detectedPrefix = detectPrefixFromExternalId(externalId);
      const expectedResult = colMap.expectedResult !== undefined ? cells[colMap.expectedResult] || undefined : undefined;
      const rawSteps = colMap.steps !== undefined ? cells[colMap.steps] || "" : "";
      const rawType = colMap.testType !== undefined ? cells[colMap.testType] || "" : "";
      const mappedType =
        (detectedPrefix && PREFIX_TO_TYPE[detectedPrefix]) ||
        (rawType.toLowerCase().includes("smoke") ? "Smoke" : rawType.toLowerCase().includes("reg") ? "Regression" : "Functional");

      results.push({
        externalId,
        component: colMap.module !== undefined ? cells[colMap.module] || undefined : undefined,
        title,
        preconditions: colMap.preconditions !== undefined ? cells[colMap.preconditions] || undefined : undefined,
        testData: colMap.testData !== undefined ? cells[colMap.testData] || undefined : undefined,
        steps: parseMultilineSteps(rawSteps, expectedResult),
        type: mappedType,
        expectedResult,
        detectedPrefix,
        actualResult: colMap.actualResult !== undefined ? cells[colMap.actualResult] || undefined : undefined,
        executionResult: colMap.result !== undefined ? cells[colMap.result] || undefined : undefined,
        notes: colMap.notes !== undefined ? cells[colMap.notes] || undefined : undefined,
      });
      continue;
    }

    // Headerless heuristic mode:
    // Detect standard 9+ column QA format:
    // [0: No] [1: Module] [2: Scenario] [3: Test Case ID] [4: Pre-Condition] [5: Test Data] [6: Test Steps] [7: Test Type] [8: Expected Result] ...
    const looksLikeFullQaRow =
      cells.length >= 6 &&
      (/^\d+$/.test(cells[0]) || detectPrefixFromExternalId(cells[3]) !== undefined);

    if (looksLikeFullQaRow) {
      const title = cells[2] || "";
      if (!title) continue;
      const externalId = cells[3] || undefined;
      const detectedPrefix = detectPrefixFromExternalId(externalId);
      const expectedResult = cells[8] || undefined;
      const mappedType = (detectedPrefix && PREFIX_TO_TYPE[detectedPrefix]) || "Functional";

      results.push({
        externalId,
        component: cells[1] || undefined,
        title,
        preconditions: cells[4] || undefined,
        testData: cells[5] || undefined,
        steps: parseMultilineSteps(cells[6] || "", expectedResult),
        type: mappedType,
        expectedResult,
        detectedPrefix,
        actualResult: cells[9] || undefined,
        executionResult: cells[10] || undefined,
        notes: cells[13] || undefined,
      });
      continue;
    }

    // Compact paste fallback (1-3 columns)
    if (cells.length === 1) {
      results.push({ title: cells[0], steps: [], type: "Functional" });
    } else if (cells.length === 2) {
      results.push({
        title: cells[0],
        expectedResult: cells[1] || undefined,
        steps: cells[1] ? [{ stepNumber: 1, action: cells[0], expectedResult: cells[1] }] : [],
        type: "Functional",
      });
    } else {
      const maybePrefix = detectPrefixFromExternalId(cells[0]);
      const externalId = maybePrefix ? cells[0] : undefined;
      const title = maybePrefix ? cells[1] : cells[0];
      if (!title) continue;
      const expectedResult = maybePrefix ? cells[2] : cells[1];
      results.push({
        externalId,
        detectedPrefix: maybePrefix,
        title,
        expectedResult: expectedResult || undefined,
        steps: expectedResult ? [{ stepNumber: 1, action: title, expectedResult }] : [],
        type: (maybePrefix && PREFIX_TO_TYPE[maybePrefix]) || "Functional",
      });
    }
  }

  return results;
}
