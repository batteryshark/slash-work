function taskLinksToEpic(task, epicId) {
  return task?.parentId === epicId
    || task?.dependsOn?.includes(epicId)
    || task?.blockedBy?.includes(epicId);
}

export function filterTasksByEpic(tasks, epicId) {
  if (!epicId) return [...tasks];
  const epic = tasks.find((task) => task.id === epicId && task.type === "epic");
  if (!epic) return [...tasks];

  const focusedIds = new Set([epic.id]);
  for (const task of tasks) {
    if (taskLinksToEpic(task, epic.id)) focusedIds.add(task.id);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (focusedIds.has(task.id) || !task.parentId || !focusedIds.has(task.parentId)) continue;
      focusedIds.add(task.id);
      changed = true;
    }
  }

  return tasks.filter((task) => focusedIds.has(task.id));
}
