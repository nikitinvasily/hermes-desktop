import { describe, expect, it } from "vitest";
// @lat: [[context-folder#Restore and save in the chat#Save dedupe keys on the session id too]]
import { shouldPersistSessionFolder } from "./sessionFolderPersist";

describe("shouldPersistSessionFolder", () => {
  it("skips an exact (sessionId, folder) repeat", (): void => {
    expect(
      shouldPersistSessionFolder(
        { sessionId: "s1", folder: "/proj" },
        "s1",
        "/proj",
      ),
    ).toBe(false);
  });

  it("re-persists the same folder for a RECREATED session id (issue #162)", (): void => {
    // WS drop mid-send swaps hermesSessionId A → B with the folder unchanged:
    // the live session B must still get its binding.
    expect(
      shouldPersistSessionFolder(
        { sessionId: "20261005_124757_0aa864", folder: "/proj" },
        "20261005_124757_c490dc",
        "/proj",
      ),
    ).toBe(true);
  });

  it("persists a folder change for the same session", (): void => {
    expect(
      shouldPersistSessionFolder(
        { sessionId: "s1", folder: "/old" },
        "s1",
        "/new",
      ),
    ).toBe(true);
  });

  it("persists a deliberate unlink (null folder) only once per session", (): void => {
    expect(
      shouldPersistSessionFolder(
        { sessionId: "s1", folder: "/old" },
        "s1",
        null,
      ),
    ).toBe(true);
    expect(
      shouldPersistSessionFolder({ sessionId: "s1", folder: null }, "s1", null),
    ).toBe(false);
  });

  it("never persists without a session id", (): void => {
    expect(shouldPersistSessionFolder(null, null, "/proj")).toBe(false);
    expect(
      shouldPersistSessionFolder(
        { sessionId: "s1", folder: "/proj" },
        null,
        "/proj",
      ),
    ).toBe(false);
  });
});
