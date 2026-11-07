/** The unit energy is shown in. Google Health stores kcal whichever is chosen, so this only affects the display. */
export type EnergyUnit = "kcal" | "kj";

const STORAGE_KEY = "foodDiary.energyUnit";

function readStored(): EnergyUnit {
  try {
    return localStorage.getItem(STORAGE_KEY) === "kj" ? "kj" : "kcal";
  } catch {
    return "kcal";
  }
}

let current = readStored();

export function getEnergyUnit(): EnergyUnit {
  return current;
}

export function setEnergyUnit(unit: EnergyUnit): void {
  current = unit;
  try {
    localStorage.setItem(STORAGE_KEY, unit);
  } catch {
    // Storage blocked: the choice lasts until the page is reloaded.
  }
}
