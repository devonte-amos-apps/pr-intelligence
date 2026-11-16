// Deterministic "What this PR changes" from the git diff.
// Prefer added/modified/removed top-level or exported functions and classes in
// TS/JS/MJS files; fall back to file-level added/modified/removed/renamed.

import { completeProse } from "./markdown.mjs";

const JS_FILE = /\.(m?[jt]sx?)$/i;
const WORKFLOW_FILE = /^\.github\/workflows\/.+\.ya?ml$/i;
const TOP_LEVEL_DECL =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/;
const TOP_LEVEL_CONST_FN =
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\*?|\(|[A-Za-z_$][\w$]*\s*=>)/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: (.*))?$/;
const FILE_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const PIN_FOLLOWUP =
  /\b(tool-ref|TEST\s+pin|temporary\s+pin|pin(?:ning)?\b.{0,80}(?:workflow|pr-intelligence)|revert.{0,80}@v1|@v1.{0,40}before\s+merg)/i;
const NON_V1_PIN =
  /(?:uses:\s*\S*pr-architecture-intelligence\.yml@|tool-ref:\s*)(?!v\d)([0-9a-f]{7,40})\b/i;

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").trim();
}

export function isTestPath(path) {
  const normalised = normalizePath(path);
  if (normalised === "tests" || normalised.startsWith("tests/")) return true;
  const base = normalised.split("/").pop() || "";
  return /\.(?:test|spec)\.[^.]+$/i.test(base);
}

function partitionTests(items) {
  const tests = [];
  const rest = [];
  for (const entry of items || []) {
    if (isTestPath(entry.path) || isTestPath(entry.from || "")) tests.push(entry);
    else rest.push(entry);
  }
  return { tests, rest };
}

function withTests(changes) {
  const tests = [];
  const next = { ...changes };
  for (const key of ["added", "modified", "removed", "renamed"]) {
    const { tests: moved, rest } = partitionTests(changes[key]);
    tests.push(...moved);
    next[key] = rest;
  }
  next.tests = tests;
  return next;
}

function declarationName(line) {
  const text = String(line || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const match = TOP_LEVEL_DECL.exec(text) || TOP_LEVEL_CONST_FN.exec(text);
  return match ? match[1] : null;
}

function isTopLevelLine(codeLine) {
  return codeLine.length > 0 && !/^\s/.test(codeLine);
}

export function parseNameStatus(changedFiles) {
  const entries = [];
  const text = String(changedFiles || "");
  const rows = text.includes("\0")
    ? text.split("\0").filter(Boolean)
    : text.split(/\r?\n/).filter(Boolean);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const tab = row.indexOf("\t");
    const status = (tab === -1 ? row : row.slice(0, tab)).trim();
    const rest = tab === -1 ? "" : row.slice(tab + 1);
    if (/^R\d*/.test(status)) {
      const parts = rest.split("\t");
      let from = parts[0], to = parts[1];
      if (!to && i + 1 < rows.length) {
        to = rows[i + 1];
        i += 1;
      }
      if (from && to) entries.push({ status: "R", from: normalizePath(from), path: normalizePath(to) });
    } else if (status && rest) {
      entries.push({ status: status[0], path: normalizePath(rest) });
    }
  }
  return entries;
}

function applyLine(info, code, kind) {
  const name = declarationName(code);
  if (kind === "header") {
    if (name) info.scope = name;
    return;
  }
  const topLevel = isTopLevelLine(code);
  if (topLevel && name) {
    info.scope = name;
    if (kind === "add") info.added.add(name);
    else if (kind === "remove") info.removed.add(name);
    return;
  }
  if ((kind === "add" || kind === "remove") && !topLevel && info.scope) {
    info.bodyModified.add(info.scope);
  }
}

