// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FoodItem } from "../src/core/food";
import type { Prep } from "../src/core/prep";
import { LocalFoodCatalog } from "../src/food/catalog";
import { createLogForm, type LogFormPrepActions } from "../src/ui/log-form";

const food = (name: string): FoodItem => ({ ref: { source: "off", id: name }, name, basis: "g", per100: { energyKcal: 100, nutrients: {} }, portions: [] });
const catalog = () => new LocalFoodCatalog([food("Chickpeas"), food("Chicken breast"), food("Chia seeds")]);

const prep = (id: string, name: string, eaten = 0): Prep => ({
  id,
  name,
  ingredients: [{ ref: { source: "manual", id: "x" }, label: "Beans", quantity: 1000, unit: "g", profile: { energyKcal: 1200, nutrients: { protein: 60 } } }],
  createdAt: Date.now() - 2 * 24 * 60 * 60_000,
  updatedAt: 0,
  discardedAt: null,
  portions: eaten ? [{ id: "p1", fraction: eaten, entryId: "e1", state: "confirmed", eatenAt: 0, createdAt: 0 }] : [],
});
const PREPS = [prep("chili", "Chili con carne", 0.4), prep("chick", "Chicken curry", 0.75), prep("chips", "Chickpea stew")];

function setUp(preps: readonly Prep[] | null = PREPS) {
  const actions: LogFormPrepActions = {
    eat: vi.fn(async () => ({ text: "Logged.", error: false, eaten: true })),
    discard: vi.fn(async () => ({ text: "Discarded.", error: false })),
  };
  const form = createLogForm(catalog(), vi.fn(async () => {}), () => new Date(2026, 10, 11, 19, 5), actions);
  document.body.append(form.element);
  if (preps) form.setPreps({ available: true, preps, busy: new Set() });
  const $ = <T extends HTMLElement>(selector: string) => form.element.querySelector<T>(selector)!;
  const visible = (selector: string) => {
    for (let node: HTMLElement | null = $(selector); node; node = node.parentElement) if (node.hidden) return false;
    return true;
  };
  const type = async (text: string) => {
    const input = $<HTMLInputElement>("#food");
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(500);
  };
  const options = () => [...form.element.querySelectorAll("[role=option]")].map((o) => o.querySelector(".opt-name")?.textContent ?? o.textContent);
  return { form, actions, $, visible, type, options };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  localStorage.clear();
});

