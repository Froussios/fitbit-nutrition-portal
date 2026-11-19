// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiState } from "../src/ai/amount-ai";
import type { ChatModel, ChatSession } from "../src/ai/chat-model";
import type { Proposal } from "../src/ai/chat-tools";
import { createChatPanel, type AiSwitch, type ChatPanelHost } from "../src/ui/chat-panel";
import { createProposalCard } from "../src/ui/chat-proposal";
import { renderDiaryTable } from "../src/ui/diary-table";
import { bread, entryOf, hostWith, oats, TODAY } from "./chat-fixtures";

const answer = (fields: Record<string, string>) => JSON.stringify({ text: "", day: "", from: "", to: "", query: "", food: "", entry: "", amount: "", meal: "", ...fields });

const breakfast = () => entryOf(oats, 40, "g", `${TODAY}T08:05:00`, { mealType: "BREAKFAST" });

afterEach(() => {
  document.body.replaceChildren();
  document.body.className = "";
});

describe("proposal card", () => {
  it("identifies the entry to change by what the diary shows, and shows each change", () => {
    const entry = breakfast();
    const preview = entryOf(oats, 90, "g", `${TODAY}T08:05:00`, { mealType: "LUNCH" });
    const card = createProposalCard({ kind: "edit", entry, edit: { mealType: "LUNCH" }, preview }, TODAY, vi.fn());
    const text = card.element.textContent ?? "";
    expect(card.element.querySelector("h3")?.textContent).toBe("Change this entry?");
    for (const fact of ["Oats", "40 g", "Breakfast", "Today, 8:05 am", "160 kcal"]) expect(text).toContain(fact);
    const changes = [...card.element.querySelectorAll(".change")].map((c) => c.textContent);
    expect(changes).toEqual(["40 g →  becomes 90 g", "Breakfast →  becomes Lunch", expect.stringContaining("160 kcal")]);
    expect(text).not.toContain(entry.id);
  });

  it("shows a delete in full and reports the decision", () => {
    const onDecide = vi.fn();
    const entry = breakfast();
    const card = createProposalCard({ kind: "delete", entry }, TODAY, onDecide);
    document.body.append(card.element);
    expect(card.element.textContent).toContain("Delete this entry?");
    const [accept, reject] = card.element.querySelectorAll("button");
    expect(accept!.getAttribute("aria-label")).toBe("Delete it: Oats");
    reject!.click();
    expect(onDecide).toHaveBeenCalledWith(false);
    card.set({ kind: "rejected" });
    expect(card.element.querySelector<HTMLElement>(".actions")!.hidden).toBe(true);
    expect(card.element.textContent).toContain("Rejected. Nothing was changed.");
  });
});

function aiSwitch(kind: AiState["kind"]): AiSwitch & { set(kind: AiState["kind"]): void } {
  let state = { kind } as AiState;
  const listeners: (() => void)[] = [];
  return {
    getState: () => state,
    onChange: (l) => listeners.push(l),
    set(k) {
      state = { kind: k } as AiState;
      for (const l of listeners) l();
    },
  };
}

function fakeModel(...answers: string[]) {
  const destroy = vi.fn();
  const prompts: string[] = [];
  const initial: unknown[] = [];
  const model: ChatModel = {
    async open(initialPrompts) {
      initial.push(initialPrompts);
      const session: ChatSession = {
        async prompt(text) {
          prompts.push(text);
          const next = answers.shift();
          if (!next) throw new Error("No more answers");
          return next;
        },
        destroy,
      };
      return session;
    },
  };
  return { model, prompts, initial, destroy };
}

function setup(answers: string[], kind: AiState["kind"] = "ready") {
  const ai = aiSwitch(kind);
  const fake = fakeModel(...answers);
  const apply = vi.fn(async (_p: Proposal) => ({ ok: true, message: "Deleted Oats." }));
  const host: ChatPanelHost = { ...hostWith({ [TODAY]: [breakfast()] }, [oats, bread]), apply };
  const panel = createChatPanel(fake.model, ai, host);
  document.body.append(panel.toggle, panel.element);
  const input = panel.element.querySelector("textarea")!;
  const say = (text: string) => {
    input.value = text;
    panel.element.querySelector("form")!.requestSubmit();
  };
  const log = () => panel.element.querySelector(".chat-log")!;
  return { ai, fake, apply, panel, input, say, log };
}

