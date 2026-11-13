import { tooManyIngredients, type SavedMeal } from "../core/meal";
import { MAX_NAME, batchProfile, type PrepIngredient } from "../core/prep";
import type { FoodCatalog } from "../food/catalog";
import { el, errorMessage } from "./dom";
import { field } from "./form-fields";
import { summary } from "./format";
import { createIngredientAdder } from "./ingredient-adder";
import { createIngredientList } from "./ingredient-list";

export interface PrepDraft {
  /** Set when editing a saved prep or meal. */
  readonly id?: string;
  readonly name: string;
  readonly ingredients: readonly PrepIngredient[];
  /** The saved version's `updatedAt` when this draft of it began: if it has been saved since, the saved one wins. Server time, so device clocks don't matter. */
  readonly baseUpdatedAt?: number;
}

/** What the builder edits: a meal prep or a saved meal. */
export interface Recipe {
  readonly id: string;
  readonly name: string;
  readonly ingredients: readonly PrepIngredient[];
  readonly updatedAt: number;
}

export interface PrepBuilder {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  /** Starts a new one, or edits a saved one. A new one picks up an unsaved draft. */
  open(recipe?: Recipe): void;
  close(): void;
  setOffline(offline: boolean): void;
  refreshPreview(): void;
}

export interface PrepBuilderOptions {
  readonly catalog: FoodCatalog;
  /** A meal prep (#55), or a saved meal. Sets the words, and the fields' IDs. */
  readonly kind: "prep" | "meal";
  /** Where this user's unsaved draft (of a saved one, or of a new one) is kept on this device, so a reload or an expired sign-in loses nothing. */
  readonly draftKey: (id: string | undefined) => string | undefined;
  readonly onSave: (draft: PrepDraft) => Promise<void>;
  readonly onClose: () => void;
  /** Saved meals the search offers, each added as its ingredients. */
  readonly meals?: () => readonly SavedMeal[];
}

const WORDS = {
  prep: {
    new: "New prep",
    placeholder: "e.g. Chili con carne",
    save: "Save prep",
    editing: "Changes apply to portions eaten from now on.",
    total: "Whole batch",
    hint: "Add what goes in, as it goes in. This is kept on this device until you save it. Nothing is logged until you eat some.",
  },
  meal: {
    new: "New saved meal",
    placeholder: "e.g. Chicken burrito bowl",
    save: "Save meal",
    editing: "Changes apply to meals logged from now on.",
    total: "Whole meal",
    hint: "Kept on this device until you save it. Entries already in the diary keep their values.",
  },
} as const;

/**
 * Records a recipe: a name and its ingredients, each found by searching the catalogue, for a meal prep (#55) or a
 * saved meal. Each ingredient keeps the nutrients worked out when it was added. Custom foods are not offered yet.
 */
export function createPrepBuilder(opts: PrepBuilderOptions): PrepBuilder {
  const words = WORDS[opts.kind];
  const id = opts.kind;
  let open = false;
  let editingId: string | undefined;
  /** The saved version the draft started from, when editing. */
  let baseUpdatedAt: number | undefined;
  let saving = false;
  let offline = false;

  const heading = el("h3", {});
  const name = el("input", { id: `${id}-name`, type: "text", maxlength: MAX_NAME, placeholder: words.placeholder, autocomplete: "off" });
  const list = createIngredientList({ id: `${id}-amount`, mode: "edit", onChange: () => changed() });
  const adder = createIngredientAdder({
    catalog: opts.catalog,
    id: `${id}-ing`,
    placeholder: opts.meals ? "Search foods and saved meals" : "Search foods, e.g. weet bix",
    ...(opts.meals ? { meals: opts.meals } : {}),
    onAdd: (ingredients) => {
      const problem = tooManyIngredients(list.size, ingredients.length);
      if (problem) return problem;
      list.add(ingredients);
      changed();
      return undefined;
    },
  });
  const total = el("p", { class: "preview", "aria-live": "polite" });
  const save = el("button", { type: "button", class: "primary" }, words.save);
  const cancel = el("button", { type: "button" }, "Cancel");
  const status = el("p", { class: "status", role: "status" });

  function setStatus(text: string, error = false) {
    status.textContent = text;
    status.classList.toggle("error", error);
  }

  function persist() {
    const key = opts.draftKey(editingId);
    if (!key) return;
    try {
      const ingredients = list.snapshot();
      if (!name.value.trim() && ingredients.length === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify({ ...(editingId ? { id: editingId, baseUpdatedAt } : {}), name: name.value, ingredients } satisfies PrepDraft));
    } catch {
      // Storage blocked: the draft lives only in the page.
    }
  }

  function forgetDraft(key: string | undefined) {
    try {
      if (key) localStorage.removeItem(key);
    } catch {
      // Nothing was stored.
    }
  }

  function readDraft(recipeId: string | undefined): PrepDraft | undefined {
    const key = opts.draftKey(recipeId);
    if (!key) return undefined;
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as PrepDraft) : undefined;
    } catch {
      return undefined;
    }
  }

  function showTotal() {
    const read = list.read();
    total.textContent = read.problem ?? (read.ingredients.length ? `${words.total} ≈ ${summary(batchProfile(read.ingredients))}` : "No ingredients yet.");
    total.classList.toggle("error", Boolean(read.problem));
    syncSave();
  }

  function syncSave() {
    const read = list.read();
    save.disabled = saving || offline || read.ingredients.length === 0 || Boolean(read.problem) || !name.value.trim();
    save.classList.toggle("saving", saving);
  }

  function changed() {
    persist();
    showTotal();
  }

  name.addEventListener("input", () => {
    persist();
    syncSave();
  });

  save.addEventListener("click", async () => {
    const trimmed = name.value.trim();
    const read = list.read();
    if (!trimmed || read.ingredients.length === 0 || read.problem) return;
    saving = true;
    syncSave();
    setStatus("Saving…");
    try {
      await opts.onSave({ ...(editingId ? { id: editingId } : {}), name: trimmed, ingredients: read.ingredients });
      forgetDraft(opts.draftKey(editingId));
      close();
    } catch (e) {
      setStatus(errorMessage(e), true);
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
    el("p", { class: "ingredients-head" }, "Ingredients"),
    list.element,
    adder.element,
    total,
    el("div", { class: "actions" }, save, cancel),
    status,
    el("p", { class: "hint" }, words.hint),
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
    open(recipe) {
      open = true;
      element.hidden = false;
      // Each one, and the new one, has its own draft. One saved since its draft (here or on another device) wins.
      let draft = readDraft(recipe?.id);
      if (draft && recipe && draft.baseUpdatedAt !== recipe.updatedAt) {
        draft = undefined;
        forgetDraft(opts.draftKey(recipe.id));
      }
      const start: PrepDraft = draft ?? recipe ?? { name: "", ingredients: [] };
      editingId = recipe?.id;
      baseUpdatedAt = recipe?.updatedAt;
      adder.reset();
      heading.textContent = recipe ? `Edit ${recipe.name}` : words.new;
      name.value = start.name;
      list.set(start.ingredients);
      const restored = draft ? "Restored your unsaved changes. " : "";
      setStatus(`${restored}${recipe ? words.editing : ""}`.trim());
      showTotal();
      name.focus();
    },
    close,
    setOffline(value) {
      offline = value;
      syncSave();
    },
    refreshPreview() {
      list.refresh();
      showTotal();
    },
  };
}
