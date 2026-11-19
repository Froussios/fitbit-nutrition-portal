// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FoodItem } from "../src/core/food";
import type { SavedMeal } from "../src/core/meal";
import type { Prep, PrepIngredient } from "../src/core/prep";
import { LocalFoodCatalog } from "../src/food/catalog";
import { createLogForm, MAX_MEALS_ON_HAND, type LogFormPrepActions, type LogMeal } from "../src/ui/log-form";
import { rescaleSaved } from "../src/ui/ingredient-rows";
import { createPrepBuilder } from "../src/ui/prep-builder";

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

const ing = (label: string, quantity: number, kcal: number): PrepIngredient => ({ ref: { source: "afcd", id: label }, label, quantity, unit: "g", profile: { energyKcal: kcal, nutrients: { protein: kcal / 10 } } });
const meal = (id: string, name: string, ingredients = [ing("Rice", 150, 150), ing("Chicken", 100, 200)], updatedAt = 1): SavedMeal => ({ id, name, ingredients, createdAt: 1, updatedAt });
const MEALS = [meal("bowl0001", "Chicken burrito bowl"), meal("brek0001", "Weekday breakfast", [ing("Oats", 50, 190)])];

function setUp(preps: readonly Prep[] | null = PREPS, meals: readonly SavedMeal[] | null = null) {
  const actions: LogFormPrepActions = {
    eat: vi.fn(async () => ({ text: "Logged.", error: false, eaten: true })),
    discard: vi.fn(async () => ({ text: "Discarded.", error: false })),
  };
  const logMeal = vi.fn<LogMeal>(async () => {});
  const onSubmit = vi.fn(async (_draft: unknown) => {});
  const form = createLogForm(catalog(), onSubmit, () => new Date(2026, 10, 11, 19, 5), actions, logMeal);
  document.body.append(form.element);
  if (preps) form.setPreps({ available: true, preps, busy: new Set() });
  if (meals) form.setMeals({ available: true, meals });
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
  return { form, actions, logMeal, onSubmit, $, visible, type, options };
}

beforeEach(() => {
  vi.useFakeTimers();
  // The form's default time (11 Nov, 19:05) is today, unless a test moves the clock.
  vi.setSystemTime(new Date(2026, 10, 11, 20, 0));
});
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
    // Meal prep is now the only source on, so it can't be turned off. Saved meals aren't offered on this site.
    expect($<HTMLButtonElement>(".sources .chip:nth-child(3)").disabled).toBe(true);
    expect($<HTMLButtonElement>(".sources .chip:nth-child(4)").hidden).toBe(true);
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
    // The next entry is likely from the same meal.
    expect($<HTMLSelectElement>("#meal").value).toBe("DINNER");
  });

  it("marks the log button, and names the day, when the entry is not for today", async () => {
    const { form, $, type } = setUp();
    await type("Chickpeas");
    [...form.element.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent?.includes("Chickpeas"))!.click();
    await vi.advanceTimersByTimeAsync(0);
    const submit = $<HTMLButtonElement>("[type=submit]");
    expect(submit.textContent).toBe("Log entry");
    expect(submit.classList.contains("other-day")).toBe(false);

    // A time typed for another day.
    const time = $<HTMLInputElement>("#time");
    time.value = "2026-11-09T08:30";
    time.dispatchEvent(new Event("input"));
    expect(submit.textContent).toBe("Log entry for Monday, 9 Nov 2026");
    expect(submit.classList.contains("other-day")).toBe(true);
    time.value = "2026-11-11T08:30";
    time.dispatchEvent(new Event("input"));
    expect(submit.textContent).toBe("Log entry");
    expect(submit.classList.contains("other-day")).toBe(false);
  });

  it("marks the log button when the viewed day is not today, and follows the clock past midnight", async () => {
    const { form, $ } = setUp();
    form.choosePrep(PREPS[0]!);
    const submit = $<HTMLButtonElement>("[type=submit]");
    expect(submit.textContent).toBe("Log portion");
    vi.setSystemTime(new Date(2026, 10, 12, 0, 5));
    form.element.dispatchEvent(new FocusEvent("focusin"));
    expect(submit.textContent).toBe("Log portion for yesterday");
    expect(submit.classList.contains("other-day")).toBe(true);
  });

  it("keeps the meal for the next food logged", async () => {
    const { form, $, type, onSubmit } = setUp();
    const logFood = async (name: string) => {
      await type(name);
      [...form.element.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent?.includes(name))!.click();
      await vi.advanceTimersByTimeAsync(0);
      const qty = $<HTMLInputElement>("#qty");
      qty.value = "100";
      qty.dispatchEvent(new Event("input"));
      form.element.dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
    };
    $<HTMLSelectElement>("#meal").value = "BREAKFAST";
    await logFood("Chickpeas");
    expect($<HTMLSelectElement>("#meal").value).toBe("BREAKFAST");
    await logFood("Chia seeds");
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls.map(([d]) => [(d as { food: FoodItem }).food.name, (d as { mealType?: string }).mealType])).toEqual([
      ["Chickpeas", "BREAKFAST"],
      ["Chia seeds", "BREAKFAST"],
    ]);
  });

  it("leaves the time with one Tab either way, rather than one per part of the date", () => {
    const { form, $ } = setUp();
    form.choosePrep(PREPS[0]!);
    const time = $<HTMLInputElement>("#time");
    const tab = (shiftKey: boolean) => {
      time.focus();
      const press = new KeyboardEvent("keydown", { key: "Tab", shiftKey, cancelable: true });
      time.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
      return document.activeElement;
    };
    expect(tab(false)).toBe($("button[type=submit]"));
    expect(tab(true)).toBe($("#meal"));
    // Disabled and hidden controls are passed over; with nothing after the time, it lets go of focus.
    const eatRest = [...form.element.querySelectorAll("button")].find((b) => b.textContent === "Eat the rest")!;
    $<HTMLButtonElement>("button[type=submit]").disabled = true;
    expect(tab(false)).toBe(eatRest);
    eatRest.parentElement!.hidden = true;
    expect(tab(false)).toBe(document.body);
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
    expect($("p.form-status").classList.contains("error")).toBe(true);
    vi.mocked(actions.eat).mockResolvedValueOnce({ text: "Refused.", error: true });
    portion.value = "1/6";
    await submit();
    expect(portion.value).toBe("1/6"); // nothing was eaten: try again
    vi.mocked(actions.eat).mockRejectedValueOnce(new Error("Broken."));
    await submit();
    expect($("p.form-status").textContent).toBe("Broken.");
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
    const status = $("p.form-status");
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
    expect(form.element.querySelector("p.form-status")!.textContent).toBe("Nothing is left of Chili con carne.");
  });
});

