import assert from "node:assert/strict";
import { test } from "node:test";
import { toolArgSummary } from "../src/tool-args.js";

test("new tool summaries use the real session argument fields", () => {
  assert.equal(toolArgSummary("powershell", { command: "Get-ChildItem", timeout: 10 }), "Get-ChildItem");
  assert.equal(toolArgSummary("codemode", { code: "const x = 1;\n\n  text(x);" }), "const x = 1; text(x);");
  assert.equal(toolArgSummary("TaskCreate", { subject: "Add tests", description: "Details", activeForm: "Adding tests" }), "Add tests");
  assert.equal(toolArgSummary("TaskUpdate", { taskId: "1", status: "in_progress", activeForm: "Adding tests" }), "1 in_progress");
  assert.equal(toolArgSummary("TaskUpdate", { taskId: "1", subject: "New title" }), "1 New title");
  assert.equal(toolArgSummary("TaskList", {}), "");
  assert.equal(toolArgSummary("google_search", { query: "Pi tool rendering", thinking: true }), '"Pi tool rendering"');
  assert.equal(toolArgSummary("web_enable", {}), "");
});

test("new summaries tolerate missing fields and remain bounded", () => {
  for (const name of ["powershell", "codemode", "TaskCreate", "TaskUpdate", "TaskList", "google_search", "web_enable"]) {
    assert.equal(toolArgSummary(name, {}), "");
  }
  assert.equal(toolArgSummary("codemode", { code: "x".repeat(200) }).length, 120);
  assert.equal(toolArgSummary("TaskCreate", { subject: "x".repeat(200) }).length, 60);
  assert.equal(toolArgSummary("google_search", { query: "x".repeat(200) }).length, 52);
});

test("unknown tools retain the generic N args fallback", () => {
  assert.equal(toolArgSummary("future_tool", { one: 1, two: false }), "2 args");
  assert.equal(toolArgSummary("future_tool", {}), "");
});
