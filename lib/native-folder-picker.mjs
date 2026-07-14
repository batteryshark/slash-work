import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { WorkspaceError } from "./local-workspace.mjs";

const execFile = promisify(execFileCallback);

function pickerCommand(platform) {
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", 'POSIX path of (choose folder with prompt "Choose a Work workspace root")'],
    };
  }
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Choose a Work workspace root'; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
      ],
    };
  }
  return {
    command: "zenity",
    args: ["--file-selection", "--directory", "--title=Choose a Work workspace root"],
  };
}

function wasCancelled(error) {
  const output = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}`.toLowerCase();
  return error?.code === 1 && (
    output.includes("user canceled") ||
    output.includes("user cancelled") ||
    output.trim() === ""
  );
}

export async function chooseWorkspaceDirectory({
  platform = process.platform,
  run = execFile,
} = {}) {
  const { command, args } = pickerCommand(platform);
  try {
    const { stdout } = await run(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 });
    const selected = String(stdout ?? "").trim();
    return selected || null;
  } catch (error) {
    if (wasCancelled(error)) return null;
    if (error?.code === "ENOENT") {
      throw new WorkspaceError(
        platform === "linux"
          ? "The native folder picker is unavailable. Install zenity or use `work register /path/to/root`."
          : "The native folder picker is unavailable on this computer.",
        { code: "folder_picker_unavailable", status: 501 },
      );
    }
    throw new WorkspaceError("The native folder picker could not open.", {
      code: "folder_picker_failed",
      status: 500,
    });
  }
}
