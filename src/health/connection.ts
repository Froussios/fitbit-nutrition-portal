/**
 * Whether the app can talk to Google Health right now (DR-18: there is no offline queue,
 * so the UI has to say when logging will not work).
 *
 * - `offline`: the browser says it has no network. Reliable, so the UI blocks writes.
 * - `unreachable`: the browser thinks it is online, but the last request got no answer.
 *   This can be a blip, so writes stay possible: trying is also how the app finds out it is back.
 */
export type ConnectionState = "online" | "offline" | "unreachable";

/** The parts of `window` the monitor uses; a fake in tests. */
export interface ConnectionEnv {
  readonly navigator: { readonly onLine: boolean };
  addEventListener(type: "online" | "offline", listener: () => void): void;
}

export class ConnectionMonitor {
  private browserOffline: boolean;
  private unanswered = false;

  constructor(
    env: ConnectionEnv,
    private readonly onChange: (state: ConnectionState, previous: ConnectionState) => void,
  ) {
    this.browserOffline = !env.navigator.onLine;
    env.addEventListener("offline", () => this.update(() => (this.browserOffline = true)));
    env.addEventListener("online", () =>
      this.update(() => {
        this.browserOffline = false;
        this.unanswered = false;
      }),
    );
  }

  get state(): ConnectionState {
    if (this.browserOffline) return "offline";
    return this.unanswered ? "unreachable" : "online";
  }

  /** Records whether a request got an answer. Any HTTP response counts, even an error. */
  reportRequest(answered: boolean): void {
    this.update(() => (this.unanswered = !answered));
  }

  private update(change: () => void): void {
    const previous = this.state;
    change();
    if (this.state !== previous) this.onChange(this.state, previous);
  }
}

/** The banner for each state that stops logging; undefined when all is well. */
export function connectionBanner(state: ConnectionState): string | undefined {
  switch (state) {
    case "online":
      return undefined;
    case "offline":
      return "You are offline. Logging and deleting will not work until your connection is back. Nothing is saved on this device.";
    case "unreachable":
      return "Google Health is not answering, so logging and deleting may not work right now. Nothing is saved on this device.";
  }
}

/**
 * A write that failed this way may still have reached Google (only the answer may have been lost),
 * and logging again creates a second entry, so the user has to check rather than just retry.
 */
export const LOG_NOT_CONFIRMED =
  "Google Health did not answer, so this entry may not have been saved. When the connection is back, check today's diary before logging it again.";

export const DIARY_NOT_LOADED = "Could not load today's diary because Google Health did not answer. Any entries shown may be out of date.";

export const CONNECT_FAILED = "Google Health did not answer. Check your connection, then press Retry.";

export function deleteFailed(name: string): string {
  return `Could not delete "${name}" because Google Health did not answer.`;
}

/** Like LOG_NOT_CONFIRMED: undoing again sends a new ID, so it could create a second entry. */
export function undoNotConfirmed(name: string): string {
  return `Google Health did not answer, so "${name}" may not be back in the diary. When the connection is back, check today's diary before undoing again.`;
}
