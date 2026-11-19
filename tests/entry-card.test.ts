// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createEntryCard } from "../src/ui/entry-card";

describe("createEntryCard", () => {
  it("names the tab shown on the card, which takes that tab's colour", () => {
    const card = createEntryCard(document.createElement("div"), document.createElement("div"), document.createElement("div"));
    expect(card.element.dataset.tab).toBe("log");
    card.setPrep(true, 0);
    card.setMeals(true, 0);
    card.show("prep");
    expect(card.element.dataset.tab).toBe("prep");
    card.show("meals");
    expect(card.element.dataset.tab).toBe("meals");
  });

  it("falls back to the log form's colour when the tab shown is not available", () => {
    const card = createEntryCard(document.createElement("div"), document.createElement("div"), document.createElement("div"));
    card.show("prep");
    expect(card.element.dataset.tab).toBe("log");
  });
});
