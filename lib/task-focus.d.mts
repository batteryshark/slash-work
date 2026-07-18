export type EpicFocusableTask = {
  id: string;
  type: string;
  parentId: string | null;
  dependsOn: string[];
  blockedBy: string[];
};

export function filterTasksByEpic<T extends EpicFocusableTask>(tasks: readonly T[], epicId: string | null): T[];
