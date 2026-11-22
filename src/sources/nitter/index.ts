import type { TwitterSource } from "../types";
import { twstalker } from "../twstalker";
import { fetchNitter } from "./client";
import {
  parseNextCursor,
  parseProfile,
  parseThread,
  parseTimeline,
} from "./parse";

/**
 * Reads Twitter through public Nitter instances; see `client.ts` for how it
 * picks one and `instances.ts` for which.
 *
 * Nitter has no trending list, and TWstalker's still works (only its search
 * broke, on 2026-11-10), so trending topics come from there and each topic's
 * feed is a Nitter search.
 */

/**
 * No `getFeed`. Nitter has no home or trending timeline, and the feed used to
 * be a search (`min_faves:1000 lang:en -filter:replies`). When the search
 * instances broke on 2026-11-21 it showed an empty feed, so it was removed;
 * trending topics are the way in now.
 */

/**
 * Twitter's pagination cursors work on any instance (checked: the same cursor
 * on two instances returned the same page), so a page cursor carries the
 * instance that produced it only as a preference.
 */
const encodePage = (origin: string, cursor: string) => `${origin} ${cursor}`;

const decodePage = (
  page: string | number | undefined
): { prefer?: string; cursor?: string } => {
  if (typeof page !== "string" || !page) return {};
  const space = page.indexOf(" ");
  if (space < 0) return { cursor: page };
  return { prefer: page.slice(0, space), cursor: page.slice(space + 1) };
};

const withCursor = (path: string, cursor: string | undefined) => {
  if (!cursor) return path;
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}cursor=${encodeURIComponent(cursor)}`;
};

const searchPath = (query: string) =>
  `/search?f=tweets&q=${encodeURIComponent(query)}`;

const searchTweets = async (query: string, pageInfo?: PageInfo) => {
  const { prefer, cursor } = decodePage(pageInfo?.page);
  const { doc, instance, empty } = await fetchNitter(
    withCursor(searchPath(query), cursor),
    { needsSearch: true, prefer }
  );
  const items = empty ? [] : parseTimeline(doc);
  const next = items.length > 0 ? parseNextCursor(doc) : undefined;
  return {
    items,
    pageInfo: {
      page: pageInfo?.page,
      nextPage: next ? encodePage(instance.origin, next) : undefined,
    },
  };
};

const search = async (request: SearchRequest): Promise<SearchResponse> =>
  searchTweets(request.query, request.pageInfo);

const getTrendingTopicFeed = async (
  request: GetTrendingTopicFeedRequest
): Promise<GetTrendingTopicFeedResponse> => {
  const result = await searchTweets(request.topicName, request.pageInfo);
  return { ...result, topic: { name: request.topicName } };
};

const getUser = async (request: GetUserRequest): Promise<GetUserResponse> => {
  const handle = request.apiId.replace(/^@/, "");
  const { doc } = await fetchNitter(`/${encodeURIComponent(handle)}`);
  const items = parseTimeline(doc);
  const next = parseNextCursor(doc);
  return {
    user: parseProfile(doc, handle),
    items,
    pageInfo: next ? { nextPage: next } : undefined,
  };
};

const getComments = async (
  request: GetCommentsRequest
): Promise<GetCommentsResponse> => {
  const apiId = request.apiId;
  if (!apiId) return { items: [] };
  const { doc } = await fetchNitter(`/i/status/${encodeURIComponent(apiId)}`);
  const { post, replies } = parseThread(doc, apiId);
  return { post, items: replies };
};

export const nitter: TwitterSource = {
  id: "nitter",
  getUser,
  getComments,
  search,
  getTrendingTopics: twstalker.getTrendingTopics,
  getTrendingTopicFeed,
};
