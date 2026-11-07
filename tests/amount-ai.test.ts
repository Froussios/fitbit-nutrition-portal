import { describe, expect, it, vi } from "vitest";
import { createAmountAi, type LanguageModelApi } from "../src/ai/amount-ai";
import type { Measurable } from "../src/core/units";

const food = { basis: "g", portions: [{ name: "1 cup", amount: 125, unit: "g" }], name: "Sugar" } as Measurable & { name: string };
const REPLY = '{"quantity":2,"quantityText":"2","unit":"1 cup","unitText":"cpus"}';

function fakeStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), items };
}

function fakeApi(availability = "available", reply: string | (() => Promise<string>) = REPLY) {
  const prompt = vi.fn((_text: string, _options?: { responseConstraint?: unknown; signal?: AbortSignal }) => (typeof reply === "string" ? Promise.resolve(reply) : reply()));
  const destroy = vi.fn();
  const clone = vi.fn(async () => ({ clone, prompt, destroy }));
  const baseDestroy = vi.fn();
  const monitors: EventTarget[] = [];
  const create = vi.fn(async (options: { monitor?: (m: EventTarget) => void }) => {
    const monitor = new EventTarget();
    monitors.push(monitor);
    options.monitor?.(monitor);
    return { clone, prompt, destroy: baseDestroy };
  });
  const api = { availability: vi.fn(async () => availability), create } as unknown as LanguageModelApi;
  return { api, prompt, destroy, clone, create, baseDestroy, monitors };
}

const signal = () => new AbortController().signal;
const settled = () => new Promise((r) => setTimeout(r, 0));

describe("the setting", () => {
  it("is unavailable with no Prompt API", async () => {
    const ai = createAmountAi(undefined, fakeStorage());
    await ai.start();
    expect(ai.getState().kind).toBe("unsupported");
    expect(ai.isOn()).toBe(false);
  });

  it("is unavailable when the browser says the model cannot run", async () => {
    const ai = createAmountAi(fakeApi("unavailable").api, fakeStorage());
    await ai.start();
    expect(ai.getState().kind).toBe("unsupported");
  });

  it("is off by default, and uses nothing even with the model installed", async () => {
    const { api, create } = fakeApi("available");
    const ai = createAmountAi(api, fakeStorage());
    await ai.start();
    expect(ai.getState().kind).toBe("off");
    expect(await ai.interpret("2 cpus", food, signal())).toBe("no-answer");
    expect(create).not.toHaveBeenCalled();
  });

  it("downloads only when ticked, showing progress", async () => {
    const { api, create, monitors } = fakeApi("downloadable");
    const storage = fakeStorage();
    const ai = createAmountAi(api, storage);
    await ai.start();
    expect(create).not.toHaveBeenCalled();

    let resolved = false;
    ai.onChange(() => (resolved = ai.getState().kind === "ready"));
    ai.turnOn();
    expect(create).toHaveBeenCalledTimes(1); // In the click itself, which a download needs.
    expect(ai.getState()).toEqual({ kind: "downloading", progress: 0 });
    monitors[0]!.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded: 0.5 }));
    expect(ai.getState()).toEqual({ kind: "downloading", progress: 0.5 });
    await settled();
    expect(resolved).toBe(true);
    expect(storage.items.get("foodDiary.aiInput")).toBe("on");
  });

  it("remembers being on, across page loads", async () => {
    const ai = createAmountAi(fakeApi("available").api, fakeStorage({ "foodDiary.aiInput": "on" }));
    await ai.start();
    expect(ai.isOn()).toBe(true);
  });

  it("asks for a click when a stored choice finds the model gone, and never downloads by itself", async () => {
    const { api, create } = fakeApi("downloadable");
    const ai = createAmountAi(api, fakeStorage({ "foodDiary.aiInput": "on" }));
    await ai.start();
    expect(ai.getState().kind).toBe("missing");
    expect(ai.isOn()).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("says when the model cannot start, and forgets the choice", async () => {
    const { api, create } = fakeApi("downloadable");
    create.mockRejectedValueOnce(new Error("no disk"));
    const storage = fakeStorage();
    const ai = createAmountAi(api, storage);
    ai.turnOn();
    await settled();
    expect(ai.getState().kind).toBe("failed");
    expect(storage.items.get("foodDiary.aiInput")).toBe("off");
  });

  it("stops using the model when unticked", async () => {
    const { api, baseDestroy } = fakeApi("available");
    const storage = fakeStorage();
    const ai = createAmountAi(api, storage);
    ai.turnOn();
    await settled();
    ai.turnOff();
    await settled();
    expect(ai.getState().kind).toBe("off");
    expect(baseDestroy).toHaveBeenCalled();
    expect(await ai.interpret("2 cpus", food, signal())).toBe("no-answer");
    expect(storage.items.get("foodDiary.aiInput")).toBe("off");
  });

  it("ignores a start that finishes after being unticked", async () => {
    const { api, create } = fakeApi("downloadable");
    let finish: (v: unknown) => void = () => {};
    create.mockImplementationOnce(() => new Promise((r) => (finish = r)) as never);
    const ai = createAmountAi(api, fakeStorage());
    ai.turnOn();
    ai.turnOff();
    finish({ clone: vi.fn(), prompt: vi.fn(), destroy: vi.fn() });
    await settled();
    expect(ai.getState().kind).toBe("off");
  });
});

