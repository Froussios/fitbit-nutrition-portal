/**
 * Runtime configuration.
 *
 * The OAuth client ID identifies this app to Google. It is public (not a
 * secret) and belongs to the app's single Google Cloud project, so end users
 * never create one. It is normally baked in at build time
 * (VITE_GOOGLE_CLIENT_ID); the setup screen is a fallback for development.
 */

/** Read the whole nutrition diary (all sources: the Google Health app, devices, other apps). */
export const NUTRITION_READ_SCOPE = "https://www.googleapis.com/auth/googlehealth.nutrition.readonly";
/** Create entries, and edit or delete the entries this app created. */
export const NUTRITION_WRITE_SCOPE = "https://www.googleapis.com/auth/googlehealth.nutrition.writeonly";

/** Adds an ID token to the sign-in: proof of who the user is, with no access to their data (DR-24). */
export const OPENID_SCOPE = "openid";

export const SCOPES = [OPENID_SCOPE, NUTRITION_READ_SCOPE, NUTRITION_WRITE_SCOPE] as const;

const CLIENT_ID_KEY = "foodDiary.clientId";

function builtInClientId(): string | undefined {
  return (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() || undefined;
}

export function getClientId(): string | undefined {
  const built = builtInClientId();
  if (built) return built;
  try {
    return localStorage.getItem(CLIENT_ID_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function isClientIdBuiltIn(): boolean {
  return builtInClientId() !== undefined;
}

export function setClientId(id: string): void {
  try {
    if (id.trim()) localStorage.setItem(CLIENT_ID_KEY, id.trim());
    else localStorage.removeItem(CLIENT_ID_KEY);
  } catch {
    // Storage blocked: nothing to persist.
  }
}
