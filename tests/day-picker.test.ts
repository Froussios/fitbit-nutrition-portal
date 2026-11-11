// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createDayPicker, type DayPickerDays } from "../src/ui/day-picker";

function setup(initial: DayPickerDays = { day: "2026-11-11", today: "2026-11-11" }) {
  const onPick = vi.fn();
  let days = initial;
  const picker = createDayPicker(() => days, onPick);
  document.body.replaceChildren(picker.element);
  const button = picker.element.querySelector("button")!;
  const field = picker.element.querySelector("input")!;
  const showPicker = vi.fn();
  field.showPicker = showPicker;
  return { onPick, button, field, showPicker, setDays: (d: DayPickerDays) => (days = d) };
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
    const { button, field, showPicker } = setup({ day: "2026-11-09", today: "2026-11-11" });
    button.click();
    expect(showPicker).toHaveBeenCalledOnce();
    expect(field.value).toBe("2026-11-09");
    expect(field.max).toBe("2026-11-11");
  });

  it("reads the days again each time it opens, so a new today is offered after midnight", () => {
    const { button, field, setDays } = setup({ day: "2026-11-11", today: "2026-11-11" });
    button.click();
    setDays({ day: "2026-11-12", today: "2026-11-12" });
    button.click();
    expect(field.value).toBe("2026-11-12");
    expect(field.max).toBe("2026-11-12");
  });

  it("reports a picked day", () => {
    const { onPick, button, field } = setup();
    button.click();
    pick(field, "2026-10-01");
    expect(onPick).toHaveBeenCalledWith("2026-10-01");
  });

  it("ignores a cleared field and a day after today", () => {
    const { onPick, button, field } = setup();
    button.click();
    pick(field, "");
    pick(field, "2026-11-12");
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
