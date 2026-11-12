/**
 * Errors the app can act on.
 *
 * SocialGata runs plugins in a sandboxed frame, and plugin-frame serializes a
 * rejection as `[...Object.keys(e), "message"].reduce(...)` — so only `message`
 * plus **own enumerable** properties reach the app. The class and its prototype
 * do not survive, which is why every field is assigned onto the instance and why
 * the app identifies these by the `isPluginError` flag rather than by type.
 *
 * Mirrors the app's own src/plugin-errors.ts. There's no shared runtime package
 * to import from yet (the typings package is types only).
 */

export type PluginErrorCode =
  | "blocked"
  | "forbidden"
  | "unauthorized"
  | "rate-limited"
  | "not-found"
  | "server-error"
  | "network-error"
  | "invalid-response"
  | "unknown";

interface PluginErrorFields {
  code: PluginErrorCode;
  message: string;
  status?: number;
  requestUrl?: string;
  detail?: string;
}

export class PluginRequestError extends Error {
  constructor(fields: PluginErrorFields) {
    super(fields.message);
    Object.assign(this, {
      isPluginError: true,
      name: "PluginRequestError",
      ...fields,
    });
  }
}

/** True for an error the host already classified, so it can be passed along. */
export const isPluginErrorLike = (
  value: unknown
): value is PluginErrorFields => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.isPluginError === true && typeof candidate.code === "string"
  );
};

/** Origin + pathname. The query carries search terms and, on the authenticated
 * host, identifiers, and this string ends up on screen. */
export const sanitizeUrl = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
};
