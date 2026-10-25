import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock, sshPythonMock, connectionRef } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  sshPythonMock: vi.fn(),
  connectionRef: { value: { mode: "local", ssh: { host: "example.test" } } },
}));
vi.mock("child_process", () => ({
  default: { execFile: execFileMock },
  execFile: execFileMock,
}));
vi.mock("./installer", () => ({
  HERMES_HOME: "/isolated/hermes-home",
  HERMES_PYTHON: "/isolated/hermes-agent/venv/bin/python",
  hermesCliArgs: () => ["-m", "hermes_cli.main"],
  getEnhancedPath: () => "/bin",
}));
vi.mock("./config", () => ({
  getConnectionConfig: () => connectionRef.value,
  readDesktopConfig: () => ({}),
}));
vi.mock("./hermes", () => ({ isRemoteOnlyMode: () => false }));
vi.mock("./ssh-remote", () => ({
  sshRunKanban: vi.fn(),
  sshRunKanbanPython: sshPythonMock,
  sshListClaw3dHqTasks: vi.fn(),
}));

import { moveToTodoTask } from "./kanban";

describe("manual Triage to To-do on a local board", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    sshPythonMock.mockReset();
    connectionRef.value.mode = "local";
  });

  it("uses the installed agent's atomic transition without an LLM or shell interpolation", async () => {
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(null, '{"ok":true}', "");
    });
    const result = await moveToTodoTask("t_12345678", "default");
    expect(result).toEqual({ success: true });
    const [binary, args, options] = execFileMock.mock.calls[0];
    expect(binary).toBe("/isolated/hermes-agent/venv/bin/python");
    expect(args[0]).toBe("-c");
    expect(args[1]).toContain("specify_triage_task");
    expect(args).toContain("t_12345678");
    expect(args[1]).not.toContain("t_12345678");
    expect(options.cwd).toBe("/isolated/hermes-home/hermes-agent");
  });

  it("reports a rejected transition instead of showing false success", async () => {
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(null, '{"ok":false}', "");
    });
    expect(await moveToTodoTask("t_other", "default")).toMatchObject({
      success: false,
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("executes the same atomic transition on the SSH host, never against the local board", async () => {
    connectionRef.value.mode = "ssh";
    sshPythonMock.mockResolvedValue({ success: true, data: { ok: true } });
    expect(await moveToTodoTask("t_remote", "default")).toEqual({
      success: true,
    });
    expect(sshPythonMock).toHaveBeenCalledWith(
      connectionRef.value.ssh,
      expect.stringContaining("specify_triage_task"),
      ["t_remote"],
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
