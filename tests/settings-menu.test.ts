// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { el } from "../src/ui/dom";
import { createSettingsMenu } from "../src/ui/settings-menu";

const parts = (element: HTMLElement) => ({
  gear: element.querySelector<HTMLButtonElement>("button.settings-toggle")!,
  panel: element.querySelector<HTMLElement>(".settings-panel")!,
});

function mounted() {
  const menu = createSettingsMenu();
  const select = el("select", {}, el("option", { value: "kcal" }, "kcal"));
  const outside = el("button", { type: "button" }, "Sign out");
  menu.setItems([select]);
  document.body.append(menu.element, outside);
  return { menu, select, outside, ...parts(menu.element) };
}

afterEach(() => document.body.replaceChildren());

describe("the settings gear", () => {
  it("is a named button, with its panel closed until clicked", () => {
    const { gear, panel } = mounted();
    expect(gear.getAttribute("aria-label")).toBe("Settings");
    expect(gear.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
  });

  it("opens the panel on a click, focusing its first control, and closes on another", () => {
    const { gear, panel, select } = mounted();
    gear.click();
    expect(panel.hidden).toBe(false);
    expect(gear.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(select);
    gear.click();
    expect(panel.hidden).toBe(true);
  });

  it("closes on Escape and gives focus back to the gear", () => {
    const { menu, gear, panel, select } = mounted();
    menu.open();
    select.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(gear);
  });

  it("closes on a click outside, not inside", () => {
    const { menu, panel, select, outside } = mounted();
    menu.open();
    select.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(panel.hidden).toBe(false);
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(panel.hidden).toBe(true);
  });

  it("closes when focus moves outside", () => {
    const { menu, panel, outside } = mounted();
    menu.open();
    outside.focus();
    expect(panel.hidden).toBe(true);
  });

  it("is hidden when there is nothing to set", () => {
    const { menu } = mounted();
    menu.open();
    menu.setItems([false, undefined]);
    expect(menu.element.hidden).toBe(true);
    expect(menu.isOpen).toBe(false);
    menu.open();
    expect(menu.isOpen).toBe(false);
  });

  it("leaves the same controls where they are, so focus stays put", () => {
    const { menu, select } = mounted();
    menu.open();
    menu.setItems([select, false]);
    expect(document.activeElement).toBe(select);
    expect(menu.isOpen).toBe(true);
  });
});
