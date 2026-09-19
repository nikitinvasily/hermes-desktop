import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionChangeReload } from "./useConnectionChangeReload";

// The hook is behaviorally identical to the inline Schedules pattern
// (issue #86): refetch when the connection's transport-relevant signature
// (connectionId|mode|remoteUrl) actually changes, never on re-activation of
// the same connection. The baseline is seeded with the active connection at
// mount, so an event for the CURRENT connection is a no-op.

interface Conn {
  connectionId: string;
  mode: "local" | "remote" | "ssh";
  remoteUrl: string;
}

let emitConnectionChanged: ((conn: Conn) => void) | null = null;
let currentConn: Conn;

function Harness({ onChange }: { onChange: () => void }): React.JSX.Element {
  useConnectionChangeReload(onChange);
  return <output data-testid="hook">mounted</output>;
}

function conn(
  connectionId: string,
  mode: Conn["mode"],
  remoteUrl: string,
): Conn {
  return { connectionId, mode, remoteUrl };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useConnectionChangeReload", () => {
  const onChange = vi.fn();

  beforeEach(() => {
    onChange.mockClear();
    emitConnectionChanged = null;
    currentConn = conn("local-main", "local", "");
    window.hermesAPI = {
      ...window.hermesAPI,
      onConnectionConfigChanged: ((
        callback: (c: Conn) => void,
      ): (() => void) => {
        emitConnectionChanged = callback;
        return () => {
          emitConnectionChanged = null;
        };
      }) as unknown as typeof window.hermesAPI.onConnectionConfigChanged,
      getConnectionConfig: (async () =>
        currentConn) as unknown as typeof window.hermesAPI.getConnectionConfig,
    } as typeof window.hermesAPI;
  });

  afterEach(() => {
    cleanup();
  });

  it("calls onChange when the connection signature changes", async () => {
    render(<Harness onChange={onChange} />);
    await flush();
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      emitConnectionChanged?.(conn("remote-a", "remote", "http://a"));
    });
    expect(onChange).toHaveBeenCalledTimes(1);

    await act(async () => {
      emitConnectionChanged?.(conn("local-main", "local", ""));
    });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("does not refetch when the same connection is re-activated", async () => {
    render(<Harness onChange={onChange} />);
    await flush();

    await act(async () => {
      emitConnectionChanged?.(conn("local-main", "local", ""));
    });
    // Same signature as the seeded baseline: no refetch.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("refetches when only the mode changes (same id, same url)", async () => {
    render(<Harness onChange={onChange} />);
    await flush();

    await act(async () => {
      emitConnectionChanged?.(conn("local-main", "ssh", ""));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
