import { describe, expect, it, vi } from "vitest";
import { ChatAgent, DiaryReadError, GAVE_UP, MAX_STEPS, MODEL_FAILED, TOO_LONG, type ChatEvent, type StepSession } from "../src/ai/chat-agent";
import { createChatTools } from "../src/ai/chat-tools";
import { entryOf, hostWith, oats, TODAY } from "./chat-fixtures";

const answer = (fields: Record<string, string>) => JSON.stringify({ text: "", day: "", from: "", to: "", query: "", food: "", entry: "", amount: "", meal: "", ...fields });

/** A model that gives these answers in turn, and records what it was asked. */
function scripted(...answers: (string | Error)[]) {
  const prompts: string[] = [];
  const session: StepSession = {
    prompt: vi.fn(async (text: string) => {
      prompts.push(text);
      const next = answers.shift();
      if (next === undefined) throw new Error("No more answers");
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  return { session, prompts };
}

function run(answers: (string | Error)[], host = hostWith({ [TODAY]: [entryOf(oats, 40, "g", `${TODAY}T08:05:00`, { mealType: "BREAKFAST" })] })) {
  const { session, prompts } = scripted(...answers);
  const agent = new ChatAgent(session, createChatTools(host));
  const events: ChatEvent[] = [];
  return { agent, events, prompts, onEvent: (e: ChatEvent) => events.push(e), signal: new AbortController().signal };
}

describe("ChatAgent", () => {
  it("runs actions until the model replies, telling it each result", async () => {
    const t = run([answer({ action: "read_day", day: "today" }), answer({ action: "reply", text: "You had oats: 160 kcal." })]);
    expect(await t.agent.send("What did I eat?", t.signal, t.onEvent)).toBe("done");
    expect(t.prompts[0]).toBe("User: What did I eat?");
    expect(t.prompts[1]).toMatch(/^Result of read_day:\nThursday, 19 Nov 2026 \(today\): 1 entry\nE1: Oats/);
    expect(t.events).toEqual([
      { kind: "activity", text: "Read the diary for today" },
      { kind: "say", text: "You had oats: 160 kcal." },
    ]);
  });

  it("tells the model what was wrong with an answer, and lets it try again", async () => {
    const t = run(["{oops", answer({ action: "read_day", day: "next week" }), answer({ action: "reply", text: "OK" })]);
    expect(await t.agent.send("Hi", t.signal, t.onEvent)).toBe("done");
    expect(t.prompts[1]).toBe("Error: The answer was not JSON. Answer with one action as JSON.");
    expect(t.prompts[2]).toMatch(/^Error from read_day: "next week" is not a day/);
  });

  it("pauses on a proposal until the user decides, then carries on", async () => {
    const t = run([answer({ action: "read_day", day: "today" }), answer({ action: "delete_entry", entry: "E1", text: "Deleting the oats." }), answer({ action: "reply", text: "Done." })]);
    expect(await t.agent.send("Delete my oats", t.signal, t.onEvent)).toBe("awaiting");
    expect(t.agent.pending?.kind).toBe("delete");
    expect(t.events.at(-1)).toMatchObject({ kind: "proposal", note: "Deleting the oats." });
    expect(() => t.agent.send("Another thing", t.signal, t.onEvent)).toThrow();
    expect(await t.agent.resume("The user accepted, and it was done: deleted Oats.", t.signal, t.onEvent)).toBe("done");
    expect(t.agent.pending).toBeUndefined();
    expect(t.prompts.at(-1)).toBe("The user accepted, and it was done: deleted Oats.");
  });

  it("gives up after a few actions without a reply", async () => {
    const t = run(Array.from({ length: MAX_STEPS + 1 }, () => answer({ action: "read_day", day: "today" })));
    expect(await t.agent.send("Loop", t.signal, t.onEvent)).toBe("failed");
    expect(t.prompts).toHaveLength(MAX_STEPS);
    expect(t.events.at(-1)).toEqual({ kind: "failed", text: GAVE_UP });
  });

  it("stops quietly when the user stops it", async () => {
    const controller = new AbortController();
    const t = run([]);
    (t.agent as unknown as { session: StepSession }).session.prompt = () => {
      controller.abort();
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    };
    expect(await t.agent.send("Hi", controller.signal, t.onEvent)).toBe("stopped");
    expect(t.events).toEqual([]);
  });

  it("says when the chat is too long for the model", async () => {
    const t = run([new DOMException("Too long", "QuotaExceededError")]);
    expect(await t.agent.send("Hi", t.signal, t.onEvent)).toBe("failed");
    expect(t.events).toEqual([{ kind: "failed", text: TOO_LONG }]);
  });

  it("says why the diary could not be read, and nothing more about other failures", async () => {
    const host = hostWith({});
    host.entriesOn = () => Promise.reject(new DiaryReadError("Google Health did not answer."));
    const t = run([answer({ action: "read_day", day: "today" })], host);
    await t.agent.send("Hi", t.signal, t.onEvent);
    expect(t.events).toEqual([{ kind: "failed", text: "Google Health did not answer." }]);

    const u = run([new Error("internal model error 0x42")]);
    await u.agent.send("Hi", u.signal, u.onEvent);
    expect(u.events).toEqual([{ kind: "failed", text: MODEL_FAILED }]);
  });

  it("constrains each answer to the handles handed out so far", async () => {
    const t = run([answer({ action: "read_day", day: "today" }), answer({ action: "reply", text: "OK" })]);
    await t.agent.send("Hi", t.signal, t.onEvent);
    const calls = (t.agent as unknown as { session: { prompt: ReturnType<typeof vi.fn> } }).session.prompt.mock.calls;
    const entryEnum = (call: unknown[]) => (call[1] as { responseConstraint: { properties: { entry: { enum: string[] } } } }).responseConstraint.properties.entry.enum;
    expect(entryEnum(calls[0]!)).toEqual([""]);
    expect(entryEnum(calls[1]!)).toEqual(["E1", ""]);
  });
});