describe("log form, saved meals", () => {
  const amounts = (root: ParentNode) => [...root.querySelectorAll<HTMLInputElement>(".ingredients input")];
  const typeInto = (input: HTMLInputElement, text: string) => {
    input.value = text;
    input.dispatchEvent(new Event("input"));
  };
  const submit = async (form: HTMLFormElement) => {
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
  };

  it("offers saved meals under an empty search, by name, at most a few", () => {
    const many = Array.from({ length: MAX_MEALS_ON_HAND + 2 }, (_, i) => meal(`meal${String(i).padStart(4, "0")}`, `Meal ${String.fromCharCode(90 - i)}`));
    const { $ } = setUp(PREPS, many);
    const names = [...$(".on-hand").querySelectorAll(".on-hand-item .on-hand-name")].map((n) => n.textContent);
    expect(names.slice(0, 2)).toEqual(["Chili con carne", "Chicken curry"]);
    expect(names.slice(3)).toHaveLength(MAX_MEALS_ON_HAND);
    expect(names[3]).toBe(`Meal ${String.fromCharCode(90 - MAX_MEALS_ON_HAND - 1)}`);
    expect($<HTMLInputElement>("#food").placeholder).toBe("Search foods, meal preps and saved meals");
  });

  it("finds saved meals in the search, before meal preps and foods", async () => {
    const { type, options } = setUp(PREPS, MEALS);
    await type("chi");
    expect(options().slice(0, 3)).toEqual(["Chicken burrito bowl", "Chili con carne", "Chicken curry"]);
  });

  it("logs the meal under its name, with the ingredients as changed for this entry only", async () => {
    const { form, $, visible, logMeal } = setUp(PREPS, MEALS);
    form.chooseMeal(MEALS[0]!);
    expect(visible("#qty")).toBe(false);
    expect($("[type=submit]").textContent).toBe("Log meal");
    expect($(".preview").textContent).toContain("350 kcal");
    expect($(".adjusted").hidden).toBe(true);

    const [rice] = amounts(form.element);
    typeInto(rice!, "100");
    expect($(".preview").textContent).toContain("300 kcal");
    form.element.querySelector<HTMLButtonElement>("[aria-label='Leave out Chicken']")!.click();
    expect($(".preview").textContent).toContain("100 kcal");
    expect($(".adjusted").hidden).toBe(false);
    expect($(".adjusted").textContent).toContain("2 changes from the saved meal (350 kcal)");

    $<HTMLSelectElement>("#meal").value = "LUNCH";
    await submit(form.element as HTMLFormElement);
    expect(logMeal).toHaveBeenCalledWith(MEALS[0], [expect.objectContaining({ label: "Rice", quantity: 100, profile: { energyKcal: 100, nutrients: { protein: 10 } } })], "LUNCH", new Date(2026, 10, 11, 19, 5));
    expect($("p.form-status").textContent).toBe("Logged Chicken burrito bowl.");
    expect($<HTMLSelectElement>("#meal").value).toBe("LUNCH");
    // The saved meal is untouched, and the next entry starts from it.
    expect(MEALS[0]!.ingredients[0]!.quantity).toBe(150);
    expect(amounts(form.element).map((i) => i.value)).toEqual(["150", "100"]);
    expect($(".adjusted").hidden).toBe(true);
  });

  it("puts a left-out ingredient back, and resets to the saved meal", () => {
    const { form, $ } = setUp(PREPS, MEALS);
    form.chooseMeal(MEALS[0]!);
    form.element.querySelector<HTMLButtonElement>("[aria-label='Leave out Rice']")!.click();
    form.element.querySelector<HTMLButtonElement>("[aria-label='Put back Rice']")!.click();
    expect($(".adjusted").hidden).toBe(true);
    typeInto(amounts(form.element)[1]!, "50");
    [...form.element.querySelectorAll("button")].find((b) => b.textContent === "Reset to the saved meal")!.click();
    expect(amounts(form.element).map((i) => i.value)).toEqual(["150", "100"]);
    expect($(".preview").textContent).toContain("350 kcal");
  });

  it("won't log an amount it can't read, or a meal with nothing in it", async () => {
    const { form, $, logMeal } = setUp(PREPS, MEALS);
    form.chooseMeal(MEALS[1]!);
    typeInto(amounts(form.element)[0]!, "lots");
    await submit(form.element as HTMLFormElement);
    expect($("p.form-status").textContent).toBe("Enter an amount for Oats.");
    form.element.querySelector<HTMLButtonElement>("[aria-label='Leave out Oats']")!.click();
    await submit(form.element as HTMLFormElement);
    expect($("p.form-status").textContent).toBe("Add an ingredient, or reset to the saved meal.");
    expect(logMeal).not.toHaveBeenCalled();
  });

  it("adds another saved meal's ingredients, scaled to the servings, without logging", async () => {
    const { form, $, logMeal } = setUp(PREPS, MEALS);
    form.chooseMeal(MEALS[0]!);
    const search = $<HTMLInputElement>("#meal-add-food");
    search.focus();
    typeInto(search, "breakfast");
    await vi.advanceTimersByTimeAsync(500);
    [...form.element.querySelectorAll<HTMLElement>("#meal-add-food-list [role=option]")].find((o) => o.textContent?.includes("Weekday breakfast"))!.click();
    const servings = $<HTMLInputElement>("#meal-add-qty");
    typeInto(servings, "2");
    servings.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(logMeal).not.toHaveBeenCalled();
    expect([...form.element.querySelectorAll(".ingredients li.added .ingredient-name")].map((n) => n.firstChild?.textContent)).toEqual(["Oats"]);
    expect(amounts(form.element).map((i) => i.value)).toEqual(["150", "100", "100"]);
    expect($(".preview").textContent).toContain("730 kcal");
    expect(form.element.textContent).toContain("Added 1 ingredient from Weekday breakfast.");
  });

  it("never logs the meal from Enter in the search for another ingredient", () => {
    const { form, $ } = setUp(PREPS, MEALS);
    form.chooseMeal(MEALS[0]!);
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    $<HTMLInputElement>("#meal-add-food").dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
  });

  it("goes back to the search when the chosen meal is deleted", () => {
    const { form, visible } = setUp(PREPS, MEALS);
    form.chooseMeal(MEALS[0]!);
    form.setMeals({ available: true, meals: MEALS.slice(1) });
    expect(visible(".meal-fields")).toBe(false);
    expect(form.element.querySelector("p.form-status")!.textContent).toBe("Chicken burrito bowl is no longer a saved meal.");
  });

  it("follows an edit made elsewhere, unless this entry has changes of its own", () => {
    const { form } = setUp(PREPS, MEALS);
    form.chooseMeal(MEALS[0]!);
    form.setMeals({ available: true, meals: [meal("bowl0001", "Chicken burrito bowl", [ing("Rice", 200, 200)], 2), MEALS[1]!] });
    expect(amounts(form.element).map((i) => i.value)).toEqual(["200"]);
    typeInto(amounts(form.element)[0]!, "120");
    form.setMeals({ available: true, meals: [meal("bowl0001", "Chicken burrito bowl", [ing("Rice", 250, 250)], 3), MEALS[1]!] });
    expect(amounts(form.element).map((i) => i.value)).toEqual(["120"]);
  });

  it("hides saved meals on a site whose API has none", () => {
    const { $ } = setUp(PREPS, null);
    expect($<HTMLButtonElement>(".sources .chip:nth-child(4)").hidden).toBe(true);
    expect($<HTMLInputElement>("#food").placeholder).toBe("Search foods and meal preps");
  });
});

