import { defaultAmount } from "../core/amount-text";
import { foodLabel, nutrientsForAmount, type FoodItem } from "../core/food";
import { MAX_NAME, batchProfile, type Prep, type PrepIngredient } from "../core/prep";
import { describeAmount } from "../core/units";
import { describeError, logger } from "../debug/log";
import type { FoodCatalog } from "../food/catalog";
import { createAmountField } from "./amount-field";
import { el, errorMessage, replaceChildren } from "./dom";
import { createFoodCombobox } from "./food-combobox";
import { field } from "./form-fields";
import { summary } from "./format";

const log = logger("prep-builder");

export interface PrepDraft {
  /** Set when editing a saved prep. */
  readonly id?: string;
  readonly name: string;
  readonly ingredients: readonly PrepIngredient[];
}

export interface PrepBuilder {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  /** Starts a new prep, or edits a saved one. A new prep picks up an unsaved draft. */
  open(prep?: Prep): void;
  close(): void;
  setOffline(offline: boolean): void;
  refreshPreview(): void;
}

export interface PrepBuilderOptions {
  readonly catalog: FoodCatalog;
  /** Where this user's unsaved draft is kept on this device, so a reload or an expired sign-in loses nothing. */
  readonly draftKey: () => string | undefined;
  readonly onSave: (draft: PrepDraft) => Promise<void>;
  readonly onClose: () => void;
}

/**
 * Records a recipe while cooking (#55): a name and its ingredients, each found by searching the
 * catalogue. Each ingredient keeps the nutrients worked out now. Custom foods are not offered yet.
 */
