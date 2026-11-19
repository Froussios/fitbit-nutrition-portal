import { describe, expect, it } from "vitest";
import { parseStep, type ChatStep } from "../src/ai/chat-protocol";
import { createChatTools, describeDone, outcomeText, type Proposal, type ToolOutcome } from "../src/ai/chat-tools";
import { bread, entryOf, hostWith, oats, TODAY } from "./chat-fixtures";

const signal = new AbortController().signal;

function stepOf(fields: Partial<ChatStep> & { action: ChatStep["action"] }): ChatStep {
  const parsed = parseStep(JSON.stringify(fields));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.step;
}

function proposalOf(outcome: ToolOutcome): Proposal {
  if (outcome.kind !== "proposal") throw new Error(`Expected a proposal, got ${JSON.stringify(outcome)}`);
  return outcome.proposal;
}

const breakfast = () => entryOf(oats, 40, "g", `${TODAY}T08:05:00`, { mealType: "BREAKFAST" });

describe("chat tools: reading", () => {
  it("reads a day and hands out entry handles", async () => {
    const host = hostWith({ [TODAY]: [breakfast()] });
    const tools = createChatTools(host);
    const outcome = await tools.run(stepOf({ action: "read_day", day: "today" }), signal);
    expect(outcome).toMatchObject({ kind: "result", activity: "Read the diary for today" });
    expect(outcome.kind === "result" && outcome.text).toContain("E1: Oats, 40 g, breakfast");
    expect(tools.handles.entryHandles()).toEqual(["E1"]);
    expect((tools.schema() as { properties: { entry: { enum: string[] } } }).properties.entry.enum).toEqual(["E1", ""]);
  });

  it("refuses a day after today without reading anything", async () => {
    const host = hostWith({});
    const outcome = await createChatTools(host).run(stepOf({ action: "read_day", day: "2026-11-25" }), signal);
    expect(outcome.kind).toBe("error");
    expect(host.reads).toEqual([]);
  });

  it("reads totals for a range of days, one day at a time", async () => {
    const host = hostWith({ [TODAY]: [breakfast()] });
    const outcome = await createChatTools(host).run(stepOf({ action: "read_days", from: "2026-11-17", to: "today" }), signal);
    expect(host.reads).toEqual(["2026-11-17", "2026-11-18", TODAY]);
    expect(outcome.kind === "result" && outcome.text).toContain("Average over the 1 day with entries: 160 kcal");
  });

  it("refuses more than a fortnight at once", async () => {
    const outcome = await createChatTools(hostWith({})).run(stepOf({ action: "read_days", from: "2026-10-01", to: "today" }), signal);
    expect(outcome).toMatchObject({ kind: "error" });
  });

  it("searches foods and hands out food handles", async () => {
    const tools = createChatTools(hostWith({}));
    const outcome = await tools.run(stepOf({ action: "search_food", query: "bread" }), signal);
    expect(outcome.kind === "result" && outcome.text).toBe('F1: Bread, wholemeal, 250 kcal per 100 g, serving "slice (35 g)" (35 g), from FNDDS');
  });
});

describe("chat tools: logging", () => {
  async function searched() {
    const tools = createChatTools(hostWith({}));
    await tools.run(stepOf({ action: "search_food", query: "bread" }), signal);
    return tools;
  }

  it("proposes an entry read by the app's rules, with the nutrients it would log", async () => {
    const tools = await searched();
    const proposal = proposalOf(await tools.run(stepOf({ action: "log_food", food: "F1", amount: "2 slices", day: "today", meal: "breakfast" }), signal));
    expect(proposal.kind).toBe("log");
    if (proposal.kind !== "log") return;
    expect(proposal.draft).toMatchObject({ quantity: 2, unit: "portion:slice (35 g)", mealType: "BREAKFAST" });
    expect(proposal.preview).toMatchObject({ displayName: "Bread, wholemeal", amount: "70 g", mealType: "BREAKFAST" });
    expect(proposal.preview.profile.energyKcal).toBeCloseTo(175);
  });

  it("never decides the unit of a bare number (DR-25)", async () => {
    const tools = await searched();
    const outcome = await tools.run(stepOf({ action: "log_food", food: "F1", amount: "2", day: "today" }), signal);
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.text).toContain("Units for this food: g, kg, mg, oz, lb, slice (35 g)");
  });

  it("refuses a unit the food can't be measured in", async () => {
    const tools = await searched();
    const outcome = await tools.run(stepOf({ action: "log_food", food: "F1", amount: "1 cup" }), signal);
    expect(outcome.kind).toBe("error");
  });

  it("refuses a food it never handed out", async () => {
    const tools = createChatTools(hostWith({}));
    const outcome = await tools.run(stepOf({ action: "log_food", food: "F7", amount: "1 slice" }), signal);
    expect(outcome).toMatchObject({ kind: "error" });
  });

  it("logs on an earlier day, at the host's time for it", async () => {
    const tools = await searched();
    const proposal = proposalOf(await tools.run(stepOf({ action: "log_food", food: "F1", amount: "35 g", day: "yesterday" }), signal));
    expect(proposal.kind === "log" && proposal.draft.time).toEqual(new Date("2026-11-18T12:00:00"));
  });
});

