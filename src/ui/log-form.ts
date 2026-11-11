import { amountAi } from "../ai/amount-ai";
import { defaultAmount } from "../core/amount-text";
import { nutrientsForAmount, type FoodItem } from "../core/food";
import { kjToKcal } from "../core/nutrients";
import { FRACTION_EPSILON, leftOf, parseFraction, portionProfile, type Prep } from "../core/prep";
import { toDateTimeLocalValue } from "../core/time";
import type { BaseUnit } from "../core/units";
import { MEAL_TYPES, type LogDraft } from "../health/mapping";
import type { MealType } from "../health/types";
import type { FoodCatalog } from "../food/catalog";
import { describeError, logger } from "../debug/log";
import { createAmountField } from "./amount-field";
import { el, errorMessage, replaceChildren } from "./dom";
import { createFoodCombobox, type ComboExtra } from "./food-combobox";
import { field } from "./form-fields";
import { madeAgo, percent, summary } from "./format";

const log = logger("log-form");

/** Where the search looks, kept on this device. */
const SOURCES_KEY = "foodDiary.searchSources";
/** While typing, at most this many meal preps come before the food search hits, which keep most of the list. */
const MAX_PREP_HITS = 2;

/** What came of eating or discarding a prep. */
export interface PrepOutcome {
  readonly text: string;
  readonly error: boolean;
  /** The portion counts as eaten, even if something went wrong: the form is cleared, so that trying again can't eat it twice. */
  readonly eaten?: boolean;
  /** Offered after a discard, to bring the prep back. */
  readonly undo?: () => Promise<PrepOutcome>;
}

export interface LogFormPrepActions {
  /** A null fraction eats the rest. */
  eat(prep: Prep, fraction: number | null, mealType: MealType | undefined, time: Date): Promise<PrepOutcome>;
  discard(prep: Prep): Promise<PrepOutcome>;
}

export interface LogFormPrepState {
  /** False on a site without the meal prep API: the form then searches foods only. */
  readonly available: boolean;
  /** Preps with some left that are not discarded. */
  readonly preps: readonly Prep[];
  /** Preps with an action under way. */
  readonly busy: ReadonlySet<string>;
}

export interface LogForm {
  readonly element: HTMLElement;
  /** Blocks submitting while the browser is offline; what the user entered stays in the form. */
  setOffline(offline: boolean): void;
  /** Shows the preview again, after the energy unit changes. */
  refreshPreview(): void;
  /** Moves an untouched time to the default again, after the viewed day changes. */
  refreshTime(): void;
  /** The user's meal preps, as last listed. */
  setPreps(state: LogFormPrepState): void;
  /** Picks a prep, as if it was chosen in the search, and puts the focus on its portion. */
  choosePrep(prep: Prep): void;
}

interface Sources {
  foods: boolean;
  preps: boolean;
}

function readSources(): Sources {
  try {
    const saved = JSON.parse(localStorage.getItem(SOURCES_KEY) ?? "null") as Partial<Sources> | null;
    const sources = { foods: saved?.foods !== false, preps: saved?.preps !== false };
    return sources.foods || sources.preps ? sources : { foods: true, preps: true };
  } catch {
    return { foods: true, preps: true };
  }
}

function saveSources(sources: Sources) {
  try {
    localStorage.setItem(SOURCES_KEY, JSON.stringify(sources));
  } catch {
    // Not kept: the next visit searches everything again.
  }
}

/**
 * Form for one diary entry. The food is found by searching the catalogue as you type (docs/FOOD_SEARCH.md), entered
 * as a custom food per 100 g / 100 ml, or is a portion of a meal prep (#55). Until something is chosen, only the
 * search shows, with the meal preps on hand under it. The fields then suit what was chosen: an amount and unit for a
 * food, or a share of the batch for a prep.
 */
