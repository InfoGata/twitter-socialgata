/**
 * Turns Nitter's rendered HTML into SocialGata posts and users.
 *
 * Everything here is pure (Document in, data out) so it can be tested against
 * saved pages. Nothing returned may point at the instance it came from: an
 * instance can disappear at any time, and posts outlive the page they were read
 * from (favorites, links). Media is rewritten to Twitter's own CDN and ids are
 * Twitter's tweet ids and handles.
 */

const TWITTER_ORIGIN = "https://x.com";
const PBS_ORIGIN = "https://pbs.twimg.com";

// Twitter/X epoch (2010-11-04T01:42:54.657Z) used to decode snowflake IDs
const TWITTER_EPOCH = 1288834974657;

/**
 * Tweet ids are snowflakes that encode their creation time, which is exact,
 * where the page only shows "55s" or a minute-precision date.
 */
export const snowflakeToISODate = (tweetId: string): string | undefined => {
  if (!/^\d+$/.test(tweetId)) return undefined;
  // Only the top 42 bits matter; Number precision loss falls below the shift.
  const ms = Math.floor(Number(tweetId) / 4194304) + TWITTER_EPOCH;
  const date = new Date(ms);
  return isNaN(date.getTime()) ? undefined : date.toISOString();
};

const decodeBase64 = (value: string): string | undefined => {
  try {
    return atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return undefined;
  }
};

/**
 * Rewrites an instance-relative media path to the CDN url it proxies.
 *
 * Nitter serves media through itself so readers never contact Twitter. Kept
 * as-is, every image would load from the instance -- through its bot check,
 * which an <img> cannot pass, and only for as long as the instance lives.
 * The forms seen in the wild:
 *
 * - `/pic/media%2FX.jpg%3Fname%3Dsmall`      -> pbs.twimg.com/media/X.jpg?name=small
 * - `/pic/orig/media%2FX.jpg`                -> pbs.twimg.com/media/X.jpg?name=orig
 * - `/pic/https%3A%2F%2Fpbs.twimg.com%2F...` -> that url
 * - `/pic/video.twimg.com%2F...`             -> https://video.twimg.com/...
 * - `/pic/enc/<base64>`, `/video/enc/<base64>` when the instance hides urls
 * - `/video/<hmac>/<encoded url>`
 */
export const unproxyMediaUrl = (src: string | null | undefined): string | undefined => {
  if (!src) return undefined;
  if (/^https?:\/\//.test(src) && !src.includes("/pic/") && !src.includes("/video/")) {
    return src;
  }

  let path = src.replace(/^https?:\/\/[^/]+/, "");

  if (path.startsWith("/video/")) {
    const rest = path.slice("/video/".length);
    if (rest.startsWith("enc/")) {
      return absolute(decodeBase64(rest.slice(4)));
    }
    // `/video/<hmac>/<url-encoded url>`: the url is everything after the hmac.
    const slash = rest.indexOf("/");
    if (slash < 0) return undefined;
    return absolute(safeDecode(rest.slice(slash + 1)));
  }

  if (!path.startsWith("/pic/")) return undefined;
  path = path.slice("/pic/".length);

  if (path.startsWith("enc/")) {
    return absolute(decodeBase64(path.slice(4)));
  }

  let orig = false;
  if (path.startsWith("orig/")) {
    orig = true;
    path = path.slice("orig/".length);
  }

  const decoded = safeDecode(path);
  if (!decoded) return undefined;
  const url = absolute(decoded);
  if (!url) return undefined;
  if (orig && !url.includes("?")) return `${url}?name=orig`;
  return url;
};

const safeDecode = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

/** A decoded media path, which may or may not carry its own scheme and host. */
const absolute = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  if (/^https?:\/\//.test(value)) return value;
  // `video.twimg.com/...`, `pbs.twimg.com/...`
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(value)) return `https://${value}`;
  // `media/X.jpg`, `profile_images/...`, `amplify_video_thumb/...`
  return `${PBS_ORIGIN}/${value.replace(/^\//, "")}`;
};

/** "1,234" -> 1234. Nitter prints full numbers, never "1.2K". */
const parseCount = (text: string | null | undefined): number => {
  const digits = (text || "").replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : 0;
};