describe("log form", () => {
  it("shows only the search until a food is chosen", async () => {
    const { $, visible, type } = setUp(null);
    expect(visible("#qty")).toBe(false);
    expect(visible("#meal")).toBe(false);
    expect($(".sources").hidden).toBe(true); // no meal prep on this site
    await type("chickp");
    $<HTMLElement>(".opt").click();
    expect(visible("#qty")).toBe(true);
    expect(visible("#portion")).toBe(false);
  });

  it("offers the meal preps on hand under an empty search", () => {
    const { $, visible, actions } = setUp();
    expect(visible(".on-hand")).toBe(true);
    $<HTMLButtonElement>(".on-hand-item").click();
    expect(visible("#portion")).toBe(true);
    expect(visible("#qty")).toBe(false);
    expect(visible(".on-hand")).toBe(false);
    expect($<HTMLInputElement>("#food").value).toBe("Chili con carne");
    expect($(".prep-left").textContent).toBe("60% left");
    expect(actions.eat).not.toHaveBeenCalled();
  });

  it("puts at most two meal preps before the food search hits", async () => {
    const { type, options } = setUp();
    await type("chi");
    const rows = options();
    expect(rows.slice(0, 2)).toEqual(["Chili con carne", "Chicken curry"]);
    expect(rows).not.toContain("Chickpea stew");
    expect(rows).toEqual(expect.arrayContaining(["Chickpeas", "Chicken breast", "Chia seeds"]));
    expect(rows.at(-1)).toContain("Custom food");
  });

  it("searches only the sources chosen, and remembers them", async () => {
    const { $, type, options } = setUp();
    $<HTMLButtonElement>(".sources .chip").click(); // Foods off
    await type("chi");
    expect(options()).toEqual(["Chili con carne", "Chicken curry"]); // no foods, no custom food
    // Meal prep is now the only source on, so it can't be turned off.
    expect($<HTMLButtonElement>(".sources .chip:last-child").disabled).toBe(true);
    document.body.replaceChildren();
    expect(setUp().$(".sources .chip").getAttribute("aria-pressed")).toBe("false");
  });

  it("logs a share of the chosen prep at the time and meal given", async () => {
    const { form, $, actions } = setUp();
    form.choosePrep(PREPS[0]!);
    const portion = $<HTMLInputElement>("#portion");
    portion.value = "1/6";
    portion.dispatchEvent(new Event("input"));
    expect($(".preview").textContent).toContain("200 kcal");
    $<HTMLSelectElement>("#meal").value = "DINNER";
    form.element.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(actions.eat).toHaveBeenCalledWith(PREPS[0], 1 / 6, "DINNER", new Date(2026, 10, 11, 19, 5));
    expect(portion.value).toBe("");
  });

  it("refuses more than is left, and eats the rest on request", async () => {
    const { form, $, actions } = setUp();
    form.choosePrep(PREPS[1]!);
    const portion = $<HTMLInputElement>("#portion");
    portion.value = "1/2";
    portion.dispatchEvent(new Event("input"));
    expect($(".preview").textContent).toBe("Only 25% is left.");
    form.element.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(actions.eat).not.toHaveBeenCalled();
    [...form.element.querySelectorAll("button")].find((b) => b.textContent === "Eat the rest")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(actions.eat).toHaveBeenCalledWith(PREPS[1], null, undefined, expect.any(Date));
  });

  it("clears the portion when it counts as eaten despite an error, so it can't be eaten twice", async () => {
    const { form, $, actions } = setUp();
    form.choosePrep(PREPS[0]!);
    const portion = $<HTMLInputElement>("#portion");
    const submit = async () => {
      form.element.dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
    };
    vi.mocked(actions.eat).mockResolvedValueOnce({ text: "Google Health did not answer.", error: true, eaten: true });
    portion.value = "1/6";
    await submit();
    expect(portion.value).toBe("");
    expect($("p.status[role=status]").classList.contains("error")).toBe(true);
    vi.mocked(actions.eat).mockResolvedValueOnce({ text: "Refused.", error: true });
    portion.value = "1/6";
    await submit();
    expect(portion.value).toBe("1/6"); // nothing was eaten: try again
    vi.mocked(actions.eat).mockRejectedValueOnce(new Error("Broken."));
    await submit();
    expect($("p.status[role=status]").textContent).toBe("Broken.");
  });

  it("discards the chosen prep, and says whether Undo worked", async () => {
    const { form, $, actions, visible } = setUp();
    const undo = vi.fn(async () => ({ text: "Could not bring back Chili con carne.", error: true }));
    vi.mocked(actions.discard).mockResolvedValueOnce({ text: "Discarded Chili con carne.", error: false, undo });
    form.choosePrep(PREPS[0]!);
    [...form.element.querySelectorAll("button")].find((b) => b.textContent === "Discard batch")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(actions.discard).toHaveBeenCalledWith(PREPS[0]);
    expect(visible("#portion")).toBe(false);
    const status = $("p.status[role=status]");
    expect(status.textContent).toBe("Discarded Chili con carne. Undo");
    status.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(undo).toHaveBeenCalled();
    expect(status.textContent).toBe("Could not bring back Chili con carne.");
    expect(status.classList.contains("error")).toBe(true);
  });

  it("goes back to the search when the chosen prep is finished", () => {
    const { form, visible } = setUp();
    form.choosePrep(PREPS[0]!);
    form.setPreps({ available: true, preps: PREPS.slice(1), busy: new Set() });
    expect(visible("#portion")).toBe(false);
    expect(form.element.querySelector("p.status[role=status]")!.textContent).toBe("Nothing is left of Chili con carne.");
  });
});
