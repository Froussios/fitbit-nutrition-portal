import { afterEach, describe, expect, it, vi } from "vitest";
import { energyLabel, fmtEnergy, summary } from "../src/ui/format";

/** A fresh copy of the module, which reads storage when it loads. */
async function load(storage: unknown) {
  vi.stubGlobal("localStorage", storage);
  vi.resetModules();
  return import("../src/ui/energy-unit");
}

function fakeStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

afterEach(() => vi.unstubAllGlobals());

describe("energy unit setting", () => {
  it("defaults to kcal", async () => {
    expect((await load(fakeStorage())).getEnergyUnit()).toBe("kcal");
  });

  it("falls back to kcal on an unknown stored value", async () => {
    expect((await load(fakeStorage({ "foodDiary.energyUnit": "joules" }))).getEnergyUnit()).toBe("kcal");
  });

  it("remembers the choice across page loads", async () => {
    const storage = fakeStorage();
    (await load(storage)).setEnergyUnit("kj");
    expect((await load(storage)).getEnergyUnit()).toBe("kj");
  });

  it("still changes for this page when storage is blocked", async () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    const mod = await load({ getItem: blocked, setItem: blocked });
    expect(mod.getEnergyUnit()).toBe("kcal");
    mod.setEnergyUnit("kj");
    expect(mod.getEnergyUnit()).toBe("kj");
  });
});

describe("energy formatting", () => {
  it("shows the value in the chosen unit only", () => {
    expect(fmtEnergy(600, "kcal")).toBe("600");
    expect(fmtEnergy(600, "kj")).toBe("2,510");
    expect(energyLabel("kcal")).toBe("kcal");
    expect(energyLabel("kj")).toBe("kJ");
  });

  it("names one energy unit in the summary", () => {
    const profile = { energyKcal: 100, nutrients: { protein: 5 } };
    expect(summary(profile, "kcal")).toBe("100 kcal · protein 5 g · carbs – · fat –");
    expect(summary(profile, "kj")).toBe("418 kJ · protein 5 g · carbs – · fat –");
  });
});
