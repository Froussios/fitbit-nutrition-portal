import { describe, expect, it } from "vitest";
import { ConnectionMonitor, actionRefused, connectionBanner, deleteFailed, undoNotConfirmed, type ConnectionEnv, type ConnectionState } from "../src/health/connection";

function setup(onLine = true) {
  const listeners: Partial<Record<"online" | "offline", () => void>> = {};
  const env: ConnectionEnv = {
    navigator: { onLine },
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
  };
  const changes: [ConnectionState, ConnectionState][] = [];
  const monitor = new ConnectionMonitor(env, (state, previous) => changes.push([state, previous]));
  return { monitor, changes, fire: (type: "online" | "offline") => listeners[type]!() };
}

describe("ConnectionMonitor", () => {
  it("starts from what the browser reports", () => {
    expect(setup(true).monitor.state).toBe("online");
    expect(setup(false).monitor.state).toBe("offline");
  });

  it("follows the browser's offline and online events", () => {
    const { monitor, changes, fire } = setup();
    fire("offline");
    expect(monitor.state).toBe("offline");
    fire("online");
    expect(monitor.state).toBe("online");
    expect(changes).toEqual([
      ["offline", "online"],
      ["online", "offline"],
    ]);
  });

  it("becomes unreachable when a request gets no answer, and recovers on the next answer", () => {
    const { monitor, changes } = setup();
    monitor.reportRequest(false);
    expect(monitor.state).toBe("unreachable");
    monitor.reportRequest(true);
    expect(monitor.state).toBe("online");
    expect(changes).toEqual([
      ["unreachable", "online"],
      ["online", "unreachable"],
    ]);
  });

  it("only reports actual changes", () => {
    const { monitor, changes } = setup();
    monitor.reportRequest(true);
    monitor.reportRequest(false);
    monitor.reportRequest(false);
    expect(changes).toEqual([["unreachable", "online"]]);
  });

  it("stays offline while the browser is offline, whatever requests report", () => {
    const { monitor, changes, fire } = setup();
    fire("offline");
    monitor.reportRequest(false);
    expect(monitor.state).toBe("offline");
    monitor.reportRequest(true);
    expect(monitor.state).toBe("offline");
    expect(changes).toEqual([["offline", "online"]]);
  });

  it("forgets unanswered requests when the browser comes back online", () => {
    const { monitor, fire } = setup();
    monitor.reportRequest(false);
    fire("offline");
    fire("online");
    expect(monitor.state).toBe("online");
  });
});

describe("connectionBanner", () => {
  it("says logging will not work when offline, and may not work when requests go unanswered", () => {
    expect(connectionBanner("online")).toBeUndefined();
    expect(connectionBanner("offline")).toMatch(/offline.*Logging.*will not work/);
    expect(connectionBanner("unreachable")).toMatch(/not answering.*logging.*may not work/);
  });
});

describe("deleteFailed", () => {
  it("names the entry", () => {
    expect(deleteFailed("Toast")).toBe('Could not delete "Toast" because Google Health did not answer. If it is still listed, it was not deleted.');
  });
});

describe("actionRefused", () => {
  it("names the action, the entry and the reason", () => {
    expect(actionRefused("delete", "Toast", "Not allowed")).toBe('Could not delete "Toast": Not allowed');
    expect(actionRefused("undo deleting", "Toast", "Not allowed")).toBe('Could not undo deleting "Toast": Not allowed');
  });
});

describe("undoNotConfirmed", () => {
  it("names the entry and warns against a second copy", () => {
    expect(undoNotConfirmed("Toast")).toContain('"Toast" may not be back');
    expect(undoNotConfirmed("Toast")).toContain("check today's diary before undoing again");
  });
});
