import { PORTION_PREFIX, selectableUnits, type Measurable } from "../core/units";
import { el } from "./dom";

/** A food's named portions, then the units it can be measured in. */
export function unitOptions(food: Measurable): HTMLOptionElement[] {
  return [
    ...food.portions.map((p) => el("option", { value: PORTION_PREFIX + p.name }, `× ${p.name}`)),
    ...selectableUnits(food).map((u) => el("option", { value: u.key }, u.label)),
  ];
}

export function field(label: string, control: HTMLElement): HTMLElement {
  return el("label", { class: "field", for: control.id }, el("span", {}, label), control);
}
