import { colorText, formatInteger, supportsColor } from "./format.js";

export function createProgressReporter(options = {}) {
  const stream = options.stream || process.stderr;
  const enabled = options.enabled ?? (Boolean(stream?.isTTY) && !options.json);
  const minIntervalMs = Number(options.minIntervalMs ?? 100);
  const color = options.style === false ? false : supportsColor(stream);
  const title = options.title || "Scanning";
  const rows = new Map();
  let started = false;
  let activeRowId = null;
  let lastText = "";
  let lastWriteAt = 0;

  function ensureStarted() {
    if (!enabled || started) {
      return;
    }
    stream.write(`${colorText(title, ["bold", "cyan"], color)}\n`);
    started = true;
  }

  function ensureRow(rowId, rowLabel) {
    const key = String(rowId);
    if (!rows.has(key)) {
      rows.set(key, {
        label: rowLabel || key,
        steps: new Map(),
      });
    }
    const row = rows.get(key);
    if (rowLabel) {
      row.label = rowLabel;
    }
    return row;
  }

  function writeLine(text, force = false) {
    if (!enabled) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastWriteAt < minIntervalMs) {
      return;
    }
    const padded = lastText && lastText.length > text.length
      ? text.padEnd(lastText.length)
      : text;
    stream.write(`\r${padded}`);
    lastText = text;
    lastWriteAt = now;
  }

  function renderRow(rowId, force = false) {
    const row = rows.get(String(rowId));
    if (!row) {
      return;
    }
    const parts = [...row.steps.values()].map((step) => `${step.label} ${formatProgressValue(step.current, step.total)}`);
    writeLine(`  ${row.label}: ${parts.join(", ")}`, force);
  }

  function updateStep(rowId, stepId, current, total = null, stepOptions = {}) {
    if (!enabled) {
      return;
    }
    ensureStarted();
    if (activeRowId && activeRowId !== String(rowId)) {
      finishRow(activeRowId);
    }
    activeRowId = String(rowId);

    const row = ensureRow(rowId, stepOptions.rowLabel);
    row.steps.set(String(stepId), {
      label: stepOptions.stepLabel || String(stepId),
      current,
      total,
    });
    renderRow(rowId, Boolean(stepOptions.force));
  }

  function finishRow(rowId) {
    if (!enabled) {
      return;
    }
    const key = String(rowId);
    if (!rows.has(key)) {
      return;
    }
    renderRow(key, true);
    if (lastText) {
      stream.write("\n");
    }
    lastText = "";
    if (activeRowId === key) {
      activeRowId = null;
    }
  }

  function finish() {
    if (!enabled || !started) {
      return;
    }
    if (activeRowId) {
      finishRow(activeRowId);
    }
    stream.write("\n");
    lastText = "";
    activeRowId = null;
  }

  function clear() {
    if (!enabled || !lastText) {
      return;
    }
    stream.write(`\r${" ".repeat(lastText.length)}\r`);
    lastText = "";
  }

  return {
    enabled,
    updateStep,
    finishRow,
    finish,
    update,
    done,
    clear,
  };

  function update(label, current, total = null) {
    updateStep("progress", "progress", current, total, {
      rowLabel: label,
      stepLabel: "",
    });
  }

  function done(label, current = null, total = null) {
    update(label, current, total);
    finishRow("progress");
  }
}

function formatProgressValue(current, total) {
  const currentText = Number.isFinite(current) ? formatInteger(current) : "";
  if (Number.isFinite(total)) {
    return `${currentText}/${formatInteger(total)}`;
  }
  return currentText;
}
