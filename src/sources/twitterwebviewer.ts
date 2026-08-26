import type { TwitterSource } from "./types";

/**
 * Reads twitterwebviewer.com's JSON API.
 *
 * Unlike [twstalker](./twstalker.ts) this is a real JSON API rather than scraped
 * markup, so it carries fields the scrape never could: exact timestamps, cursor
 * pagination, multi-image galleries, video variants and retweet attribution.
 *
 * The API rejects cross-origin browser fetches, so the plugin still needs
 * `requiresCorsDisabled` and the InfoGata extension. Note that plain `curl` gets
 * a Vercel "Security Checkpoint" 403/429 while the extension's Chrome fetch
 * passes without cookies — test against it through the extension, not curl.
 */

const API_BASE_URL = "https://api.twitterwebviewer.com";

/** Every endpoint wraps its payload in this envelope. */
type ApiEnvelope<T> = {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
};

type ApiAuthor = {
  username: string;
  displayName?: string;
  avatar?: string;
  verified?: boolean;
};

type ApiVideoVariant = {
  url: string;
  bitrate?: number;
  width?: number;
  height?: number;
};

type ApiMedia = {
  type: "image" | "video" | string;
  url: string;
  thumbnail?: string;
  videoUrl?: string;
  variants?: ApiVideoVariant[];
};

type ApiTweet = {
  id: string;
  author?: ApiAuthor;
  content?: string;
  createdAt?: string;
  timelineAt?: string;
  stats?: {
    likes?: number;
    retweets?: number;
    replies?: number;
    views?: number;
  };
  media?: ApiMedia[];
  quotedTweet?: ApiTweet;
  isPinned?: boolean;
  isRetweet?: boolean;
  retweetedBy?: string;
  originalTweetId?: string;
};

/** Shared shape of the paged list endpoints. */
type ApiTweetList = {
  tweets?: ApiTweet[];
  replies?: ApiTweet[];
  nextCursor?: string | null;
  hasNextPage?: boolean;
};

type ApiUser = {
  id: string;
  username: string;
  displayName?: string;
  bio?: string;
  avatar?: string;
  banner?: string;
  following?: number;
  followers?: number;
  tweets?: number;
  isProtected?: boolean;
  verified?: boolean;
  joined?: string;
};

/**
 * Fetches one endpoint and unwraps its envelope.
 *
 * Errors are thrown rather than swallowed into an empty list: an unreachable or
 * rate-limited source and a genuinely empty feed are different things, and
 * returning `[]` for both is what made the previous TWstalker outage look like
 * "No posts yet" instead of a broken source.
 */
const apiFetch = async <T>(path: string): Promise<T> => {
  const response = await application.networkRequest(`${API_BASE_URL}${path}`);
  const text = await response.text();

  let json: ApiEnvelope<T>;
  try {
    json = JSON.parse(text);
  } catch {
    // An HTML body here means an anti-bot interstitial rather than the API.
    throw new Error(
      `twitterwebviewer: expected JSON from ${path}, got ${response.status} ${response.statusText}`
    );
  }

  if (!json.success || !json.data) {
    throw new Error(
      json.error || `twitterwebviewer: request to ${path} failed`
    );
  }

  return json.data;
};

