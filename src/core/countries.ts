import type { FoodSource } from "./food";
import { TIME_ZONE_COUNTRIES } from "./time-zone-countries";

let zoneCountry: Map<string, string> | undefined;

/** The country a time zone is in ("Australia/Sydney" → "AU"); undefined for zones such as "UTC" that name no country. */
export function timeZoneCountry(timeZone: string): string | undefined {
  if (!zoneCountry) {
    zoneCountry = new Map();
    for (const [code, zones] of Object.entries(TIME_ZONE_COUNTRIES)) for (const z of zones.split(" ")) zoneCountry.set(z, code);
  }
  return zoneCountry.get(timeZone);
}

/** The region of a language tag ("en-AU" → "AU"); undefined when it has none ("en") or is not a country ("es-419"). */
export function languageCountry(tag: string): string | undefined {
  try {
    const region = new Intl.Locale(tag).region;
    return region && /^[A-Z]{2}$/.test(region) ? region : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which country the user is in, from what the browser already tells every page: the device's time zone first, else
 * the region of the first preferred language that has one. Undefined when neither says. No location permission,
 * no network request: it never leaves the device.
 *
 * The time zone goes first because it follows where the device is set to be, while a language is a preference, and
 * many devices outside the US say `en-US` (#42).
 */
export function detectCountry(timeZone: string | undefined, languages: readonly string[]): string | undefined {
  const fromZone = timeZone ? timeZoneCountry(timeZone) : undefined;
  if (fromZone) return fromZone;
  for (const tag of languages) {
    const fromLanguage = languageCountry(tag);
    if (fromLanguage) return fromLanguage;
  }
  return undefined;
}

let detected: { readonly country: string | undefined } | undefined;

/**
 * The user's country, worked out once per page load: ranking favours foods from it, and the dropdown prefers its
 * flag when a product lists several countries. Undefined when the browser gives no clue, and then no country is
 * favoured.
 */
export function userCountry(): string | undefined {
  if (!detected) {
    let timeZone: string | undefined;
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timeZone = undefined;
    }
    const languages = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
    detected = { country: detectCountry(timeZone, languages.filter(Boolean)) };
  }
  return detected.country;
}

/** Where each generic database's foods are from. Open Food Facts products list their own countries. */
const SOURCE_COUNTRY: Partial<Record<FoodSource, string>> = { afcd: "AU", ausnut: "AU", fndds: "US", usda: "US" };

/** The country a generic database's foods are from, if it is one country's. */
export function sourceCountry(source: FoodSource): string | undefined {
  return SOURCE_COUNTRY[source];
}

/** The countries a food is sold in or described for, as ISO 3166-1 alpha-2 codes; empty when unknown. */
export function foodCountries(food: { readonly ref: { readonly source: FoodSource }; readonly countries?: readonly string[] }): readonly string[] {
  if (food.countries?.length) return food.countries;
  const fromSource = SOURCE_COUNTRY[food.ref.source];
  return fromSource ? [fromSource] : [];
}

/** The country to show a flag for: the user's own when listed, else the first listed. */
export function shownCountry(countries: readonly string[], home: string | undefined = userCountry()): string | undefined {
  return home && countries.includes(home) ? home : countries[0];
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
