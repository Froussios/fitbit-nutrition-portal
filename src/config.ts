/**
 * Runtime configuration. The OAuth client ID is public (it identifies the app,
 * not a secret), so it can be baked in at build time or typed in on the setup screen.
 */

/** The only nutrition scope the API publishes (discovery revision 20261030). */
export const NUTRITION_SCOPE = "https://www.googleapis.com/auth/googlehealth.nutrition.writeonly";

const CLIENT_ID_KEY = "foodDiary.clientId";
const EXTRA_SCOPES_KEY = "foodDiary.extraScopes";

function storageGet(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function storageSet(key: string, value: string | undefined): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked (private mode): the setting lasts for this page only.
  }
}

export function getClientId(): string | undefined {
  const built = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim();
  return built || storageGet(CLIENT_ID_KEY) || undefined;
}

export function isClientIdBuiltIn(): boolean {
  return Boolean((import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim());
}

export function setClientId(id: string | undefined): void {
  storageSet(CLIENT_ID_KEY, id?.trim());
}

/**
 * Extra scopes to request, space separated. Used for spikes, for example a
 * read scope if Google publishes one. An unknown scope makes sign-in fail.
 */
export function getExtraScopes(): string[] {
  return (storageGet(EXTRA_SCOPES_KEY) ?? "").split(/\s+/).filter(Boolean);
}

export function setExtraScopes(scopes: string): void {
  storageSet(EXTRA_SCOPES_KEY, scopes.trim());
}

export function requestedScopes(): string[] {
  return [NUTRITION_SCOPE, ...getExtraScopes().filter((s) => s !== NUTRITION_SCOPE)];
}