/** Appends a pagination cursor when the host passed one back to us. */
const withCursor = (path: string, pageInfo?: PageInfo): string => {
  const cursor = pageInfo?.page;
  if (!cursor) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}cursor=${encodeURIComponent(String(cursor))}`;
};

const toPageInfo = (
  list: ApiTweetList,
  request?: { pageInfo?: PageInfo }
): PageInfo => ({
  page: request?.pageInfo?.page,
  nextPage:
    list.hasNextPage && list.nextCursor ? list.nextCursor : undefined,
});

/**
 * The API returns Twitter's own date format ("Tue Aug 25 16:47:24 +0000 2026").
 * Normalise it to ISO so the host formats it the same way as every other plugin.
 */
const toISODate = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  if (isNaN(date.getTime())) return undefined;
  return date.toISOString();
};

/** Best quality first, so the host's player falls back down the list. */
const toVideoSources = (media: ApiMedia): VideoSource[] | undefined => {
  const variants = (media.variants ?? [])
    .filter((variant) => !!variant.url)
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

  const urls = variants.length
    ? variants.map((variant) => variant.url)
    : media.videoUrl
      ? [media.videoUrl]
      : [];

  if (!urls.length) return undefined;
  return urls.map((source) => ({ source, type: "video/mp4" }));
};

/**
 * Maps the attachments into gallery slides. A video slide carries its poster
 * frame as `url` and its playable sources alongside, which is what lets a mixed
 * photo/video tweet render in the order the author posted it.
 */
const toImages = (media: ApiMedia[] | undefined): PostImage[] | undefined => {
  if (!media?.length) return undefined;

  const images = media.flatMap((item): PostImage[] => {
    if (item.type === "video") {
      const poster = item.thumbnail || item.url;
      if (!poster) return [];
      const largest = (item.variants ?? [])
        .slice()
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
      return [
        {
          url: poster,
          width: largest?.width,
          height: largest?.height,
          videoSources: toVideoSources(item),
        },
      ];
    }

    if (!item.url) return [];
    return [{ url: item.url, fullUrl: item.url }];
  });

  return images.length ? images : undefined;
};

const tweetToPost = (tweet: ApiTweet): Post => {
  const media = tweet.media ?? [];
  const firstVideo = media.find((item) => item.type === "video");
  const images = toImages(media);

  // `images` is what the host renders; the post-level video fields are kept in
  // step for the single-video case so older render paths still work.
  const videoSources = firstVideo ? toVideoSources(firstVideo) : undefined;
  const thumbnailUrl = firstVideo
    ? firstVideo.thumbnail || firstVideo.url
    : media[0]?.url;

  const username = tweet.author?.username;

  return {
    apiId: tweet.id,
    body: tweet.content || undefined,
    authorName: tweet.author?.displayName || username,
    authorApiId: username,
    authorAvatar: tweet.author?.avatar,
    publishedDate: toISODate(tweet.createdAt ?? tweet.timelineAt),
    score: tweet.stats?.likes,
    numOfComments: tweet.stats?.replies,
    url: media[0]?.url,
    thumbnailUrl,
    images,
    isVideo: !!firstVideo,
    videoSources,
    stickied: tweet.isPinned,
    quotedPost: tweet.quotedTweet ? tweetToPost(tweet.quotedTweet) : undefined,
    originalUrl: username
      ? `https://twitter.com/${username}/status/${tweet.id}`
      : `https://twitter.com/i/status/${tweet.id}`,
  };
};

/**
 * The host prints `joinedDate` verbatim, so it has to read as a date rather than
 * be one — "July 2011", not an ISO timestamp.
 */
const toJoinedDate = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  if (isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
};

const userToProfile = (user: ApiUser): User => ({
  apiId: user.username,
  name: user.displayName || user.username,
  handle: user.username,
  avatar: user.avatar,
  banner: user.banner,
  bio: user.bio,
  joinedDate: toJoinedDate(user.joined),
  verified: user.verified,
  followerCount: user.followers,
  followingCount: user.following,
  tweetCount: user.tweets,
});

/**
 * There is no "everyone's timeline" endpoint, so the default feed is built from
 * search. `/api/tweets/trending` exists but returns a curated set that is months
 * stale (median ~6 months when measured), which makes a poor front page, so it
 * is offered as its own tab rather than the default.
 *
 * The query goes through to Twitter's own search, so its operators work:
 * `min_faves` is what turns "latest" into "latest worth reading".
 */
const FEED_TYPES: FeedType[] = [
  { id: "popular", displayName: "Popular" },
  { id: "top", displayName: "Top" },
  { id: "trending", displayName: "Trending" },
];

