import type { FoodSource } from "./food";

/**
 * Where the user is, for now always Australia: ranking favours products sold here, and the dropdown prefers
 * this flag when a product lists several countries. To come from the client's locale: #42.
 */
export const HOME_COUNTRY = "AU";

/** Where each generic database's foods are from. Open Food Facts products list their own countries. */
const SOURCE_COUNTRY: Partial<Record<FoodSource, string>> = { afcd: "AU", ausnut: "AU", fndds: "US", usda: "US" };

/** The countries a food is sold in or described for, as ISO 3166-1 alpha-2 codes; empty when unknown. */
export function foodCountries(food: { readonly ref: { readonly source: FoodSource }; readonly countries?: readonly string[] }): readonly string[] {
  if (food.countries?.length) return food.countries;
  const fromSource = SOURCE_COUNTRY[food.ref.source];
  return fromSource ? [fromSource] : [];
}

/** The country to show a flag for: the user's own when listed, else the first listed. */
export function shownCountry(countries: readonly string[]): string | undefined {
  return countries.includes(HOME_COUNTRY) ? HOME_COUNTRY : countries[0];
}

/** The flag emoji for an ISO code ("AU" → 🇦🇺). Systems without flag glyphs show the two letters instead. */
export function flagEmoji(code: string): string {
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

let names: Intl.DisplayNames | undefined;

/** "AU" → "Australia"; the code itself if the browser doesn't know it. */
export function countryName(code: string): string {
  try {
    names ??= new Intl.DisplayNames(["en"], { type: "region" });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}