describe("chat panel", () => {
  it("opens beside the diary from the header button", () => {
    const t = setup([]);
    t.panel.toggle.click();
    expect(t.panel.element.hidden).toBe(false);
    expect(document.body.classList.contains("chat-open")).toBe(true);
    expect(t.panel.toggle.getAttribute("aria-expanded")).toBe("true");
    t.panel.toggle.click();
    expect(t.panel.element.hidden).toBe(true);
  });

  it("can't be used until the AI setting is on, and is hidden where the model can't run", () => {
    const t = setup([], "off");
    t.panel.open();
    expect(t.input.disabled).toBe(true);
    expect(t.panel.element.textContent).toContain("Tick “Use AI processing of input” in the settings");
    t.ai.set("unsupported");
    expect(t.panel.toggle.hidden).toBe(true);
  });

  it("answers from the diary, and asks before deleting", async () => {
    const t = setup([answer({ action: "read_day", day: "today" }), answer({ action: "delete_entry", entry: "E1" }), answer({ action: "reply", text: "Deleted." })]);
    t.panel.open();
    t.say("Delete my oats");
    await vi.waitFor(() => expect(t.log().querySelector(".proposal")).not.toBeNull());
    expect(t.log().querySelector(".msg-user")?.textContent).toBe("Delete my oats");
    expect(t.log().querySelector(".msg-activity")?.textContent).toBe("Read the diary for today");
    // Nothing is written before the user accepts, and nothing else can be sent meanwhile.
    expect(t.apply).not.toHaveBeenCalled();
    expect(t.input.disabled).toBe(true);

    t.log().querySelector<HTMLButtonElement>(".proposal button.primary")!.click();
    await vi.waitFor(() => expect(t.log().querySelector(".msg-assistant")?.textContent).toBe("Deleted."));
    expect(t.apply).toHaveBeenCalledWith(expect.objectContaining({ kind: "delete" }));
    expect(t.log().querySelector(".proposal-status")?.textContent).toBe("Deleted Oats.");
    expect(t.fake.prompts.at(-1)).toBe("The user accepted, and it was done: Deleted Oats.");
    expect(t.input.disabled).toBe(false);
  });

  it("writes nothing when the user rejects a change", async () => {
    const t = setup([answer({ action: "read_day", day: "today" }), answer({ action: "delete_entry", entry: "E1" }), answer({ action: "reply", text: "OK, kept it." })]);
    t.panel.open();
    t.say("Delete my oats");
    await vi.waitFor(() => expect(t.log().querySelector(".proposal")).not.toBeNull());
    t.log().querySelectorAll<HTMLButtonElement>(".proposal button")[1]!.click();
    await vi.waitFor(() => expect(t.log().querySelector(".msg-assistant")?.textContent).toBe("OK, kept it."));
    expect(t.apply).not.toHaveBeenCalled();
    expect(t.fake.prompts.at(-1)).toMatch(/^The user rejected this change/);
  });

  it("opened on an entry, starts a chat about it, and tells the model which one", async () => {
    const t = setup([answer({ action: "reply", text: "That was 160 kcal." })]);
    const entry = breakfast();
    t.panel.open(entry);
    const about = t.panel.element.querySelector(".chat-about")!;
    expect(about.textContent).toBe("About: Oats · 40 g · Breakfast · Today, 8:05 am");
    t.say("How much energy?");
    await vi.waitFor(() => expect(t.log().querySelector(".msg-assistant")).not.toBeNull());
    const [system] = t.fake.initial[0] as { content: string }[];
    expect(system!.content).toContain('"This", "it" and "this entry" mean this one:\nE1: Oats, 40 g, breakfast');
  });

  it("ends the chat when the AI setting is turned off", async () => {
    const t = setup([answer({ action: "reply", text: "Hi." })]);
    t.panel.open();
    t.say("Hello");
    await vi.waitFor(() => expect(t.log().querySelector(".msg-assistant")).not.toBeNull());
    t.ai.set("off");
    await vi.waitFor(() => expect(t.fake.destroy).toHaveBeenCalled());
    expect(t.log().querySelector(".msg-user")).toBeNull();
    expect(t.input.disabled).toBe(true);
  });

  it("forgets the chat on reset, as on signing out", async () => {
    const t = setup([answer({ action: "reply", text: "Hi." })]);
    t.panel.open();
    t.say("Hello");
    await vi.waitFor(() => expect(t.log().querySelector(".msg-assistant")).not.toBeNull());
    t.panel.reset();
    expect(t.panel.isOpen).toBe(false);
    await vi.waitFor(() => expect(t.fake.destroy).toHaveBeenCalled());
    expect(t.log().querySelector(".msg-assistant")).toBeNull();
  });
});

describe("diary row chat button", () => {
  const options = { pendingIds: new Set<string>(), deleted: [], busy: new Map<string, string>(), offline: false, onEdit: vi.fn(), onDelete: vi.fn(), onUndo: vi.fn(), onRepeat: vi.fn() };

  it("opens the chat on the entry, for any app's entries", () => {
    const onAsk = vi.fn();
    const own = breakfast();
    const other = entryOf(oats, 40, "g", `${TODAY}T09:00:00`, { writer: "someone-else", id: "e-abc-zz99-off-123" });
    const table = renderDiaryTable({ ...options, entries: [own, other], onAsk });
    const buttons = table.querySelectorAll<HTMLButtonElement>("button.ask");
    expect(buttons).toHaveLength(2);
    buttons[0]!.click();
    expect(onAsk).toHaveBeenCalledWith(own);
  });

  it("is not there while the chat can't be used", () => {
    const table = renderDiaryTable({ ...options, entries: [breakfast()] });
    expect(table.querySelector("button.ask")).toBeNull();
  });
});
