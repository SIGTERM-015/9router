import { createProviderConnection } from "@/models";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/db/index.js";

function normalizeReauthId(reauthConnectionId) {
  if (reauthConnectionId === undefined || reauthConnectionId === null || reauthConnectionId === "") {
    return { provided: false, id: null };
  }
  if (typeof reauthConnectionId !== "string") {
    return { provided: true, invalid: true, id: null };
  }
  const trimmed = reauthConnectionId.trim();
  if (!trimmed) {
    return { provided: false, id: null };
  }
  return { provided: true, invalid: false, id: trimmed };
}

/**
 * Validate an optional reauthConnectionId against the target provider.
 * Returns `{ ok: true, existing: null }` when no ID was provided.
 */
export async function validateReauthConnection(reauthConnectionId, expectedProvider) {
  const parsed = normalizeReauthId(reauthConnectionId);
  if (!parsed.provided) {
    return { ok: true, existing: null };
  }
  if (parsed.invalid) {
    return { ok: false, status: 400, error: "Invalid reauthConnectionId" };
  }

  const existing = await getProviderConnectionById(parsed.id);
  if (!existing) {
    return { ok: false, status: 404, error: "Connection to reauthenticate not found" };
  }

  if (existing.provider !== expectedProvider) {
    return {
      ok: false,
      status: 400,
      error: `Connection belongs to provider "${existing.provider}", expected "${expectedProvider}"`,
    };
  }

  const allowedAuthTypes = expectedProvider === "windsurf"
    ? ["oauth", "access_token", "api_key"]
    : ["oauth", "access_token"];
  if (!allowedAuthTypes.includes(existing.authType)) {
    return {
      ok: false,
      status: 400,
      error: "Connection does not use OAuth authentication",
    };
  }

  return { ok: true, existing };
}

/**
 * Persist OAuth credentials: updates `reauthConnectionId` in place when provided
 * (preserving user-configured name/proxy settings and resetting error state),
 * or delegates to `createProviderConnection` otherwise.
 */
export async function saveOAuthConnection(connectionData, reauthConnectionId) {
  const parsed = normalizeReauthId(reauthConnectionId);
  if (!parsed.provided) {
    return await createProviderConnection(connectionData);
  }

  const check = await validateReauthConnection(reauthConnectionId, connectionData.provider);
  if (!check.ok) {
    const err = new Error(check.error);
    err.status = check.status;
    throw err;
  }

  const existing = check.existing;
  const patch = {};

  for (const [key, value] of Object.entries(connectionData)) {
    if (key === "provider" || value === undefined) continue;
    if (key === "name" && existing.name) continue;
    if ((key === "email" || key === "displayName" || key === "name") && !value) continue;
    if (key === "providerSpecificData") {
      if (value && typeof value === "object") {
        patch.providerSpecificData = {
          ...(existing.providerSpecificData || {}),
          ...value,
        };
      }
      continue;
    }
    patch[key] = value;
  }

  const updated = await updateProviderConnection(existing.id, patch);
  if (!updated) {
    const err = new Error("Connection to reauthenticate not found");
    err.status = 404;
    throw err;
  }

  return updated;
}