const text = (el: Element | null | undefined): string =>
  el?.textContent?.trim() || "";

/**
 * The tweet's text. Nitter shortens external link text ("abs-cbn.com/news/…"),
 * so those anchors are swapped for their full href, which is what a reader
 * would want to click. Mentions and hashtags are instance-relative links and
 * keep their text.
 */
const contentText = (el: Element | null | undefined): string | undefined => {
  if (!el) return undefined;
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (/^https?:\/\//.test(href)) a.textContent = href;
  });
  const value = clone.textContent?.trim();
  return value || undefined;
};

const statusIdFrom = (href: string | null | undefined): string | undefined =>
  href?.match(/\/status\/(\d+)/)?.[1];

/** An instance-relative link (`/i/article/...`) as the same page on x.com. */
const outboundUrl = (href: string | null | undefined): string | undefined => {
  if (!href) return undefined;
  if (/^https?:\/\//.test(href)) return href;
  if (href.startsWith("/")) return `${TWITTER_ORIGIN}${href.replace(/#.*$/, "")}`;
  return undefined;
};

interface ParsedMedia {
  images: PostImage[];
  videoSources?: VideoSource[];
  videoPoster?: string;
}

/** Images, the video and GIFs in an `.attachments` block. */
const parseAttachments = (root: Element | null | undefined): ParsedMedia => {
  const media: ParsedMedia = { images: [] };
  if (!root) return media;

  root.querySelectorAll(".attachment").forEach((attachment) => {
    const video = attachment.querySelector("video");
    if (video) {
      const sources: VideoSource[] = [];
      video.querySelectorAll("source").forEach((source) => {
        const url = unproxyMediaUrl(source.getAttribute("src"));
        if (url) {
          sources.push({
            source: url,
            type: source.getAttribute("type") || guessVideoType(url),
          });
        }
      });
      // HLS playback puts the playlist on the element instead of a <source>.
      const dataUrl = unproxyMediaUrl(video.getAttribute("data-url"));
      if (dataUrl) sources.push({ source: dataUrl, type: guessVideoType(dataUrl) });
      if (sources.length === 0) {
        const download = unproxyMediaUrl(
          attachment.querySelector("a.video-download")?.getAttribute("href")
        );
        if (download) sources.push({ source: download, type: guessVideoType(download) });
      }
      if (sources.length > 0 && !media.videoSources) {
        media.videoSources = sources;
        media.videoPoster = unproxyMediaUrl(video.getAttribute("poster"));
      }
      return;
    }

    const still = attachment.querySelector("a.still-image");
    const img = attachment.querySelector("img");
    const url = unproxyMediaUrl(img?.getAttribute("src"));
    if (!url) return;
    media.images.push({
      url,
      fullUrl: unproxyMediaUrl(still?.getAttribute("href")) || url,
      caption: img?.getAttribute("alt") || undefined,
    });
  });

  return media;
};

const guessVideoType = (url: string): string =>
  /\.m3u8(\?|$)/.test(url) ? "application/x-mpegURL" : "video/mp4";

const applyMedia = (post: Post, media: ParsedMedia) => {
  if (media.images.length > 0) {
    post.images = media.images;
    post.thumbnailUrl = media.images[0].url;
  }
  if (media.videoSources) {
    post.isVideo = true;
    post.videoSources = media.videoSources;
    post.url = media.videoSources[0].source;
    if (media.videoPoster) post.thumbnailUrl = media.videoPoster;
  }
};

/** The quoted tweet embedded in a `.quote` block. */
const parseQuote = (quote: Element): Post | undefined => {
  const href = quote.querySelector("a.quote-link")?.getAttribute("href");
  const apiId = statusIdFrom(href);
  if (!apiId) return undefined;

  const handle = text(quote.querySelector(".username")).replace(/^@/, "");
  const post: Post = {
    apiId,
    authorApiId: handle || undefined,
    authorName: text(quote.querySelector(".fullname")) || handle || undefined,
    authorAvatar: unproxyMediaUrl(quote.querySelector("img.avatar")?.getAttribute("src")),
    body: contentText(quote.querySelector(".quote-text")),
    publishedDate: snowflakeToISODate(apiId),
    originalUrl: `${TWITTER_ORIGIN}/${handle || "i"}/status/${apiId}`,
  };
  applyMedia(post, parseAttachments(quote.querySelector(".quote-media-container")));
  return post;
};

/**
 * One tweet from a `.timeline-item` (or the `.main-tweet` of a status page).
 * Returns undefined for the non-tweet items timelines also use: "Load newest",
 * user results, deleted or unavailable tweets.
 */
export const parseTweet = (item: Element): Post | undefined => {
  if (item.classList.contains("show-more")) return undefined;
  if (item.querySelector(".profile-result")) return undefined;

  const link = item.querySelector(":scope > a.tweet-link")?.getAttribute("href");
  const dateLink = item.querySelector(".tweet-date a")?.getAttribute("href");
  const apiId = statusIdFrom(link) || statusIdFrom(dateLink);
  if (!apiId) return undefined;

  const body = item.querySelector(".tweet-body") || item;
  // Scope header lookups to the tweet's own header, not the quote's.
  const header = body.querySelector(".tweet-header") || body;
  const handle = text(header.querySelector(".username")).replace(/^@/, "");

  const post: Post = {
    apiId,
    authorApiId: handle || undefined,
    authorName: text(header.querySelector(".fullname")) || handle || undefined,
    authorAvatar: unproxyMediaUrl(header.querySelector("img.avatar")?.getAttribute("src")),
    body: contentText(body.querySelector(":scope > .tweet-content")),
    publishedDate: snowflakeToISODate(apiId),
    originalUrl: `${TWITTER_ORIGIN}/${handle || "i"}/status/${apiId}`,
  };

  // `.attachments` that are direct children belong to this tweet; a quoted
  // tweet's sit inside `.quote`.
  applyMedia(post, parseAttachments(body.querySelector(":scope > .attachments")));

  const card = body.querySelector(":scope > .card a.card-container");
  const cardUrl = outboundUrl(card?.getAttribute("href"));
  if (cardUrl && !post.url) post.url = cardUrl;
  if (card && !post.thumbnailUrl) {
    post.thumbnailUrl = unproxyMediaUrl(card.querySelector("img")?.getAttribute("src"));
  }

  const quote = body.querySelector(":scope > .quote");
  if (quote) {
    const quoted = parseQuote(quote);
    if (quoted) post.quotedPost = quoted;
  }

  body.querySelectorAll(":scope > .tweet-stats .tweet-stat").forEach((stat) => {
    const count = parseCount(stat.textContent);
    if (stat.querySelector(".icon-comment")) post.numOfComments = count;
    else if (stat.querySelector(".icon-heart")) post.score = count;
  });

  if (body.querySelector(".pinned")) post.stickied = true;

  return post;
};

/** Every tweet in a timeline, deduplicated (threads repeat tweets). */
export const parseTimeline = (doc: Document): Post[] => {
  const seen = new Set<string>();
  const posts: Post[] = [];
  doc.querySelectorAll(".timeline .timeline-item").forEach((item) => {
    const post = parseTweet(item);
    if (!post?.apiId || seen.has(post.apiId)) return;
    seen.add(post.apiId);
    posts.push(post);
  });
  return posts;
};

/** The cursor for the next page, from the last "Load more" link. */
export const parseNextCursor = (doc: Document): string | undefined => {
  const links = Array.from(doc.querySelectorAll(".show-more a[href*='cursor=']"));
  const href = links[links.length - 1]?.getAttribute("href");
  if (!href) return undefined;
  const query = href.slice(href.indexOf("?") + 1);
  return new URLSearchParams(query).get("cursor") || undefined;
};

export const parseProfile = (doc: Document, apiId: string): User | undefined => {
  const card = doc.querySelector(".profile-card");
  if (!card) return undefined;

  const handle = text(card.querySelector(".profile-card-username")).replace(/^@/, "") || apiId;
  const user: User = {
    apiId: handle,
    handle,
    name: text(card.querySelector(".profile-card-fullname")) || handle,
    avatar: unproxyMediaUrl(
      card.querySelector(".profile-card-avatar img")?.getAttribute("src")
    ),
    banner: unproxyMediaUrl(doc.querySelector(".profile-banner img")?.getAttribute("src")),
    bio: text(card.querySelector(".profile-bio")) || undefined,
    location:
      text(card.querySelector(".profile-location > span:last-child")) || undefined,
    website:
      card.querySelector(".profile-website a")?.getAttribute("href") || undefined,
    joinedDate:
      text(card.querySelector(".profile-joindate")).replace(/^Joined\s*/i, "") ||
      undefined,
    verified: !!card.querySelector(".verified-icon"),
  };

  card.querySelectorAll(".profile-statlist li").forEach((li) => {
    const count = parseCount(text(li.querySelector(".profile-stat-num")));
    if (li.classList.contains("posts")) user.tweetCount = count;
    else if (li.classList.contains("followers")) user.followerCount = count;
    else if (li.classList.contains("following")) user.followingCount = count;
    else if (li.classList.contains("likes")) user.likeCount = count;
  });

  return user;
};

export interface ParsedThread {
  post?: Post;
  /** Replies, each reply chain nested under its first tweet. */
  replies: Post[];
}

/**
 * A status page: the tweet, then reply threads. Each `.reply` block is one
 * chain -- a reply to the tweet, then replies to that reply -- so every later
 * tweet in a block is nested under the one before it.
 */
export const parseThread = (doc: Document, apiId: string): ParsedThread => {
  const mainItem = doc.querySelector(".main-tweet .timeline-item");
  const post = mainItem ? parseTweet(mainItem) : undefined;

  const replies: Post[] = [];
  const seen = new Set<string>([apiId]);
  doc.querySelectorAll(".replies .reply").forEach((thread) => {
    let parent: Post | undefined;
    thread.querySelectorAll(".timeline-item").forEach((item) => {
      const reply = parseTweet(item);
      if (!reply?.apiId || seen.has(reply.apiId)) return;
      seen.add(reply.apiId);
      if (parent) {
        reply.parentId = parent.apiId;
        parent.comments = [...(parent.comments || []), reply];
      } else {
        reply.parentId = apiId;
        replies.push(reply);
      }
      parent = reply;
    });
  });

  return { post, replies };
};

/**
 * What kind of page came back, so a broken or guarded instance is never read as
 * "no tweets". Nitter answers every request with a page, and a bot check, a
 * disabled feature and a rate limit all look like valid HTML.
 */
export type PageVerdict =
  | { kind: "ok" }
  | { kind: "empty" }
  | { kind: "not-found"; message: string }
  | { kind: "challenge"; guard: string }
  | { kind: "disabled"; message: string }
  | { kind: "broken"; message: string };

const CHALLENGES: [RegExp, string][] = [
  [/\/\.gandalf\/|<title>Gandalf</, "Gandalf"],
  [/\/__shield\//, "Shield"],
  [/id="anubis_challenge"/, "Anubis"],
  [/\/\.well-known\/r4fo-check\//, "r4fo"],
  [/DogWAF/, "DogWAF"],
  [/__galadriel|You seem like a bot/, "Aragorn"],
  [/<title>(Just a moment|Attention Required)|cf_chl_opt/, "Cloudflare"],
  [/<title>(Checking your browser|Checking you are not a bot|Making sure you)/i, "a bot check"],
];

export const classifyPage = (html: string, doc: Document): PageVerdict => {
  const isNitter =
    !!doc.querySelector(".timeline, .main-tweet, .profile-card, .error-panel, .timeline-container") ||
    /Search disabled/.test(doc.title);

  if (!isNitter) {
    const head = html.slice(0, 6000);
    for (const [pattern, guard] of CHALLENGES) {
      if (pattern.test(head)) return { kind: "challenge", guard };
    }
    return { kind: "broken", message: "the page was not a Nitter page" };
  }

  if (/Search disabled/.test(doc.title)) {
    return { kind: "disabled", message: "search is disabled on this instance" };
  }

  const error = text(doc.querySelector(".error-panel"));
  if (error) {
    // "User "x" not found", "Tweet not found": a real answer, not a fault.
    if (/not found|doesn't exist|has been suspended/i.test(error)) {
      return { kind: "not-found", message: error };
    }
    return { kind: "broken", message: error };
  }

  if (doc.querySelector(".timeline-none")) return { kind: "empty" };

  return { kind: "ok" };
};