const DEFAULT_FEED_TYPE = "popular";

const FEED_QUERIES: Record<string, { query: string; sort: string }> = {
  popular: { query: "min_faves:1000 lang:en -filter:replies", sort: "latest" },
  top: { query: "min_faves:5000 lang:en -filter:replies", sort: "top" },
};

const getFeed = async (request?: GetFeedRequest): Promise<GetFeedResponse> => {
  const feedTypeId = request?.feedTypeId ?? DEFAULT_FEED_TYPE;
  const feedQuery = FEED_QUERIES[feedTypeId];

  const path = feedQuery
    ? `/api/search/tweets?q=${encodeURIComponent(feedQuery.query)}&sort=${feedQuery.sort}`
    : "/api/tweets/trending";

  const list = await apiFetch<ApiTweetList>(
    withCursor(path, request?.pageInfo)
  );

  return {
    items: (list.tweets ?? []).map(tweetToPost),
    pageInfo: toPageInfo(list, request),
    feedTypes: FEED_TYPES,
    feedTypeId,
  };
};

const getUser = async (request: GetUserRequest): Promise<GetUserResponse> => {
  const user = await apiFetch<ApiUser>(
    `/api/user/${encodeURIComponent(request.apiId)}`
  );

  // The timeline endpoint needs the numeric id the profile lookup just resolved.
  const list = await apiFetch<ApiTweetList>(
    withCursor(
      `/api/tweets/${encodeURIComponent(user.username)}?uid=${encodeURIComponent(user.id)}`
    )
  );

  return {
    user: userToProfile(user),
    items: (list.tweets ?? []).map(tweetToPost),
    pageInfo: toPageInfo(list),
  };
};

const search = async (request: SearchRequest): Promise<SearchResponse> => {
  const list = await apiFetch<ApiTweetList>(
    withCursor(
      `/api/search/tweets?q=${encodeURIComponent(request.query)}&sort=latest`,
      request.pageInfo
    )
  );

  return {
    items: (list.tweets ?? []).map(tweetToPost),
    pageInfo: toPageInfo(list, request),
  };
};

const getComments = async (
  request: GetCommentsRequest
): Promise<GetCommentsResponse> => {
  const apiId = request.apiId;
  if (!apiId) return { items: [] };

  const [tweet, list] = await Promise.all([
    apiFetch<ApiTweet>(`/api/tweet/${encodeURIComponent(apiId)}`),
    apiFetch<ApiTweetList>(
      `/api/tweet/${encodeURIComponent(apiId)}/replies`
    ),
  ]);

  return {
    post: tweetToPost(tweet),
    items: (list.replies ?? []).map((reply) => ({
      ...tweetToPost(reply),
      parentId: apiId,
    })),
    pageInfo: toPageInfo(list),
  };
};

/**
 * A topic is just a search term here. This is what the host calls when a reader
 * taps a hashtag inside a tweet, so it stays implemented even though the topic
 * *list* below is not.
 */
const getTrendingTopicFeed = async (
  request: GetTrendingTopicFeedRequest
): Promise<GetTrendingTopicFeedResponse> => {
  const response = await search({
    query: request.topicName,
    pageInfo: request.pageInfo,
  });

  return {
    items: response.items,
    pageInfo: response.pageInfo,
    topic: { name: request.topicName },
  };
};

/**
 * `getTrendingTopics` is deliberately absent: twitterwebviewer.com renders its
 * trending list client-side from an authenticated endpoint, so there is no
 * public list of topic names to read. `index.ts` therefore leaves
 * `onGetTrendingTopics` unregistered and SocialGata hides its Trending button —
 * while hashtags inside tweets still resolve through `getTrendingTopicFeed`.
 */
export const twitterWebViewer: TwitterSource = {
  id: "twitterwebviewer",
  getFeed,
  getUser,
  getComments,
  search,
  getTrendingTopicFeed,
};
