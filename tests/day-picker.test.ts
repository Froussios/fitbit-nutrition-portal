// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createDayPicker } from "../src/ui/day-picker";

function setup() {
  const onPick = vi.fn();
  const picker = createDayPicker(onPick);
  document.body.replaceChildren(picker.element);
  const button = picker.element.querySelector("button")!;
  const field = picker.element.querySelector("input")!;
  return { onPick, picker, button, field };
}

function pick(field: HTMLInputElement, value: string) {
  field.value = value;
  field.dispatchEvent(new Event("change"));
}

describe("the day picker", () => {
  it("is an icon button with a name, and its field is out of the tab order", () => {
    const { button, field } = setup();
    expect(button.getAttribute("aria-label")).toBe("Choose a day");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(field.type).toBe("date");
    expect(field.tabIndex).toBe(-1);
  });

  it("opens the browser's picker on the viewed day, up to today", () => {
    const { picker, button, field } = setup();
    const showPicker = vi.fn();
    field.showPicker = showPicker;
    picker.update("2026-11-09", "2026-11-11");
    button.click();
    expect(showPicker).toHaveBeenCalledOnce();
    expect(field.value).toBe("2026-11-09");
    expect(field.max).toBe("2026-11-11");
  });

  it("reports a picked day", () => {
    const { onPick, picker, field } = setup();
    picker.update("2026-11-11", "2026-11-11");
    pick(field, "2026-10-01");
    expect(onPick).toHaveBeenCalledWith("2026-10-01");
  });

  it("ignores a cleared field and a day after today", () => {
    const { onPick, picker, field } = setup();
    picker.update("2026-11-11", "2026-11-11");
    pick(field, "");
    field.max = "2026-11-11";
    field.value = "2026-11-12";
    field.dispatchEvent(new Event("change"));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("survives a browser that cannot open the picker", () => {
    const { button, field } = setup();
    field.showPicker = () => {
      throw new DOMException("not allowed", "NotAllowedError");
    };
    expect(() => button.click()).not.toThrow();
  });
});