export function createPrepBuilder(opts: PrepBuilderOptions): PrepBuilder {
  let open = false;
  let editingId: string | undefined;
  let ingredients: PrepIngredient[] = [];
  let chosen: FoodItem | undefined;
  let loading: string | undefined;
  let choice = 0;
  let saving = false;
  let offline = false;

  const heading = el("h3", {});
  const name = el("input", { id: "prep-name", type: "text", maxlength: MAX_NAME, placeholder: "e.g. Chili con carne", autocomplete: "off" });
  const amount = createAmountField({ id: "prep-qty", unitId: "prep-unit", placeholder: "e.g. 500 g", onChange: () => refreshAdd() });
  const addButton = el("button", { type: "button" }, "Add ingredient");
  const addStatus = el("p", { class: "status", role: "status" });
  const list = el("ul", { class: "prep-ingredients" });
  const total = el("p", { class: "preview", "aria-live": "polite" });
  const save = el("button", { type: "button", class: "primary" }, "Save prep");
  const cancel = el("button", { type: "button" }, "Cancel");
  const status = el("p", { class: "status", role: "status" });

  const combobox = createFoodCombobox(opts.catalog, {
    id: "prep-food",
    onChoose: (hit) => {
      const mine = ++choice;
      chosen = undefined;
      loading = hit.summary.name;
      amount.clear();
      refreshAdd();
      amount.input.focus();
      opts.catalog.get(hit.summary.ref).then(
        (food) => {
          if (mine !== choice) return;
          loading = undefined;
          chosen = food;
          if (food) amount.show(food, defaultAmount);
          else setStatus(addStatus, "That food is no longer in the catalogue. Search again.", true);
          refreshAdd();
        },
        (e: unknown) => {
          if (mine !== choice) return;
          loading = undefined;
          log.error("Loading an ingredient failed", describeError(e));
          setStatus(addStatus, `Could not load ${hit.summary.name}: ${errorMessage(e)}`, true);
          refreshAdd();
        },
      );
    },
    onCustom: () => {
      choice++;
      chosen = undefined;
      loading = undefined;
      setStatus(addStatus, "Custom foods can't be added to a prep yet. Search for the food instead.", true);
      refreshAdd();
    },
    onEdit: () => {
      choice++;
      chosen = undefined;
      loading = undefined;
      setStatus(addStatus, "");
      amount.hideUnits();
      refreshAdd();
    },
  });

  function setStatus(target: HTMLElement, text: string, error = false) {
    target.textContent = text;
    target.classList.toggle("error", error);
  }

  function refreshAdd() {
    const read = amount.read();
    addButton.disabled = !chosen || read.state !== "ok";
    if (loading) setStatus(addStatus, `Loading ${loading}…`);
  }

  function persist() {
    const key = opts.draftKey();
    if (!key) return;
    try {
      if (!name.value.trim() && ingredients.length === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify({ ...(editingId ? { id: editingId } : {}), name: name.value, ingredients } satisfies PrepDraft));
    } catch {
      // Storage blocked: the draft lives only in the page.
    }
  }

  function readDraft(): PrepDraft | undefined {
    const key = opts.draftKey();
    if (!key) return undefined;
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as PrepDraft) : undefined;
    } catch {
      return undefined;
    }
  }

  function renderList() {
    replaceChildren(
      list,
      ...ingredients.map((ing, i) =>
        el(
          "li",
          {},
          el("span", { class: "prep-ingredient-name" }, ing.label),
          el("span", { class: "prep-ingredient-amount" }, describeAmount(ing.quantity, ing.unit)),
          el(
            "button",
            {
              type: "button",
              class: "icon",
              "aria-label": `Remove ${ing.label}`,
              title: "Remove ingredient",
              onclick: () => {
                ingredients = ingredients.filter((_, j) => j !== i);
                changed();
              },
            },
            "✕",
          ),
        ),
      ),
    );
    total.textContent = ingredients.length ? `Whole batch ≈ ${summary(batchProfile(ingredients))}` : "No ingredients yet.";
    syncSave();
  }

  function syncSave() {
    save.disabled = saving || offline || ingredients.length === 0 || !name.value.trim();
    save.classList.toggle("saving", saving);
  }

  function changed() {
    persist();
    renderList();
  }

  addButton.addEventListener("click", () => {
    amount.settle();
    const read = amount.read();
    if (!chosen || read.state !== "ok") return;
    ingredients = [...ingredients, { ref: chosen.ref, label: foodLabel(chosen), quantity: read.quantity, unit: read.unit, profile: nutrientsForAmount(chosen, read.quantity, read.unit) }];
    setStatus(addStatus, `Added ${chosen.name}.`);
    chosen = undefined;
    combobox.input.value = "";
    combobox.input.dispatchEvent(new Event("input", { bubbles: true }));
    amount.clear();
    amount.hideUnits();
    changed();
    combobox.input.focus();
  });
  name.addEventListener("input", () => {
    persist();
    syncSave();
  });

  save.addEventListener("click", async () => {
    const trimmed = name.value.trim();
    if (!trimmed || ingredients.length === 0) return;
    saving = true;
    syncSave();
    setStatus(status, "Saving…");
    try {
      await opts.onSave({ ...(editingId ? { id: editingId } : {}), name: trimmed, ingredients });
      const key = opts.draftKey();
      try {
        if (key) localStorage.removeItem(key);
      } catch {
        // Nothing was stored.
      }
      close();
    } catch (e) {
      setStatus(status, errorMessage(e), true);
    } finally {
      saving = false;
      syncSave();
    }
  });
  cancel.addEventListener("click", () => close());

  const element = el(
    "div",
    { class: "prep-builder", hidden: true },
    heading,
    field("Name", name),
    el("div", { class: "field" }, el("span", {}, el("label", { for: "prep-food" }, "Ingredient")), combobox.element),
    el("div", { class: "row" }, field("Amount", amount.input), field("Unit", amount.unitSelect)),
    amount.note,
    el("div", { class: "actions" }, addButton),
    addStatus,
    list,
    total,
    el("div", { class: "actions" }, save, cancel),
    status,
    el("p", { class: "hint" }, "Add what goes in, as it goes in. This is kept on this device until you save it. Nothing is logged until you eat some."),
  );

  function close() {
    open = false;
    element.hidden = true;
    opts.onClose();
  }

  return {
    element,
    get isOpen() {
      return open;
    },
    open(prep) {
      open = true;
      element.hidden = false;
      const draft = readDraft();
      // A draft belongs to the prep it was started for: a new prep, or the one being edited.
      const start: PrepDraft = prep ? (draft?.id === prep.id ? draft : prep) : draft && !draft.id ? draft : { name: "", ingredients: [] };
      editingId = prep?.id;
      heading.textContent = prep ? `Edit ${prep.name}` : "New prep";
      name.value = start.name;
      ingredients = [...start.ingredients];
      setStatus(status, prep ? "Changes apply to portions eaten from now on." : "");
      setStatus(addStatus, "");
      renderList();
      name.focus();
    },
    close,
    setOffline(value) {
      offline = value;
      syncSave();
    },
    refreshPreview: renderList,
  };
}
