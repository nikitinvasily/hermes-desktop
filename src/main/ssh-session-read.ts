import type { ConnectionConfig } from "./config";

export async function markSshSessionRead(
  transport: ConnectionConfig["sshChatTransport"],
  dashboardOperation: () => Promise<boolean>,
  legacyOperation: () => Promise<void>,
): Promise<boolean> {
  if (transport === "legacy") {
    await legacyOperation();
    return true;
  }
  // Dashboard refusals (including revision fences) must never trigger an
  // unfenced SQLite write. Only an explicitly selected legacy transport may
  // use that writer; dashboard setup failures also propagate unchanged.
  return dashboardOperation();
}