export function createLogForm(
  catalog: FoodCatalog,
  onSubmit: (draft: LogDraft) => Promise<void>,
  defaultTime: () => Date = () => new Date(),
  prepActions?: LogFormPrepActions,
): LogForm {
  /** The chosen catalogue food, once its full nutrients have loaded. */
  let chosen: FoodItem | undefined;
  /** The custom-food row was chosen. */
  let custom = false;
  /** A chosen food whose nutrients are still loading. */
  let loading: string | undefined;
  /** The chosen meal prep. */
  let prep: Prep | undefined;
  let choice = 0;
  let saving = false;
  let offline = false;
  let prepState: LogFormPrepState = { available: false, preps: [], busy: new Set() };
  const sources = readSources();
  /** What is searched now: meal preps only where the site has them. */
  const searchesPreps = () => prepState.available && sources.preps;
  const searchesFoods = () => sources.foods || !searchesPreps();

  // Custom food fields, values per 100 g or 100 ml.
  const cName = el("input", { id: "c-name", type: "text", placeholder: "e.g. Homemade muesli", maxlength: 80 });
  const cBasis = el("select", { id: "c-basis" }, el("option", { value: "g" }, "per 100 g"), el("option", { value: "ml" }, "per 100 ml"));
  const cEnergy = numberInput("c-energy", "0", "1");
  const cEnergyUnit = el("select", { id: "c-energy-unit" }, el("option", { value: "kj" }, "kJ"), el("option", { value: "kcal" }, "kcal"));
  const cProtein = numberInput("c-protein", "0", "0.1");
  const cCarbs = numberInput("c-carbs", "0", "0.1");
  const cFat = numberInput("c-fat", "0", "0.1");
  const customFields = el(
    "fieldset",
    { class: "custom", hidden: true },
    el("legend", {}, "Custom food (values per 100)"),
    field("Name", cName),
    el("div", { class: "row" }, field("Basis", cBasis), field("Energy", cEnergy), field("Unit", cEnergyUnit)),
    el("div", { class: "row" }, field("Protein (g)", cProtein), field("Carbs (g)", cCarbs), field("Fat (g)", cFat)),
  );

  const amount = createAmountField({ id: "qty", unitId: "unit", placeholder: "e.g. 90 g", onChange: () => refreshPreview(), interpreter: amountAi });
  /** A food's amount, which a prep doesn't have. */
  const foodFields = el("div", {}, el("div", { class: "row" }, field("Amount", amount.input), field("Unit", amount.unitSelect)), amount.note);

  // A prep's fields: what is left of the batch, and how much of it to eat. A share, never a weight (docs/ARCHITECTURE.md section 4.5).
  const batchMeter = el("meter", { min: 0, max: 1 });
  const batchLeft = el("span", { class: "prep-left" });
  const batchAge = el("span", { class: "prep-age" });
  const portion = el("input", { id: "portion", type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "1/6, 25% or 0.25" });
  const eatRest = el("button", { type: "button", onclick: () => void eatPrep(true) }, "Eat the rest");
  const discard = el("button", { type: "button", onclick: () => void discardPrep() }, "Discard batch");
  const prepFields = el(
    "div",
    { class: "prep-fields", hidden: true },
    el("div", { class: "batch" }, el("span", {}, "Batch"), batchMeter, batchLeft, batchAge),
    el("div", { class: "row" }, el("div", { class: "field portion-field" }, el("span", {}, el("label", { for: "portion" }, "Portion")), portion)),
  );
  portion.addEventListener("input", () => refreshPreview());

  const mealSelect = el(
    "select",
    { id: "meal" },
    el("option", { value: "" }, "No meal"),
    ...MEAL_TYPES.map((m) => el("option", { value: m.value }, m.label)),
  );
  const time = el("input", { id: "time", type: "datetime-local", value: toDateTimeLocalValue(defaultTime()), required: true });
  const preview = el("p", { class: "preview", "aria-live": "polite" });
  const submit = el("button", { type: "submit", class: "primary" }, "Log entry");
  const prepButtons = el("span", { class: "actions", hidden: true }, eatRest, discard);
  const status = el("p", { class: "status", role: "status" });
  const offlineNote = el("p", { class: "status error", hidden: true }, "Logging needs a connection.");

  const sourceChips = {
    foods: el("button", { type: "button", class: "chip", onclick: () => toggleSource("foods") }, "Foods"),
    preps: el("button", { type: "button", class: "chip", onclick: () => toggleSource("preps") }, "Meal prep"),
  };
  const sourceBar = el("div", { class: "sources", role: "group", "aria-label": "Search in", hidden: true }, el("span", {}, "Search in"), sourceChips.foods, sourceChips.preps);
  const onHandList = el("ul", {});
  const onHand = el("div", { class: "on-hand", hidden: true }, el("p", { class: "on-hand-head" }, "Meal prep on hand"), onHandList);

  /** Everything after the search, shown once something is chosen. */
  const entryFields = el(
    "div",
    { class: "entry-fields", hidden: true },
    customFields,
    foodFields,
    prepFields,
    el("div", { class: "row" }, field("Meal", mealSelect), field("Time", time)),
    preview,
    el("div", { class: "actions" }, submit, prepButtons),
  );

  /** Changes when the search would find other preps, or show other amounts left. */
  const prepsKey = () => (searchesPreps() ? prepState.preps.map((p) => `${p.id}:${leftOf(p.portions)}:${p.name}`).join("|") : "");
  const prepBusy = () => (prep ? prepState.busy.has(prep.id) : false);

  const syncSubmit = () => {
    submit.disabled = saving || offline || prepBusy();
    submit.classList.toggle("saving", saving);
    eatRest.disabled = discard.disabled = saving || offline || prepBusy();
    offlineNote.hidden = !offline;
  };

  const currentFood = (): FoodItem | undefined => {
    if (!custom) return chosen;
    const basis = cBasis.value as BaseUnit;
    const energy = Number(cEnergy.value) || 0;
    return {
      ref: { source: "manual", id: "custom" },
      name: cName.value.trim() || "Custom food",
      basis,
      per100: {
        energyKcal: cEnergyUnit.value === "kj" ? kjToKcal(energy) : energy,
        nutrients: { protein: Number(cProtein.value) || 0, carbohydrates: Number(cCarbs.value) || 0, fat: Number(cFat.value) || 0 },
      },
      portions: [],
    };
  };

  const refreshUnits = () => {
    const food = currentFood();
    if (food) amount.show(food, defaultAmount);
    else amount.hideUnits();
  };

  /** The share of the prep typed, or why it can't be eaten. */
  const readPortion = (p: Prep): { fraction: number } | { problem: string } => {
    const left = leftOf(p.portions);
    const fraction = parseFraction(portion.value);
    if (fraction === undefined) return { problem: "Enter a share of the batch, such as 1/6, 25% or 0.25." };
    if (fraction > left + FRACTION_EPSILON) return { problem: `Only ${percent(left)} is left.` };
    return { fraction };
  };

  /** Why the entry cannot be logged as entered, if anything. */
  const validationError = (): string | undefined => {
    const read = amount.read();
    if (read.state === "problem") return read.message;
    if (custom) {
      const values = [cEnergy, cProtein, cCarbs, cFat].map((i) => Number(i.value));
      if (values.some((v) => !Number.isFinite(v) || v < 0)) return "Custom food values must be numbers of 0 or more.";
    }
    return undefined;
  };

  const refreshPrepPreview = (p: Prep) => {
    const left = leftOf(p.portions);
    batchMeter.value = left;
    batchMeter.setAttribute("aria-label", `${percent(left)} of ${p.name} left`);
    batchAge.textContent = madeAgo(p.createdAt, Date.now());
    const read = portion.value.trim() ? readPortion(p) : undefined;
    if (read && "fraction" in read) {
      batchLeft.textContent = `${percent(left)} left, then ${percent(left - read.fraction)}`;
      preview.textContent = `≈ ${summary(portionProfile(p.ingredients, read.fraction))}`;
    } else {
      batchLeft.textContent = `${percent(left)} left`;
      preview.textContent = read ? read.problem : `The rest ≈ ${summary(portionProfile(p.ingredients, left))}`;
    }
    preview.classList.toggle("error", Boolean(read && "problem" in read));
  };

  const refreshPreview = () => {
    if (prep) return refreshPrepPreview(prep);
    const food = currentFood();
    try {
      if (!food) throw new Error(loading ? `Loading ${loading}…` : "Search for a food, or choose “Custom food”.");
      const invalid = validationError();
      if (invalid) throw new Error(invalid);
      const read = amount.read();
      preview.textContent = read.state === "ok" ? `≈ ${summary(nutrientsForAmount(food, read.quantity, read.unit))}` : "…";
      preview.classList.remove("error");
    } catch (e) {
      preview.textContent = errorMessage(e);
      preview.classList.add("error");
    }
  };

  // The time follows the clock (on the viewed day) until the user picks one, so a page left open logs at "now".
  let timeTouched = false;
  time.addEventListener("input", () => (timeTouched = true));
  const chosenTime = () => (timeTouched ? new Date(time.value) : defaultTime());

  /** Shows the fields for what is chosen, or only the search and the preps on hand when nothing is. */
  const syncFields = () => {
    const hasChoice = Boolean(prep || chosen || custom || loading);
    entryFields.hidden = !hasChoice;
    customFields.hidden = !custom;
    // Disabled controls are skipped by form validation, so stale custom values can't block other foods.
    customFields.disabled = !custom;
    foodFields.hidden = Boolean(prep);
    prepFields.hidden = prepButtons.hidden = !prep;
    submit.textContent = prep ? "Log portion" : "Log entry";
    renderOnHand(hasChoice);
    syncSubmit();
  };

  const renderOnHand = (hasChoice = Boolean(prep || chosen || custom || loading)) => {
    const shown = searchesPreps() && !hasChoice && !combobox.input.value.trim() ? prepState.preps : [];
    onHand.hidden = shown.length === 0;
    const now = Date.now();
    replaceChildren(
      onHandList,
      shown.map((p) =>
        el(
          "li",
          {},
          el(
            "button",
            { type: "button", class: "on-hand-item", onclick: () => choosePrep(p) },
            el("span", { class: "on-hand-name" }, p.name),
            el("span", { class: "on-hand-detail" }, `${percent(leftOf(p.portions))} left · ${madeAgo(p.createdAt, now)}`),
          ),
        ),
      ),
    );
  };

  /** A new choice makes an earlier load error or "Logged" message stale. */
  const clearStatus = () => say("", false);

  function say(text: string, error: boolean, undo?: () => Promise<PrepOutcome>) {
    replaceChildren(status, text, undo && " ", undo && el("button", { type: "button", class: "link", onclick: () => void runUndo(undo) }, "Undo"));
    status.classList.toggle("error", error);
  }

  async function runUndo(undo: () => Promise<PrepOutcome>) {
    say("Bringing it back…", false);
    try {
      const outcome = await undo();
      say(outcome.text, outcome.error);
    } catch (e) {
      say(errorMessage(e), true);
    }
  }

  const refreshAll = () => {
    syncFields();
    refreshUnits();
    refreshPreview();
  };

  /** Forgets the choice, leaving the search empty. */
  const clearChoice = () => {
    choice++;
    chosen = undefined;
    loading = undefined;
    custom = false;
    prep = undefined;
    portion.value = "";
    combobox.reset();
    refreshAll();
  };

  function choosePrep(p: Prep) {
    clearStatus();
    choice++;
    chosen = undefined;
    loading = undefined;
    custom = false;
    prep = p;
    portion.value = "";
    combobox.showChoice(p.name);
    refreshAll();
    portion.focus();
  }

  const prepRows = (query: string): ComboExtra[] => {
    if (!searchesPreps()) return [];
    const q = query.trim().toLowerCase();
    const now = Date.now();
    return prepState.preps
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, MAX_PREP_HITS)
      .map((p) => ({ name: p.name, detail: `${percent(leftOf(p.portions))} left`, tag: "Meal prep", sub: madeAgo(p.createdAt, now), choose: () => choosePrep(p) }));
  };

  const combobox = createFoodCombobox(catalog, {
    id: "food",
    extras: prepRows,
    searchFoods: searchesFoods,
    onChoose: (hit) => {
      clearStatus();
      const mine = ++choice;
      chosen = undefined;
      custom = false;
      prep = undefined;
      loading = hit.summary.name;
      amount.clear();
      refreshAll();
      amount.input.focus();
      catalog.get(hit.summary.ref).then(
        (food) => {
          if (mine !== choice) return; // the user moved on
          loading = undefined;
          chosen = food;
          if (!food) say("That food is no longer in the catalogue. Search again.", false);
          refreshAll();
        },
        (e: unknown) => {
          if (mine !== choice) return;
          loading = undefined;
          log.error("Loading the chosen food failed", describeError(e));
          say(`Could not load ${hit.summary.name}: ${errorMessage(e)}`, true);
          refreshAll();
        },
      );
    },
    onCustom: (query) => {
      clearStatus();
      choice++;
      chosen = undefined;
      loading = undefined;
      prep = undefined;
      custom = true;
      if (query && !cName.value.trim()) cName.value = query;
      amount.clear();
      refreshAll();
      cName.focus();
    },
    onEdit: () => {
      clearStatus();
      choice++;
      chosen = undefined;
      loading = undefined;
      custom = false;
      prep = undefined;
      refreshAll();
    },
  });
  combobox.input.addEventListener("input", () => renderOnHand());
  customFields.addEventListener("input", () => {
    refreshUnits();
    refreshPreview();
  });

  const syncSources = () => {
    sourceBar.hidden = !prepState.available;
    for (const key of ["foods", "preps"] as const) {
      const chip = sourceChips[key];
      chip.setAttribute("aria-pressed", String(sources[key]));
      // One source always stays on, or there would be nothing to search.
      chip.disabled = sources[key] && !sources[key === "foods" ? "preps" : "foods"];
    }
    combobox.input.placeholder = !searchesPreps() ? "Search foods, e.g. weet bix" : searchesFoods() ? "Search foods and meal preps" : "Search meal preps";
  };

  function toggleSource(key: keyof Sources) {
    sources[key] = !sources[key];
    saveSources(sources);
    syncSources();
    renderOnHand();
    combobox.refresh();
  }

  async function eatPrep(rest: boolean) {
    const p = prep;
    if (!p || !prepActions || saving || offline || prepBusy()) return;
    const when = chosenTime();
    if (Number.isNaN(when.getTime())) return say("Enter a valid time.", true);
    let fraction: number | null = null;
    if (!rest) {
      const read = readPortion(p);
      if ("problem" in read) {
        say(read.problem, true);
        portion.focus();
        return;
      }
      fraction = read.fraction;
    }
    saving = true;
    syncSubmit();
    say("Saving to Google Health…", false);
    try {
      const outcome = await prepActions.eat(p, fraction, (mealSelect.value || undefined) as MealType | undefined, when);
      say(outcome.text, outcome.error);
      if (outcome.eaten) {
        portion.value = "";
        timeTouched = false;
        time.value = toDateTimeLocalValue(defaultTime());
        mealSelect.value = "";
      }
    } catch (e) {
      say(errorMessage(e), true);
    } finally {
      saving = false;
      syncSubmit();
      refreshPreview();
    }
  }

  async function discardPrep() {
    const p = prep;
    if (!p || !prepActions || saving || offline || prepBusy()) return;
    saving = true;
    syncSubmit();
    try {
      const outcome = await prepActions.discard(p);
      if (!outcome.error) clearChoice();
      say(outcome.text, outcome.error, outcome.undo);
    } catch (e) {
      say(errorMessage(e), true);
    } finally {
      saving = false;
      syncSubmit();
    }
  }

  const form = el(
    "form",
    // Every field is checked below: the browser's own check would stop Enter before the form can say why.
    { class: "log-form", novalidate: true },
    sourceBar,
    el("div", { class: "field" }, el("span", {}, el("label", { for: "food" }, "Food")), combobox.element),
    onHand,
    entryFields,
    offlineNote,
    status,
  );

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (prep) return eatPrep(false);
    // Enter leaves the focus in the field, so the typed unit has not moved yet.
    amount.settle();
    const food = currentFood();
    const when = chosenTime();
    const invalid = validationError() ?? (Number.isNaN(when.getTime()) ? "Enter a valid time." : undefined);
    const read = amount.read();
    if (food && !invalid && read.state === "typing") {
      // A model is reading the amount. Its answer only fills the fields, so logging it takes another Enter.
      clearStatus();
      return;
    }
    if (!food || invalid || read.state !== "ok") {
      say(invalid ?? (loading ? `Still loading ${loading}…` : "Search for a food first."), true);
      if (read.state === "problem" && read.inUnit) amount.unitSelect.focus();
      return;
    }
    saving = true;
    syncSubmit();
    say("Saving to Google Health…", false);
    try {
      await onSubmit({ food, quantity: read.quantity, unit: read.unit, ...(mealSelect.value ? { mealType: mealSelect.value as MealType } : {}), time: when });
      say(`Logged ${food.name}.`, false);
      amount.forgetTyping();
      timeTouched = false;
      time.value = toDateTimeLocalValue(defaultTime());
      mealSelect.value = "";
    } catch (e) {
      say(errorMessage(e), true);
    } finally {
      saving = false;
      syncSubmit();
    }
  });

  syncSources();
  refreshAll();
  return {
    element: form,
    setOffline: (value) => {
      offline = value;
      syncSubmit();
    },
    refreshPreview,
    refreshTime: () => {
      if (!timeTouched) time.value = toDateTimeLocalValue(defaultTime());
    },
    setPreps: (next) => {
      const before = prepsKey();
      prepState = next;
      if (prep) {
        const current = next.preps.find((p) => p.id === prep!.id);
        if (current) prep = current;
        else {
          // Finished or discarded, maybe on another device: there is nothing left to eat.
          const name = prep.name;
          const hadMessage = Boolean(status.textContent);
          clearChoice();
          if (!hadMessage) say(`Nothing is left of ${name}.`, false);
        }
      }
      syncSources();
      syncSubmit();
      // Called on every redraw of the app, so it leaves the food fields alone, and redraws only when the preps changed.
      if (prepsKey() !== before) {
        renderOnHand();
        combobox.refresh();
        if (prep) refreshPreview();
      }
    },
    choosePrep,
  };
}

function numberInput(id: string, min: string, step: string): HTMLInputElement {
  return el("input", { id, type: "number", min, step, value: "0", inputmode: "decimal" });
}