export function parseDiffSymbols(diff) {
  const files = new Map();
  let current = null;
  for (const raw of String(diff || "").split(/\r?\n/)) {
    const fileHeader = FILE_HEADER.exec(raw);
    if (fileHeader) {
      current = { path: normalizePath(fileHeader[2]), added: new Set(), removed: new Set(), bodyModified: new Set(), scope: "" };
      files.set(current.path, current);
      continue;
    }
    if (!current) continue;
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      applyLine(current, hunk[1] || "", "header");
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("similarity ") || raw.startsWith("rename ")) {
      continue;
    }
    if (raw.startsWith("+") || raw.startsWith("-") || raw.startsWith(" ")) {
      const kind = raw.startsWith("+") ? "add" : raw.startsWith("-") ? "remove" : "context";
      applyLine(current, raw.slice(1), kind);
    }
  }
  const result = new Map();
  for (const [path, info] of files) {
    const added = [...info.added].filter((name) => !info.removed.has(name));
    const removed = [...info.removed].filter((name) => !info.added.has(name));
    const modified = new Set(
      [...info.added].filter((name) => info.removed.has(name)),
    );
    for (const name of info.bodyModified) {
      if (!info.added.has(name) && !info.removed.has(name)) modified.add(name);
    }
    result.set(path, { added, modified: [...modified], removed });
  }
  return result;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sentenceMentioning(text, name) {
  if (!text || !name) return "";
  const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`);
  const compact = String(text).replace(/\s+/g, " ").trim();
  if (!pattern.test(compact)) return "";
  const sentences = compact.split(/(?<=[.!?])\s+/);
  const hit = sentences.find((sentence) => pattern.test(sentence)) || compact;
  return completeProse(hit, 500);
}

function descriptionsFromReview(review) {
  return {
    added: review?.changes?.added || "",
    modified: review?.changes?.refactored || review?.changes?.modified || "",
    removed: review?.changes?.removed || "",
    summary: review?.summary || "",
  };
}

function describe(name, path, category, review) {
  const texts = descriptionsFromReview(review);
  const pool = [];
  const seen = new Set();
  for (const text of [texts[category], texts.summary, texts.added, texts.modified, texts.removed]) {
    if (!text || seen.has(text)) continue;
    seen.add(text);
    pool.push(text);
  }
  for (const text of pool) {
    const mention = sentenceMentioning(text, name) || sentenceMentioning(text, path);
    if (mention) return mention;
  }
  return "";
}

function item(name, path, category, review) {
  const description = describe(name, path, category, review);
  return { name, path, description };
}

export function deriveChangesFromDiff({ changedFiles = "", diff = "", review = null } = {}) {
  const files = parseNameStatus(changedFiles);
  const symbolsByFile = parseDiffSymbols(diff);
  const added = [];
  const modified = [];
  const removed = [];
  const renamed = [];
  const filesWithoutSymbols = [];

  for (const file of files) {
    if (file.status === "R") {
      const symbols = symbolsByFile.get(file.path) || symbolsByFile.get(file.from);
      const hasSymbols = symbols && (symbols.added.length || symbols.modified.length || symbols.removed.length);
      if (hasSymbols && JS_FILE.test(file.path)) {
        added.push(...symbols.added.map((name) => item(name, file.path, "added", review)));
        modified.push(...symbols.modified.map((name) => item(name, file.path, "modified", review)));
        removed.push(...symbols.removed.map((name) => item(name, file.path, "removed", review)));
      } else {
        renamed.push({ from: file.from, path: file.path });
      }
      continue;
    }
    const symbols = symbolsByFile.get(file.path);
    const hasSymbols = JS_FILE.test(file.path) && symbols
      && (symbols.added.length || symbols.modified.length || symbols.removed.length);
    if (hasSymbols) {
      added.push(...(symbols.added || []).map((name) => item(name, file.path, "added", review)));
      modified.push(...(symbols.modified || []).map((name) => item(name, file.path, "modified", review)));
      removed.push(...(symbols.removed || []).map((name) => item(name, file.path, "removed", review)));
    } else {
      filesWithoutSymbols.push(file);
    }
  }

  const anySymbols = added.length + modified.length + removed.length > 0;
  if (!anySymbols) {
    return withTests({
      kind: "files",
      added: files.filter((file) => file.status === "A").map((file) => ({ path: file.path })),
      modified: files.filter((file) => file.status === "M").map((file) => ({ path: file.path })),
      removed: files.filter((file) => file.status === "D").map((file) => ({ path: file.path })),
      renamed: files.filter((file) => file.status === "R").map((file) => ({ from: file.from, path: file.path })),
    });
  }

  for (const file of filesWithoutSymbols) {
    if (file.status === "A") added.push({ name: "", path: file.path, description: describe("", file.path, "added", review) });
    else if (file.status === "D") removed.push({ name: "", path: file.path, description: describe("", file.path, "removed", review) });
    else if (file.status === "M") modified.push({ name: "", path: file.path, description: describe("", file.path, "modified", review) });
  }

  return withTests({ kind: "symbols", added, modified, removed, renamed });
}

function newFileLines(diff, path) {
  const lines = [];
  let current = null;
  const wanted = normalizePath(path);
  for (const raw of String(diff || "").split(/\r?\n/)) {
    const fileHeader = FILE_HEADER.exec(raw);
    if (fileHeader) {
      current = normalizePath(fileHeader[2]);
      continue;
    }
    if (current !== wanted) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) lines.push(raw.slice(1));
    else if (raw.startsWith(" ") || raw.startsWith("\t")) lines.push(raw.slice(1));
  }
  return lines;
}

export function diffLeavesNonV1Pin(diff, changedFiles = "") {
  const files = parseNameStatus(changedFiles);
  const workflowPaths = new Set(
    files.filter((file) => WORKFLOW_FILE.test(file.path) || WORKFLOW_FILE.test(file.from || "")).map((file) => file.path),
  );
  if (workflowPaths.size === 0) {
    for (const raw of String(diff || "").split(/\r?\n/)) {
      const fileHeader = FILE_HEADER.exec(raw);
      if (fileHeader && WORKFLOW_FILE.test(normalizePath(fileHeader[2]))) workflowPaths.add(normalizePath(fileHeader[2]));
    }
  }
  if (workflowPaths.size === 0) return false;
  for (const path of workflowPaths) {
    const text = newFileLines(diff, path).join("\n");
    if (NON_V1_PIN.test(text)) return true;
  }
  return false;
}

export function isPinFollowUp(text) {
  return PIN_FOLLOWUP.test(String(text || ""));
}

export function filterFollowUps(followUps, { diff = "", changedFiles = "" } = {}) {
  const items = Array.isArray(followUps) ? followUps : [];
  if (diffLeavesNonV1Pin(diff, changedFiles)) return items;
  return items.filter((item) => !isPinFollowUp(item));
}

export { NON_V1_PIN, PIN_FOLLOWUP, JS_FILE };