describe("reading an amount", () => {
  const on = async (api: LanguageModelApi) => {
    const ai = createAmountAi(api, fakeStorage({ "foodDiary.aiInput": "on" }));
    await ai.start();
    return ai;
  };

  it("returns a checked answer", async () => {
    const ai = await on(fakeApi().api);
    expect(await ai.interpret("2 cpus", food, signal())).toEqual({ quantity: 2, unit: "portion:1 cup" });
  });

  it("never tells the model what the food is", async () => {
    const { api, prompt, create } = fakeApi();
    const ai = await on(api);
    await ai.interpret("2 cpus", food, signal());
    expect(JSON.stringify([prompt.mock.calls.map(([text]) => text), prompt.mock.calls[0]?.[1]?.responseConstraint, create.mock.calls])).not.toMatch(/sugar/i);
  });

  it("asks each question in a fresh copy of the session, so that answers cannot affect each other", async () => {
    const { api, clone, destroy, create } = fakeApi();
    const ai = await on(api);
    await ai.interpret("2 cpus", food, signal());
    await ai.interpret("2 cpus", food, signal());
    expect(create).toHaveBeenCalledTimes(1);
    expect(clone).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("drops an answer that fails the checks", async () => {
    const ai = await on(fakeApi("available", '{"quantity":1,"quantityText":"1","unit":"1 cup","unitText":"scoop"}').api);
    expect(await ai.interpret("1 scoop", food, signal())).toBe("refused");
  });

  it("drops a reply that is not JSON", async () => {
    const ai = await on(fakeApi("available", "I think 2 cups").api);
    expect(await ai.interpret("2 cpus", food, signal())).toBe("no-answer");
  });

  it("does not reject when the model fails, and tries again next time", async () => {
    const { api, create } = fakeApi();
    create.mockRejectedValueOnce(new Error("gone"));
    const ai = await on(api);
    expect(await ai.interpret("2 cpus", food, signal())).toBe("no-answer");
    expect(await ai.interpret("2 cpus", food, signal())).toEqual({ quantity: 2, unit: "portion:1 cup" });
  });

  it("passes on a cancellation", async () => {
    const { api, prompt } = fakeApi("available", () => new Promise(() => {}));
    const ai = await on(api);
    const controller = new AbortController();
    void ai.interpret("2 cpus", food, controller.signal);
    await settled();
    await settled();
    controller.abort();
    expect(prompt.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("gives up on a model that never finishes starting", async () => {
    const limit = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(limit.signal);
    try {
      const { api, create, clone } = fakeApi();
      create.mockImplementationOnce(() => new Promise(() => {}) as never);
      const ai = await on(api);
      const reading = ai.interpret("2 cpus", food, signal());
      await settled();
      limit.abort();
      expect(await reading).toBe("no-answer");
      expect(clone).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it("gives up on its own when the model takes too long", async () => {
    const limit = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(limit.signal);
    try {
      const { api, prompt } = fakeApi("available", () => new Promise(() => {}));
      const ai = await on(api);
      void ai.interpret("2 cpus", food, signal());
      await settled();
      await settled();
      expect(timeout).toHaveBeenCalledWith(15_000);
      expect(prompt.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      limit.abort();
      expect(prompt.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });
});
