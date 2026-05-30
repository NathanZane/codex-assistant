import crypto from "node:crypto";
import path from "node:path";

export const DEFAULT_INDENT = "  ";

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : stableText(value);
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

export function stableText(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, sortJsonKeys);
}

function sortJsonKeys(_key, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = value[key];
      return acc;
    }, {});
}

export function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function measure(value) {
  const text = stableText(value);
  return {
    chars: text.length,
    tokens: estimateTokens(text),
    sha256: text ? hashText(text) : null,
  };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatInteger(value) {
  if (!Number.isFinite(value)) {
    return "";
  }
  return Math.round(value).toLocaleString("en-US");
}

export function formatDate(value) {
  if (!value) {
    return "";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function daysSince(value, now = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000);
}

export function shortPath(filePath, home = process.env.USERPROFILE || process.env.HOME || "") {
  if (!filePath) {
    return "";
  }
  if (typeof home !== "string") {
    home = process.env.USERPROFILE || process.env.HOME || "";
  }
  const normalized = filePath.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/");
  if (normalizedHome && normalized.toLowerCase().startsWith(normalizedHome.toLowerCase())) {
    return `~${normalized.slice(normalizedHome.length)}`;
  }
  return normalized;
}

export function relativeOrShort(filePath, root) {
  if (!filePath) {
    return "";
  }
  const relative = root ? path.relative(root, filePath) : filePath;
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  return shortPath(filePath);
}

export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

export function printTable(rows, columns, options = {}) {
  const indent = options.indent === false ? "" : options.indent ?? DEFAULT_INDENT;
  const color = options.style === false ? false : supportsColor();
  const lines = formatTable(rows, columns);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const styles = index <= 1 ? ["dim"] : [];
    console.log(`${indent}${colorText(line, styles, color)}`);
  }
}

export function formatTable(rows, columns) {
  if (!rows.length) {
    return ["(none)"];
  }

  const rendered = rows.map((row) =>
    columns.map((column) => {
      const raw = column.format ? column.format(row[column.key], row) : row[column.key];
      return raw == null ? "" : String(raw);
    }),
  );

  const widths = columns.map((column, index) => {
    const headerLength = column.label.length;
    const maxCellLength = Math.max(...rendered.map((row) => row[index].length), 0);
    return Math.min(Math.max(headerLength, maxCellLength), column.maxWidth || 64);
  });

  const header = columns.map((column, index) => padCell(column.label, widths[index], column.align)).join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  const lines = [header, divider];
  for (const row of rendered) {
    lines.push(row.map((cell, index) => padCell(truncate(cell, widths[index]), widths[index], columns[index].align)).join("  "));
  }
  return lines;
}

export function supportsColor(stream = process.stdout) {
  return Boolean(stream?.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}

export function printSectionTitle(value, options = {}) {
  const indent = options.indent || "";
  const color = options.style === false ? false : supportsColor();
  console.log(`${indent}${colorText(value, ["bold", "cyan"], color)}`);
}

export function printIndentedLine(value = "", options = {}) {
  if (!value) {
    console.log("");
    return;
  }
  const indent = options.indent === false ? "" : options.indent ?? DEFAULT_INDENT;
  const color = options.style === false ? false : supportsColor();
  console.log(`${indent}${colorText(value, options.styles || [], color)}`);
}

export function colorText(value, styles = [], enabled = supportsColor()) {
  const text = String(value);
  if (!enabled || !styles.length) {
    return text;
  }
  const codes = {
    bold: "1",
    dim: "2",
    green: "32",
    yellow: "33",
    cyan: "36",
  };
  const prefix = styles.map((style) => codes[style]).filter(Boolean).map((code) => `\x1b[${code}m`).join("");
  return prefix ? `${prefix}${text}\x1b[0m` : text;
}

function padCell(value, width, align = "left") {
  if (align === "right") {
    return value.padStart(width);
  }
  return value.padEnd(width);
}

function truncate(value, width) {
  if (value.length <= width) {
    return value;
  }
  const suffix = "...";
  if (width <= suffix.length) {
    return suffix.slice(0, Math.max(0, width));
  }
  return `${value.slice(0, Math.max(0, width - suffix.length))}${suffix}`;
}
