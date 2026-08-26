/**
 * Twitter/X has no usable public API, so this plugin reads from a third-party
 * mirror site. Those sites are short-lived — they get blocked, rate-limited or
 * taken down — so each one lives behind this interface in its own file and
 * `index.ts` picks the active one with a single constant. Swapping sources is
 * then a one-line change rather than a rewrite.
 *
 * The methods mirror the `application.on*` handlers exactly, so `index.ts` stays
 * a thin wiring layer with no per-source knowledge.
 */
export interface TwitterSource {
  /** Identifies the source in log messages. */
  readonly id: string;

  getFeed(request?: GetFeedRequest): Promise<GetFeedResponse>;
  getUser(request: GetUserRequest): Promise<GetUserResponse>;
  getComments(request: GetCommentsRequest): Promise<GetCommentsResponse>;
  search(request: SearchRequest): Promise<SearchResponse>;

  /**
   * Optional because not every mirror exposes a list of trending topics. When a
   * source leaves these out, `index.ts` skips registering the matching handler
   * and SocialGata hides its Trending button, rather than showing an empty page.
   */
  getTrendingTopics?(
    request?: GetTrendingTopicsRequest
  ): Promise<GetTrendingTopicsResponse>;
  getTrendingTopicFeed?(
    request: GetTrendingTopicFeedRequest
  ): Promise<GetTrendingTopicFeedResponse>;
}
