import assert from "node:assert/strict";
import test from "node:test";
import { createProgressReporter } from "../src/lib/progress.js";

test("progress reporter keeps multiple scan steps on one row", () => {
  const writes = [];
  const stream = {
    isTTY: true,
    write(value) {
      writes.push(value);
    },
  };
  const progress = createProgressReporter({ stream, minIntervalMs: 0, style: false });

  progress.updateStep("agents", "metadata", 1, 2, { rowLabel: "AGENTS", stepLabel: "metadata" });
  progress.updateStep("agents", "projects", 3, 4, { rowLabel: "AGENTS", stepLabel: "projects" });
  progress.finishRow("agents");
  progress.finish();

  const output = writes.join("");
  assert.match(output, /^Scanning\n/);
  assert.match(output, /\r  AGENTS: metadata 1\/2/);
  assert.match(output, /\r  AGENTS: metadata 1\/2, projects 3\/4/);
  assert.match(output, /\n\n$/);
});

test("progress reporter stays silent for json output", () => {
  const writes = [];
  const stream = {
    isTTY: true,
    write(value) {
      writes.push(value);
    },
  };
  const progress = createProgressReporter({ stream, json: true });

  progress.updateStep("rollouts", "metadata", 1, 2, { rowLabel: "Rollouts", stepLabel: "metadata" });
  progress.finishRow("rollouts");
  progress.finish();

  assert.deepEqual(writes, []);
});
