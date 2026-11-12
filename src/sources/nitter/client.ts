import { PluginRequestError, sanitizeUrl, type PluginErrorCode } from "../../errors";
import { INSTANCES, type NitterInstance } from "./instances";
import { classifyPage } from "./parse";

/**
 * Fetches a Nitter page from whichever instance answers.
 *
 * Instances are volunteer-run and come and go, so a request walks the list
 * until one returns a real page:
 *
 * - The instance that last worked goes first. It keeps one instance in use
 *   rather than spreading every reader across all of them, and each new
 *   instance costs the reader an extension consent prompt and a pinned tab.
 * - One that fails is benched for a while, so a dead instance costs one slow
 *   request rather than one per page.
 * - Each instance gets a short time budget. A bot check that never clears would
 *   otherwise hold the request until the host's own timeout and leave no time
 *   to try anywhere else.
 * - "User not found" counts once a second instance agrees (or none other
 *   answers), since an instance in a bad moment says it about real accounts.
 * - When everything fails, the error names each instance and why.
 */

/** Long enough for a first visit: open the tab, clear a two-step check. */
const INSTANCE_TIMEOUT_MS = 20_000;
const COOLDOWN_MS = 30 * 60_000;

const HEALTH_KEY = "nitter-instance-health";
const PREFERRED_KEY = "nitter-preferred-instance";

type Health = Record<string, number>;

const readHealth = (): Health => {
  try {
    return JSON.parse(localStorage.getItem(HEALTH_KEY) || "{}") as Health;
  } catch {
    return {};
  }
};

const writeHealth = (health: Health) => {
  try {
    localStorage.setItem(HEALTH_KEY, JSON.stringify(health));
  } catch {
    // Storage is a convenience; without it every request starts from the top.
  }
};

const bench = (origin: string) => {
  const health = readHealth();
  health[origin] = Date.now() + COOLDOWN_MS;
  writeHealth(health);
};

const clearBench = (origin: string) => {
  const health = readHealth();
  if (origin in health) {
    delete health[origin];
    writeHealth(health);
  }
};

const readPreferred = (): string | undefined => {
  try {
    return localStorage.getItem(PREFERRED_KEY) || undefined;
  } catch {
    return undefined;
  }
};

const writePreferred = (origin: string) => {
  try {
    localStorage.setItem(PREFERRED_KEY, origin);
  } catch {
    // See writeHealth.
  }
};

/**
 * The order to try instances in: the preferred one, then the rest as listed,
 * with benched ones moved to the end rather than dropped -- if every instance
 * is benched, trying them anyway beats failing without a request.
 */
export const orderInstances = (
  instances: NitterInstance[],
  preferred: string | undefined,
  health: Health,
  now: number
): NitterInstance[] => {
  const sorted = [...instances].sort((a, b) => {
    if (a.origin === preferred) return -1;
    if (b.origin === preferred) return 1;
    return 0;
  });
  const ready = sorted.filter((i) => !(health[i.origin] > now));
  const benched = sorted.filter((i) => health[i.origin] > now);
  return [...ready, ...benched];
};

export interface NitterPage {
  doc: Document;
  instance: NitterInstance;
  /** "No items found" on an instance trusted to search. */
  empty: boolean;
}

export interface FetchOptions {
  /** Only instances whose search works. */
  needsSearch?: boolean;
  /** Try this instance first, e.g. the one that served the previous page. */
  prefer?: string;
}

interface Attempt {
  host: string;
  reason: string;
  code: PluginErrorCode;
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

const hostOf = (origin: string) => origin.replace(/^https?:\/\//, "");

const parseHTML = (html: string): Document =>
  new DOMParser().parseFromString(html, "text/html");

/**
 * `path` is everything after the origin, e.g. `/NASA` or `/search?f=tweets&q=x`.
 */
export const fetchNitter = async (
  path: string,
  options: FetchOptions = {}
): Promise<NitterPage> => {
  const candidates = INSTANCES.filter((i) => !options.needsSearch || i.search);
  const ordered = orderInstances(
    candidates,
    options.prefer || readPreferred(),
    readHealth(),
    Date.now()
  );

  const attempts: Attempt[] = [];
  let notFound: { message: string; url: string; origin: string } | undefined;

  for (const instance of ordered) {
    const url = `${instance.origin}${path}`;
    const host = hostOf(instance.origin);
    let status: number;
    let html: string;
    try {
      const response = await withTimeout(
        application.networkRequest(url),
        INSTANCE_TIMEOUT_MS
      );
      status = response.status;
      html = await withTimeout(response.text(), INSTANCE_TIMEOUT_MS);
    } catch (error) {
      bench(instance.origin);
      attempts.push({
        host,
        reason: (error as Error)?.message || "request failed",
        code: "network-error",
      });
      continue;
    }

    const doc = parseHTML(html);
    const verdict = classifyPage(html, doc);

    if (verdict.kind === "not-found") {
      // Usually a real answer, but an instance in a bad moment says it too:
      // nitter.catsarch.com once 404'd @NASA and served it a second later. So
      // it takes two instances agreeing, or no other instance answering, before
      // "not found" is final.
      if (notFound) {
        throw notFoundError(notFound.message, notFound.url);
      }
      notFound = { message: verdict.message, url, origin: instance.origin };
      attempts.push({ host, reason: verdict.message, code: "not-found" });
      continue;
    }

    if (verdict.kind === "ok" || verdict.kind === "empty") {
      if (status === 429) {
        // Some instances render a normal page with a 429 when their own
        // Twitter accounts are rate limited; the page has no tweets in it.
        bench(instance.origin);
        attempts.push({ host, reason: "rate limited", code: "rate-limited" });
        continue;
      }
      writePreferred(instance.origin);
      clearBench(instance.origin);
      // The instance that claimed "not found" was wrong.
      if (notFound) bench(notFound.origin);
      return { doc, instance, empty: verdict.kind === "empty" };
    }

    bench(instance.origin);
    if (verdict.kind === "challenge") {
      attempts.push({
        host,
        reason: `${verdict.guard} bot check did not clear`,
        code: "blocked",
      });
    } else if (status === 429) {
      attempts.push({ host, reason: "rate limited", code: "rate-limited" });
    } else if (status >= 500) {
      attempts.push({ host, reason: `server error ${status}`, code: "server-error" });
    } else {
      attempts.push({ host, reason: verdict.message, code: "invalid-response" });
    }
  }

  // Nobody else could check it, so the one answer stands.
  if (notFound) throw notFoundError(notFound.message, notFound.url);

  throw allFailed(path, attempts);
};

const notFoundError = (message: string, url: string) =>
  new PluginRequestError({
    code: "not-found",
    message,
    status: 404,
    requestUrl: sanitizeUrl(url),
  });

/** One error for the whole walk, coded by the most telling failure. */
const allFailed = (path: string, attempts: Attempt[]): PluginRequestError => {
  const codes = attempts.map((a) => a.code);
  const code: PluginErrorCode = codes.includes("blocked")
    ? "blocked"
    : codes.every((c) => c === "rate-limited")
      ? "rate-limited"
      : codes.every((c) => c === "network-error")
        ? "network-error"
        : "server-error";
  const detail = attempts.map((a) => `${a.host}: ${a.reason}`).join("; ");
  return new PluginRequestError({
    code,
    message: `No Nitter instance could load this page (${attempts.length} tried). ${detail}`,
    detail,
    requestUrl: path.split("?")[0],
  });
};