describe("chat tools: changing and deleting", () => {
  async function read(...entries: ReturnType<typeof breakfast>[]) {
    const tools = createChatTools(hostWith({ [TODAY]: entries }, [oats, bread]));
    await tools.run(stepOf({ action: "read_day", day: "today" }), signal);
    return tools;
  }

  it("proposes a new amount, worked out from the food's record", async () => {
    const tools = await read(breakfast());
    const proposal = proposalOf(await tools.run(stepOf({ action: "change_entry", entry: "E1", amount: "1 cup" }), signal));
    expect(proposal.kind).toBe("edit");
    if (proposal.kind !== "edit") return;
    expect(proposal.edit).toMatchObject({ amount: { quantity: 1, unit: "portion:1 cup (90 g)" }, mealType: "BREAKFAST" });
    expect(proposal.preview.amount).toBe("90 g");
    expect(proposal.preview.profile.energyKcal).toBeCloseTo(360);
  });

  it("reads a bare number in the unit the entry was logged in, as the row editor does", async () => {
    const tools = await read(breakfast());
    const proposal = proposalOf(await tools.run(stepOf({ action: "change_entry", entry: "E1", amount: "60" }), signal));
    expect(proposal.kind === "edit" && proposal.preview.amount).toBe("60 g");
  });

  it("changes only the meal, keeping the amount", async () => {
    const tools = await read(breakfast());
    const proposal = proposalOf(await tools.run(stepOf({ action: "change_entry", entry: "E1", meal: "lunch" }), signal));
    expect(proposal.kind === "edit" && proposal.edit).toEqual({ mealType: "LUNCH" });
  });

  it("can take the meal away", async () => {
    const tools = await read(breakfast());
    const proposal = proposalOf(await tools.run(stepOf({ action: "change_entry", entry: "E1", meal: "none" }), signal));
    expect(proposal.kind === "edit" && proposal.edit).toEqual({});
    expect(proposal.kind === "edit" && proposal.preview.mealType).toBe("MEAL_TYPE_UNSPECIFIED");
  });

  it("moves an entry to an earlier day, never a later one", async () => {
    const tools = await read(breakfast());
    const moved = proposalOf(await tools.run(stepOf({ action: "change_entry", entry: "E1", day: "yesterday" }), signal));
    expect(moved.kind === "edit" && moved.edit.day).toBe("2026-11-18");
    expect((await tools.run(stepOf({ action: "change_entry", entry: "E1", day: "2026-11-20" }), signal)).kind).toBe("error");
  });

  it("says when nothing would change", async () => {
    const tools = await read(breakfast());
    const outcome = await tools.run(stepOf({ action: "change_entry", entry: "E1", amount: "40 g", meal: "breakfast" }), signal);
    expect(outcome).toMatchObject({ kind: "error", text: "That is how the entry already is, so there is nothing to change." });
  });

  it("refuses to change or delete another app's entry", async () => {
    const tools = await read(entryOf(oats, 40, "g", `${TODAY}T08:05:00`, { writer: "someone-else" }));
    expect(await tools.run(stepOf({ action: "change_entry", entry: "E1", meal: "lunch" }), signal)).toMatchObject({ kind: "error" });
    expect(await tools.run(stepOf({ action: "delete_entry", entry: "E1" }), signal)).toMatchObject({ kind: "error" });
  });

  it("deletes a meal prep share, but won't change one", async () => {
    const share = entryOf({ ...oats, ref: { source: "prep", id: "abc" }, name: "Chili (1/4)" }, 100, "g", `${TODAY}T19:00:00`, { id: "e-abc-cc33-prep-abc" });
    const tools = await read(share);
    expect(await tools.run(stepOf({ action: "change_entry", entry: "E1", meal: "dinner" }), signal)).toMatchObject({ kind: "error" });
    expect(proposalOf(await tools.run(stepOf({ action: "delete_entry", entry: "E1" }), signal)).kind).toBe("delete");
  });

  it("proposes deleting the entry it was given", async () => {
    const entry = breakfast();
    const tools = await read(entry);
    expect(proposalOf(await tools.run(stepOf({ action: "delete_entry", entry: "E1" }), signal))).toEqual({ kind: "delete", entry });
  });
});

describe("outcomeText", () => {
  it("tells the model what the user decided", () => {
    const proposal: Proposal = { kind: "delete", entry: breakfast() };
    expect(outcomeText(proposal, { accepted: false }, TODAY)).toContain("rejected");
    expect(outcomeText(proposal, { accepted: true, ok: false, message: "Offline." }, TODAY)).toBe("The user accepted, but it failed: Offline.");
    expect(outcomeText(proposal, { accepted: true, ok: true, message: "" }, TODAY)).toBe(`The user accepted, and it was done: ${describeDone(proposal, TODAY)}`);
  });
});
