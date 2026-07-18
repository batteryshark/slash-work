import assert from "node:assert/strict";
import test from "node:test";

import { filterTasksByEpic } from "../lib/task-focus.mjs";

function task(id, type = "task", links = {}) {
  return { id, type, parentId: null, dependsOn: [], blockedBy: [], ...links };
}

test("focuses the board on an epic, nested children, and direct epic links", () => {
  const tasks = [
    task("W-0001", "epic"),
    task("W-0002", "feature", { parentId: "W-0001" }),
    task("W-0003", "research", { parentId: "W-0002" }),
    task("W-0004", "task", { dependsOn: ["W-0001"] }),
    task("W-0005", "bug", { blockedBy: ["W-0001"] }),
    task("W-0006", "task"),
    task("W-0007", "epic", { dependsOn: ["W-0006"] }),
  ];

  assert.deepEqual(
    filterTasksByEpic(tasks, "W-0001").map((item) => item.id),
    ["W-0001", "W-0002", "W-0003", "W-0004", "W-0005"],
  );
  assert.deepEqual(filterTasksByEpic(tasks, "").map((item) => item.id), tasks.map((item) => item.id));
  assert.deepEqual(filterTasksByEpic(tasks, "W-9999").map((item) => item.id), tasks.map((item) => item.id));
});
