import { describe, expect, it } from "vitest";
import { connectionTargetSignature } from "./connection-target";

const ssh = {
  host: "old.example",
  port: 22,
  username: "agent",
  keyPath: "/key",
  remotePort: 8642,
  localPort: 18642,
  dockerContainerName: "",
};

describe("connectionTargetSignature", () => {
  it("changes when the same SSH connection points to a different agent", () => {
    const original = {
      connectionId: "connection-one",
      mode: "ssh",
      remoteUrl: "",
      ssh,
    };
    expect(
      connectionTargetSignature({
        ...original,
        ssh: { ...ssh, host: "new.example" },
      }),
    ).not.toBe(connectionTargetSignature(original));
    expect(
      connectionTargetSignature({ ...original, ssh: { ...ssh, port: 2222 } }),
    ).not.toBe(connectionTargetSignature(original));
    expect(
      connectionTargetSignature({
        ...original,
        ssh: { ...ssh, dockerContainerName: "new" },
      }),
    ).not.toBe(connectionTargetSignature(original));
  });

  it("changes for a new remote URL and stays stable for a name-only edit", () => {
    const remote = {
      connectionId: "connection-one",
      mode: "remote",
      remoteUrl: "https://one",
      name: "Before",
    };
    expect(
      connectionTargetSignature({ ...remote, remoteUrl: "https://two" }),
    ).not.toBe(connectionTargetSignature(remote));
    const renamed = { ...remote, name: "After" };
    expect(connectionTargetSignature(renamed)).toBe(
      connectionTargetSignature(remote),
    );
  });
});
