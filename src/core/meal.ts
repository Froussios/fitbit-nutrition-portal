/**
 * Saved meals: a named list of ingredients, logged as one diary entry under the meal's name. Unlike a meal prep, a
 * meal has nothing left to track: each log is one serving. Pure, and shared by the browser and the API.
 */

import { scaleProfile } from "./nutrients";
import { MAX_INGREDIENTS, type PrepIngredient } from "./prep";

/** The same shape as a prep's ID, so that both fit a diary entry ID. */
export const MEAL_ID = /^[a-z0-9]{8,16}$/;

export interface SavedMeal {
  readonly id: string;
  readonly name: string;
  readonly ingredients: readonly PrepIngredient[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The ingredient at another amount, in the same unit. Its nutrients scale with it. */
export function scaleIngredient(ingredient: PrepIngredient, quantity: number): PrepIngredient {
  if (quantity === ingredient.quantity) return ingredient;
  return { ...ingredient, quantity, profile: scaleProfile(ingredient.profile, quantity / ingredient.quantity) };
}

/**
 * A saved meal's ingredients, for adding to another meal: copied, not linked, so editing the first meal later
 * changes nothing in the second. `servings` scales every one of them.
 */
export function expandMeal(meal: Pick<SavedMeal, "ingredients">, servings: number): PrepIngredient[] {
  return meal.ingredients.map((i) => scaleIngredient(i, i.quantity * servings));
}

/** Why `count` more ingredients can't join a list of `have`, if they can't. */
export function tooManyIngredients(have: number, count: number): string | undefined {
  return have + count > MAX_INGREDIENTS ? `A meal can have up to ${MAX_INGREDIENTS} ingredients, and that would make ${have + count}.` : undefined;
}

/** Meals in the order they are offered: by name. */
export function byName(a: Pick<SavedMeal, "name">, b: Pick<SavedMeal, "name">): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}
