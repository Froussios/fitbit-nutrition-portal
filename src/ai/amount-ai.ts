import { AMOUNT_INSTRUCTIONS, amountPrompt, amountSchema, checkAnswer } from "../core/amount-answer";
import type { Measurable } from "../core/units";
import { describeError, logger } from "../debug/log";

const log = logger("ai");

const STORAGE_KEY = "foodDiary.aiInput";
/** The model can take a while to wake up, and an amount nobody can see being read is not worth waiting longer for. */
const ANSWER_TIMEOUT_MS = 15_000;

/** The parts of the browser's Prompt API this app uses. */
type Availability = "unavailable" | "downloadable" | "downloading" | "available";

interface ModelSession {
  clone(options?: { signal?: AbortSignal }): Promise<ModelSession>;
  prompt(text: string, options?: { responseConstraint?: unknown; signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

export interface LanguageModelApi {
  availability(options: unknown): Promise<Availability>;
  create(options: unknown): Promise<ModelSession>;
}

const ENGLISH = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

/**
 * - `unsupported`: this browser or computer cannot run a model.
 * - `off`: the user has not asked for it. The model is never used, even if it is installed.
 * - `missing`: asked for, but the model has gone. Downloading needs a click, so the user has to tick the box again.
 * - `downloading`: `progress` says how far, from 0 to 1.
 * - `ready`: on, and will be used.
 * - `failed`: the last attempt to start the model failed.
 */
export type AiState =
  | { readonly kind: "unsupported" | "off" | "missing" | "ready" | "failed" }
  | { readonly kind: "downloading"; readonly progress: number };

export interface Interpretation {
  readonly quantity: number;
  /** No `unit` means the text names none. */
  readonly unit?: string;
}

export interface AmountInterpreter {
  isOn(): boolean;
  /** Resolves undefined when there is no usable answer: refused, timed out or cancelled. Never rejects. */
  interpret(text: string, food: Measurable, signal: AbortSignal): Promise<Interpretation | undefined>;
}

export interface AmountAi extends AmountInterpreter {
  /** Finds out what this browser can do. */
  start(): Promise<void>;
  getState(): AiState;
  /** Must run directly from the user's click, because starting a download needs one. */
  turnOn(): void;
  turnOff(): void;
  onChange(listener: () => void): void;
}

function readStored(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function createAmountAi(api: LanguageModelApi | undefined, storage: Pick<Storage, "getItem" | "setItem"> | undefined): AmountAi {
  let state: AiState = { kind: api ? "off" : "unsupported" };
  let session: Promise<ModelSession> | undefined;
  /** Ends a download or start-up that the user has since turned off. */
  let starting: AbortController | undefined;
  const listeners: (() => void)[] = [];

  const setState = (next: AiState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const store = (on: boolean) => {
    try {
      storage?.setItem(STORAGE_KEY, on ? "on" : "off");
    } catch {
      // Storage blocked: the choice lasts until the page is reloaded.
    }
  };

  const openSession = (): Promise<ModelSession> => {
    const controller = (starting = new AbortController());
    const opening = api!.create({
      ...ENGLISH,
      initialPrompts: AMOUNT_INSTRUCTIONS,
      signal: controller.signal,
      monitor(monitor: EventTarget) {
        monitor.addEventListener("downloadprogress", (event) => {
          if (controller === starting && state.kind === "downloading") setState({ kind: "downloading", progress: (event as Event & { loaded: number }).loaded });
        });
      },
    });
    session = opening;
    // A failed start must not be remembered, or every later reading would fail the same way.
    opening.catch(() => {
      if (session === opening) session = undefined;
    });
    return opening;
  };

  const turnOn = () => {
    if (!api) return;
    store(true);
    setState({ kind: "downloading", progress: 0 });
    const opening = openSession();
    const mine = starting;
    opening.then(
      () => {
        if (starting === mine) setState({ kind: "ready" });
      },
      (error: unknown) => {
        if (starting !== mine) return; // Turned off in the meantime, which aborts the start.
        log.warn("The on-device model could not start", describeError(error));
        store(false);
        setState({ kind: "failed" });
      },
    );
  };

  return {
    async start() {
      if (!api) return;
      let availability: Availability;
      try {
        availability = await api.availability(ENGLISH);
      } catch (error) {
        log.warn("Could not ask whether the on-device model is available", describeError(error));
        setState({ kind: "unsupported" });
        return;
      }
      log.info("On-device model", { availability });
      if (state.kind !== "off") return; // The user got there first.
      if (availability === "unavailable") setState({ kind: "unsupported" });
      else if (readStored(storage)) setState({ kind: availability === "available" ? "ready" : "missing" });
    },
    getState: () => state,
    turnOn,
    turnOff() {
      store(false);
      starting?.abort();
      starting = undefined;
      const closing = session;
      session = undefined;
      closing?.then(
        (s) => s.destroy(),
        () => {},
      );
      setState({ kind: "off" });
    },
    onChange(listener) {
      listeners.push(listener);
    },
    isOn: () => state.kind === "ready",
    async interpret(text, food, signal) {
      if (state.kind !== "ready" || signal.aborted) return undefined;
      const prompt = amountPrompt(text, food);
      const limited = AbortSignal.any([signal, AbortSignal.timeout(ANSWER_TIMEOUT_MS)]);
      let reading: ModelSession | undefined;
      try {
        // A session remembers what it was asked, and one amount must have no bearing on the next.
        reading = await (await (session ?? openSession())).clone({ signal: limited });
        const reply = await reading.prompt(prompt, { responseConstraint: amountSchema(food), signal: limited });
        const check = checkAnswer(text, JSON.parse(reply), food);
        log.info("On-device model answered", { text, reply, check });
        return check.ok ? { quantity: check.quantity, ...(check.unit ? { unit: check.unit } : {}) } : undefined;
      } catch (error) {
        if (!signal.aborted) log.warn("The on-device model gave no usable answer", { text, error: describeError(error) });
        return undefined;
      } finally {
        reading?.destroy();
      }
    },
  };
}

const browserApi = (globalThis as { LanguageModel?: LanguageModelApi }).LanguageModel;
const browserStorage = typeof localStorage === "undefined" ? undefined : localStorage;

/** The one model this page uses. */
export const amountAi: AmountAi = createAmountAi(browserApi, browserStorage);