describe("saved meal builder", () => {
  function build(meals: readonly SavedMeal[] = MEALS, draftKey: (id: string | undefined) => string | undefined = () => undefined) {
    const onSave = vi.fn(async (_draft: unknown) => {});
    const builder = createPrepBuilder({ catalog: catalog(), kind: "meal", draftKey, onSave, onClose: () => {}, meals: () => meals });
    document.body.append(builder.element);
    const root = builder.element;
    const rows = () => [...root.querySelectorAll<HTMLElement>(".ingredient-rows > li")];
    const inRow = <T extends HTMLElement>(row: number, selector: string) => rows()[row]!.querySelector<T>(selector)!;
    const button = (text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === text)!;
    const setName = (text: string) => {
      const name = root.querySelector<HTMLInputElement>("#meal-name")!;
      name.value = text;
      name.dispatchEvent(new Event("input"));
    };
    const search = async (row: number, text: string, option: string) => {
      const input = inRow<HTMLInputElement>(row, "[role=combobox]");
      input.focus();
      input.value = text;
      input.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(500);
      [...rows()[row]!.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent?.includes(option))!.click();
      await vi.advanceTimersByTimeAsync(0);
    };
    const amount = (row: number, text: string) => {
      const input = inRow<HTMLInputElement>(row, "input[id$=-qty]");
      input.value = text;
      input.dispatchEvent(new Event("input"));
      input.dispatchEvent(new Event("blur"));
    };
    const preview = () => root.querySelector(".preview")!.textContent;
    const save = async () => {
      button("Save meal").click();
      await vi.advanceTimersByTimeAsync(0);
    };
    return { builder, root, onSave, rows, inRow, button, setName, search, amount, preview, save };
  }

  it("adds a row with Add ingredient, and keeps every row open until the meal is saved", async () => {
    const { builder, rows, inRow, button, setName, search, amount, preview, save, onSave } = build();
    builder.open();
    expect(rows()).toHaveLength(1);
    setName("Lunch");
    await search(0, "chickp", "Chickpeas");
    amount(0, "200");
    button("Add ingredient").click();
    expect(rows()).toHaveLength(2);
    expect(document.activeElement).toBe(inRow(1, "[role=combobox]"));
    await search(1, "chia", "Chia seeds");
    amount(1, "20");
    expect(preview()).toContain("Whole meal ≈ 220 kcal");
    // The first row is still open: its food and its amount can both change.
    await search(0, "chicken", "Chicken breast");
    amount(0, "150");
    expect(inRow<HTMLInputElement>(0, "[role=combobox]").value).toBe("Chicken breast");
    expect(preview()).toContain("Whole meal ≈ 170 kcal");
    await save();
    expect(onSave).toHaveBeenCalledWith({
      name: "Lunch",
      ingredients: [expect.objectContaining({ label: "Chicken breast", quantity: 150, unit: "g" }), expect.objectContaining({ label: "Chia seeds", quantity: 20, unit: "g" })],
    });
  });

  it("goes from one row's amount to a new row with Enter, and leaves empty rows out", async () => {
    const { builder, rows, inRow, setName, search, amount, save, onSave } = build();
    builder.open();
    setName("Snack");
    await search(0, "chia", "Chia seeds");
    amount(0, "30");
    inRow<HTMLInputElement>(0, "input[id$=-qty]").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(rows()).toHaveLength(2);
    expect(document.activeElement).toBe(inRow(1, "[role=combobox]"));
    await save();
    expect(onSave).toHaveBeenCalledWith({ name: "Snack", ingredients: [expect.objectContaining({ label: "Chia seeds", quantity: 30 })] });
  });

  it("won't save while a row has text but no food chosen, and removes a row with ✕", async () => {
    const { builder, rows, inRow, button, setName, search, amount, preview } = build();
    builder.open();
    setName("Snack");
    await search(0, "chia", "Chia seeds");
    amount(0, "30");
    button("Add ingredient").click();
    const typed = inRow<HTMLInputElement>(1, "[role=combobox]");
    typed.value = "banana";
    typed.dispatchEvent(new Event("input"));
    expect(preview()).toContain('Choose a food from the list for "banana"');
    expect(button("Save meal").disabled).toBe(true);
    inRow<HTMLButtonElement>(1, "button.icon").click();
    expect(rows()).toHaveLength(1);
    expect(button("Save meal").disabled).toBe(false);
  });

  it("keeps a saved meal as one row in servings, and saves copies of its ingredients", async () => {
    const { builder, rows, setName, search, amount, preview, save, onSave } = build();
    builder.open();
    setName("Big lunch");
    await search(0, "bowl", "Chicken burrito bowl");
    amount(0, "0.5");
    expect(rows()).toHaveLength(1);
    expect(preview()).toContain("Whole meal ≈ 175 kcal");
    await save();
    expect(onSave).toHaveBeenCalledWith({ name: "Big lunch", ingredients: [expect.objectContaining({ label: "Rice", quantity: 75 }), expect.objectContaining({ label: "Chicken", quantity: 50, profile: { energyKcal: 100, nutrients: { protein: 10 } } })] });
    expect(MEALS[0]!.ingredients.map((i) => i.quantity)).toEqual([150, 100]);
  });

  it("opens a saved meal with a row per ingredient, which scales its saved nutrients to another amount or unit", async () => {
    const { builder, rows, inRow, amount, save, onSave } = build();
    builder.open({ ...MEALS[0]!, updatedAt: 1 });
    expect(rows()).toHaveLength(2);
    expect(rows().map((r) => r.querySelector<HTMLInputElement>("[role=combobox]")!.value)).toEqual(["Rice", "Chicken"]);
    expect(rows().map((r) => r.querySelector<HTMLInputElement>("input[id$=-qty]")!.value)).toEqual(["150", "100"]);
    amount(0, "75");
    const unit = inRow<HTMLSelectElement>(1, "select");
    unit.value = "kg";
    unit.dispatchEvent(new Event("input"));
    amount(1, "0.2");
    await save();
    expect(onSave).toHaveBeenCalledWith({
      id: "bowl0001",
      name: "Chicken burrito bowl",
      ingredients: [
        expect.objectContaining({ label: "Rice", quantity: 75, unit: "g", profile: { energyKcal: 75, nutrients: { protein: 7.5 } } }),
        expect.objectContaining({ label: "Chicken", quantity: 0.2, unit: "kg", profile: { energyKcal: 400, nutrients: { protein: 40 } } }),
      ],
    });
  });

  it("keeps every row's ingredient in the draft, and brings them back as rows", async () => {
    const key = () => "draft";
    const first = build(MEALS, key);
    first.builder.open();
    first.setName("Lunch");
    await first.search(0, "chickp", "Chickpeas");
    first.amount(0, "200");
    first.button("Add ingredient").click();
    await first.search(1, "chia", "Chia seeds");
    first.amount(1, "20");
    first.builder.close();
    document.body.replaceChildren();
    const second = build(MEALS, key);
    second.builder.open();
    expect(second.rows().map((r) => r.querySelector<HTMLInputElement>("[role=combobox]")!.value)).toEqual(["Chickpeas", "Chia seeds"]);
    expect(second.preview()).toContain("Whole meal ≈ 220 kcal");
  });
});

describe("an ingredient as saved, at another amount", () => {
  const rice = ing("Rice", 150, 150);
  it("scales its own nutrients within the same kind of unit", () => {
    expect(rescaleSaved(rice, 0.3, "kg")).toEqual({ ...rice, quantity: 0.3, unit: "kg", profile: { energyKcal: 300, nutrients: { protein: 30 } } });
    const half = { ...rice, quantity: 0.5, unit: "portion:medium" };
    expect(rescaleSaved(half, 2, "portion:medium")!.profile.energyKcal).toBe(600);
  });
  it("needs its food for another kind of unit, and then takes the food's nutrients", () => {
    expect(rescaleSaved(rice, 100, "ml")).toBeUndefined();
    const loaded: FoodItem = { ...food("Rice"), portions: [{ name: "cup", amount: 200, unit: "g" }] };
    expect(rescaleSaved(rice, 1, "portion:cup", loaded)!.profile.energyKcal).toBe(200);
  });
});
