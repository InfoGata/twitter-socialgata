import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchNitter, orderInstances } from "../sources/nitter/client";
import { INSTANCES } from "../sources/nitter/instances";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", `${name}.html`), "utf8");

type Reply = { status: number; body: string } | Error;

/** Answers each instance origin with a canned reply; records what was asked. */
const stubInstances = (replies: Record<string, Reply>) => {
  const calls: string[] = [];
  const networkRequest = vi.fn(async (url: string) => {
    calls.push(url);
    const origin = new URL(url).origin;
    const reply = replies[origin] ?? new Error("unreachable");
    if (reply instanceof Error) throw reply;
    return new Response(reply.body, { status: reply.status });
  });
  vi.stubGlobal("application", { networkRequest });
  return calls;
};

const [first, second, third] = INSTANCES.map((i) => i.origin);

beforeEach(() => {
  localStorage.clear();
});

describe("orderInstances", () => {
  const now = 1_000;

  it("puts the preferred instance first and keeps the rest in order", () => {
    const order = orderInstances(INSTANCES, third, {}, now).map((i) => i.origin);
    expect(order.slice(0, 3)).toEqual([third, first, second]);
  });

  it("moves benched instances to the end instead of dropping them", () => {
    const order = orderInstances(INSTANCES, undefined, { [first]: now + 1 }, now);
    expect(order[order.length - 1].origin).toBe(first);
    expect(order).toHaveLength(INSTANCES.length);
  });

  it("lets a bench expire", () => {
    const order = orderInstances(INSTANCES, undefined, { [first]: now - 1 }, now);
    expect(order[0].origin).toBe(first);
  });
});

describe("fetchNitter", () => {
  it("falls through a bot check and a dead instance to one that works", async () => {
    const calls = stubInstances({
      [first]: { status: 200, body: fixture("gandalf") },
      [second]: new Error("Failed to fetch"),
      [third]: { status: 200, body: fixture("profile") },
    });

    const page = await fetchNitter("/NASA");

    expect(page.instance.origin).toBe(third);
    expect(calls.map((c) => new URL(c).origin)).toEqual([first, second, third]);
  });

  it("starts with the instance that last worked, and skips benched ones", async () => {
    stubInstances({
      [first]: { status: 200, body: fixture("gandalf") },
      [second]: new Error("Failed to fetch"),
      [third]: { status: 200, body: fixture("profile") },
    });
    await fetchNitter("/NASA");

    const calls = stubInstances({ [third]: { status: 200, body: fixture("profile") } });
    await fetchNitter("/NASA");

    expect(calls).toEqual([`${third}/NASA`]);
  });

  it("only asks instances that can search for a search", async () => {
    const calls = stubInstances({});
    await expect(fetchNitter("/search?f=tweets&q=x", { needsSearch: true })).rejects.toThrow();
    const searchable = INSTANCES.filter((i) => i.search).map((i) => i.origin);
    expect(new Set(calls.map((c) => new URL(c).origin))).toEqual(new Set(searchable));
  });

  it("believes 'user not found' once a second instance agrees", async () => {
    const calls = stubInstances({
      [first]: { status: 404, body: fixture("notfound") },
      [second]: { status: 404, body: fixture("notfound") },
      [third]: { status: 200, body: fixture("profile") },
    });
    await expect(fetchNitter("/thisuserdoesnotexist_zz9q")).rejects.toMatchObject({
      isPluginError: true,
      code: "not-found",
    });
    expect(calls).toHaveLength(2);
  });

  it("does not trust one instance's 'not found' when another serves the page", async () => {
    stubInstances({
      [first]: { status: 404, body: fixture("notfound") },
      [second]: { status: 200, body: fixture("profile") },
    });
    const page = await fetchNitter("/NASA");
    expect(page.instance.origin).toBe(second);

    // The instance that was wrong is benched.
    const calls = stubInstances({ [second]: { status: 200, body: fixture("profile") } });
    await fetchNitter("/NASA");
    expect(calls).toEqual([`${second}/NASA`]);
  });

  it("lets a lone 'not found' stand when no other instance answers", async () => {
    stubInstances({ [first]: { status: 404, body: fixture("notfound") } });
    await expect(fetchNitter("/thisuserdoesnotexist_zz9q")).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("does not read a rate-limited page as an empty timeline", async () => {
    stubInstances({
      [first]: { status: 429, body: fixture("profile") },
      [second]: { status: 200, body: fixture("profile") },
    });
    const page = await fetchNitter("/NASA");
    expect(page.instance.origin).toBe(second);
  });

  it("reports an empty search as empty, not as a failure", async () => {
    stubInstances({ [first]: { status: 200, body: fixture("search_empty") } });
    const page = await fetchNitter("/search?f=tweets&q=x", { needsSearch: true });
    expect(page.empty).toBe(true);
  });

  it("tries another instance when a search comes back empty", async () => {
    const [a, b] = INSTANCES.filter((i) => i.search).map((i) => i.origin);
    stubInstances({
      [a]: { status: 200, body: fixture("search_empty") },
      [b]: { status: 200, body: fixture("search_images") },
    });
    const page = await fetchNitter("/search?f=tweets&q=x", { needsSearch: true });
    expect(page.empty).toBe(false);
    expect(page.instance.origin).toBe(b);
  });

  it("names every instance and its reason when all of them fail", async () => {
    stubInstances({
      [first]: { status: 200, body: fixture("gandalf") },
      [second]: { status: 502, body: "<html>Bad gateway</html>" },
    });
    const error = await fetchNitter("/NASA").catch((e) => e);
    expect(error).toMatchObject({ isPluginError: true, code: "blocked" });
    expect(error.message).toContain(`${new URL(first).host}: Gandalf bot check did not clear`);
    expect(error.message).toContain(`${new URL(second).host}: server error 502`);
    expect(error.message).toContain(`(${INSTANCES.length} tried)`);
  });
});
