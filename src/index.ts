import { MessageType, UiMessageType } from "./shared";

const TWSTALKER_BASE_URL = "https://twstalker.com";

// Twitter/X epoch (2010-11-04T01:42:54.657Z) used to decode snowflake IDs
const TWITTER_EPOCH = 1288834974657;

// Tweet IDs are Twitter snowflakes that encode their creation time. Decoding
// the ID gives an exact ISO timestamp, which is far better than the relative
// "2 hours ago" text TWstalker renders (which can't be parsed into a Date).
const snowflakeToISODate = (tweetId: string): string | undefined => {
  try {
    if (!/^\d+$/.test(tweetId)) return undefined;
    // Only the top 42 bits (the timestamp) matter; the low 22 bits are
    // discarded, so any Number precision loss falls below the >> 22 shift and
    // does not affect the resulting millisecond value.
    const ms = Math.floor(Number(tweetId) / 4194304) + TWITTER_EPOCH;
    const date = new Date(ms);
    if (isNaN(date.getTime())) return undefined;
    return date.toISOString();
  } catch {
    return undefined;
  }
};

// Helper function to parse engagement counts like "2K", "1.5M", "362"
function parseEngagementCount(countStr: string): number {
  if (!countStr) return 0;

  const cleaned = countStr.trim();

  if (cleaned.includes("M")) {
    return Math.round(parseFloat(cleaned.replace("M", "")) * 1_000_000);
  }

  if (cleaned.includes("K")) {
    return Math.round(parseFloat(cleaned.replace("K", "")) * 1_000);
  }

  if (cleaned.includes("B")) {
    return Math.round(parseFloat(cleaned.replace("B", "")) * 1_000_000_000);
  }

  return parseInt(cleaned.replace(/,/g, "")) || 0;
}

// Parse HTML into a Document
const parseHTML = (html: string): Document => {
  const parser = new DOMParser();
  return parser.parseFromString(html, "text/html");
};

// Fetch HTML and parse it
const fetchHTML = async (url: string): Promise<Document> => {
  const response = await application.networkRequest(url);
  const html = await response.text();
  return parseHTML(html);
};

// Scrape posts from a document
// Extract a single Post from an `.activity-posts` container. A quoted tweet is
// nested as another `.activity-posts` block inside this container's
// `.activity-descp`; those nested blocks are stripped here so the extracted
// fields (body, media, metrics) describe only this tweet. The quoted tweet is
// parsed separately by the caller and attached as `quotedPost`.
const extractPostFromContainer = (postContainer: Element): Post | undefined => {
  // Work on a clone with any nested quoted tweets removed so queries below
  // never pick up the quoted tweet's author, text, image or metrics.
  const container = postContainer.cloneNode(true) as HTMLElement;
  container
    .querySelectorAll(".activity-posts")
    .forEach((nested) => nested.remove());

  const statusLink = container.querySelector('a[href*="/status/"]');
  const href = statusLink?.getAttribute("href");
  const match = href?.match(/\/status\/(\d+)/);
  if (!match) return undefined;
  const postId = match[1];

  // Extract author info from the h4 heading
  const authorHeading = container.querySelector("h4");
  const authorText = authorHeading?.textContent?.trim() || "";

  let authorName = "";
  let authorHandle = "";

  if (authorText.includes("@")) {
    const parts = authorText.split("@");
    authorName = parts[0]?.trim().replace(/Verified/g, "").trim() || "";
    authorHandle = parts[1]?.trim().split(/\s/)[0] || ""; // Take only the handle, not any text after it
  }

  // Skip if we couldn't extract author info
  if (!authorName && !authorHandle) return undefined;

  // Extract avatar
  const avatarImg = container.querySelector('img[alt*="Profile Picture"]');
  const authorAvatar = avatarImg?.getAttribute("src") ?? undefined;

  // Extract the post body. TWstalker puts the tweet text in an
  // `.activity-descp` element. Nested quoted tweets were already stripped
  // above, so the descp text is only this tweet's own text.
  let body = "";
  const descp = container.querySelector(".activity-descp");

  if (descp) {
    body = descp.textContent?.trim() || "";
  } else {
    // Fallback for pages without the expected structure: concatenate the
    // container's paragraphs, skipping timestamps.
    const allParagraphs = Array.from(container.querySelectorAll("p"));
    for (const p of allParagraphs) {
      const text = p.textContent?.trim() || "";

      if (
        text.match(
          /^(less than a minute ago|\d+\s*(hours?|minutes?|days?|seconds?)\s*ago)$/i
        )
      ) {
        continue;
      }

      if (text.length > 0) {
        body += text + "\n";
      }
    }
    body = body.trim();
  }

  // Derive an exact timestamp from the tweet's snowflake ID. Fall back to
  // the relative text TWstalker shows if the ID can't be decoded.
  const timeLinkText = statusLink?.textContent?.trim() || "";
  const relativeTime = timeLinkText.match(
    /^\d+\s*(hours?|minutes?|days?|seconds?)\s*ago|less than a minute ago/i
  )
    ? timeLinkText
    : "";
  const publishedDate = snowflakeToISODate(postId) || relativeTime || undefined;

  // Extract engagement metrics - look for links with numbers
  const metricLinks = container.querySelectorAll('a[href="#"]');
  let replies = 0,
    likes = 0;

  metricLinks.forEach((link, index) => {
    const text = link.textContent?.trim() || "";
    const count = parseEngagementCount(text);

    // Typically in order: replies, retweets, likes, views, bookmarks
    if (index === 0) replies = count;
    else if (index === 2) likes = count;
  });

  // Extract media
  const mediaImg = container.querySelector('img[alt*="tweet picture"]');
  const mediaVideo = container.querySelector('a[href*=".mp4"]');

  let mediaUrl: string | undefined;
  let mediaType: "image" | "video" | undefined;

  if (mediaVideo) {
    mediaUrl = mediaVideo.getAttribute("href") || undefined;
    mediaType = "video";
  } else if (mediaImg) {
    mediaUrl = mediaImg.getAttribute("src") || undefined;
    mediaType = "image";
  }

  return {
    apiId: postId,
    body: body || undefined,
    authorName: authorName,
    authorApiId: authorHandle,
    authorAvatar: authorAvatar,
    publishedDate: publishedDate,
    url: mediaUrl,
    thumbnailUrl: mediaType === "image" ? mediaUrl : undefined,
    score: likes,
    numOfComments: replies,
    originalUrl: `https://twitter.com/i/status/${postId}`,
  };
};

const scrapePostsFromDocument = (doc: Document): Post[] => {
  const posts: Post[] = [];

  // Find all post containers - they typically have links to status URLs
  const postElements = doc.querySelectorAll('a[href*="/status/"]');
  const processedIds = new Set<string>();

  postElements.forEach((statusLink) => {
    try {
      const href = statusLink.getAttribute("href");
      if (!href) return;

      // Extract post ID from URL like /username/status/1234567890
      const match = href.match(/\/status\/(\d+)/);
      if (!match) return;

      const postId = match[1];
      if (processedIds.has(postId)) return;
      processedIds.add(postId);

      // Find the main post container by going up to find the largest div with proper structure
      let postContainer = statusLink.parentElement;
      let attempts = 0;
      while (postContainer && attempts < 10) {
        // Look for a container that has both heading and content
        const hasHeading = postContainer.querySelector("h4");
        const hasParagraph = postContainer.querySelector("p");
        if (hasHeading && hasParagraph) {
          break;
        }
        postContainer = postContainer.parentElement;
        attempts++;
      }

      if (!postContainer) return;

      // A quoted tweet is a nested `.activity-posts` block inside another
      // post's `.activity-descp`. Skip it as a standalone post here — it is
      // attached to its parent below as `quotedPost`.
      if (postContainer.parentElement?.closest(".activity-posts")) return;

      const post = extractPostFromContainer(postContainer);
      if (!post) return;

      // Attach the quoted tweet (the first nested `.activity-posts` inside this
      // post's own `.activity-descp`), if any.
      const descp = postContainer.querySelector(".activity-descp");
      const quotedContainer = descp?.querySelector(".activity-posts");
      if (quotedContainer) {
        const quotedPost = extractPostFromContainer(quotedContainer);
        if (quotedPost) post.quotedPost = quotedPost;
      }

      posts.push(post);
    } catch (error) {
      console.error("Error parsing post:", error);
    }
  });

  return posts;
};

// Plugin Methods

const getTrendingTopics = async (
  request?: GetTrendingTopicsRequest
): Promise<GetTrendingTopicsResponse> => {
  try {
    const doc = await fetchHTML(`${TWSTALKER_BASE_URL}/united-states`);

    // Find all trending topic links
    const trendElements = doc.querySelectorAll('a[href*="/search/"]');
    const items: TrendingTopic[] = [];

    trendElements.forEach((element) => {
      const href = element.getAttribute("href");
      if (!href) return;

      // Extract topic name from heading or link text
      const heading = element.querySelector("h4");
      const name = heading?.textContent?.trim() || element.textContent?.trim();
      if (!name) return;

      items.push({
        name: name,
        url: `${TWSTALKER_BASE_URL}${href}`,
      });
    });

    // Remove duplicates by name
    const uniqueItems = Array.from(
      new Map(items.map((item) => [item.name, item])).values()
    );

    const limit = request?.limit ?? 20;
    const offset = request?.offset ?? 0;

    return {
      items: uniqueItems.slice(offset, offset + limit),
    };
  } catch (error) {
    console.error("Error fetching trending topics:", error);
    return { items: [] };
  }
};

const getTrendingTopicFeed = async (
  request: GetTrendingTopicFeedRequest
): Promise<GetTrendingTopicFeedResponse> => {
  try {
    const encodedTopic = encodeURIComponent(request.topicName);
    const url = `${TWSTALKER_BASE_URL}/search/${encodedTopic}`;
    const doc = await fetchHTML(url);

    const posts = scrapePostsFromDocument(doc);

    return {
      items: posts,
      topic: {
        name: request.topicName,
      },
    };
  } catch (error) {
    console.error("Error fetching trending topic feed:", error);
    return { items: [] };
  }
};

// Extract the CSS background-image URL from an inline style attribute
const extractBackgroundImageUrl = (
  style: string | null | undefined
): string | undefined => {
  if (!style) return undefined;
  const match = style.match(/background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
  return match?.[1];
};

// Scrape the full profile header (name, handle, bio, banner, stats, ...) from
// a TWstalker user page document.
const scrapeUserProfile = (doc: Document, apiId: string): User => {
  const profile: User = {
    apiId,
    name: apiId,
  };

  // Header block that holds the name, handle and bio/meta spans
  const header = doc.querySelector(".my-dash-dt");
  const h1 = header?.querySelector("h1") ?? doc.querySelector("h1");

  // Display name: the h1's text with the handle <span> and any verified <svg>
  // stripped out.
  if (h1) {
    const clone = h1.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("span, svg").forEach((el) => el.remove());
    const displayName = clone.textContent?.trim();
    if (displayName) profile.name = displayName;

    // Handle lives in the h1's <span>, e.g. "@damn_jehu"
    const handleSpan = h1.querySelector("span");
    const handle = handleSpan?.textContent?.trim().replace(/^@/, "");
    if (handle) profile.handle = handle;

    // Verified badge is an inline SVG with aria-label="Verified"
    profile.verified = !!h1.querySelector(
      'svg[aria-label="Verified"], svg[data-testid="icon-verified"]'
    );
  }

  // Bio and meta rows are the direct <span> children of the header (the handle
  // span is nested inside the h1, so it is excluded here).
  if (header) {
    const metaSpans = Array.from(header.children).filter(
      (el) => el.tagName === "SPAN"
    ) as HTMLElement[];

    for (const span of metaSpans) {
      const icon = span.querySelector("i");
      const text = span.textContent?.trim() || "";
      if (!text) continue;

      const iconClass = icon?.className || "";
      if (iconClass.includes("fa-map-marker")) {
        profile.location = text;
      } else if (iconClass.includes("fa-calendar")) {
        profile.joinedDate = text.replace(/^Joined\s*/i, "").trim();
      } else if (iconClass.includes("fa-link")) {
        const link = span.querySelector("a");
        profile.website = link?.getAttribute("href") || text;
      } else if (!icon && !profile.bio) {
        // First icon-less span is the bio
        profile.bio = text;
      }
    }
  }

  // Banner image (inline background-image on the header thumbnail)
  const bannerEl = doc.querySelector(".dash-bg-image1, .todo-thumb1");
  profile.banner = extractBackgroundImageUrl(
    bannerEl?.getAttribute("style")
  );

  // Avatar: prefer the large profile picture in the header
  const avatarImg =
    doc.querySelector(".my-dp-dash img") ||
    doc.querySelector('img[alt*="Profile Picture"]');
  profile.avatar = avatarImg?.getAttribute("src") ?? undefined;

  // Stats: Tweets / Followers / Following / Likes
  const statItems = doc.querySelectorAll(".right-details li");
  statItems.forEach((li) => {
    const label = li.querySelector(".dscun-txt")?.textContent?.trim().toLowerCase();
    const value = li.querySelector(".dscun-numbr")?.textContent?.trim() || "";
    if (!label) return;
    const count = parseEngagementCount(value);
    if (label.includes("tweet")) profile.tweetCount = count;
    else if (label.includes("follower")) profile.followerCount = count;
    else if (label.includes("following")) profile.followingCount = count;
    else if (label.includes("like")) profile.likeCount = count;
  });

  return profile;
};

const getUser = async (request: GetUserRequest): Promise<GetUserResponse> => {
  try {
    const url = `${TWSTALKER_BASE_URL}/${request.apiId}`;
    const doc = await fetchHTML(url);

    const user = scrapeUserProfile(doc, request.apiId);
    const posts = scrapePostsFromDocument(doc);

    return {
      user,
      items: posts,
    };
  } catch (error) {
    console.error("Error fetching user:", error);
    return { items: [] };
  }
};

const getFeed = async (
  _request?: GetFeedRequest
): Promise<GetFeedResponse> => {
  // Use trending topics feed as the default feed
  try {
    const trending = await getTrendingTopics({ limit: 1 });
    if (trending.items.length > 0) {
      const topTrend = trending.items[0];
      const feedResponse = await getTrendingTopicFeed({
        topicName: topTrend.name,
      });
      return {
        items: feedResponse.items,
      };
    }
    return { items: [] };
  } catch (error) {
    console.error("Error fetching feed:", error);
    return { items: [] };
  }
};

const search = async (request: SearchRequest): Promise<SearchResponse> => {
  try {
    const encodedQuery = encodeURIComponent(request.query);
    const url = `${TWSTALKER_BASE_URL}/search/${encodedQuery}`;
    const doc = await fetchHTML(url);

    const posts = scrapePostsFromDocument(doc);

    return {
      items: posts,
    };
  } catch (error) {
    console.error("Error searching:", error);
    return { items: [] };
  }
};

// UI Message handling
const sendMessage = (message: MessageType) => {
  application.postUiMessage(message);
};

const getInfo = async () => {
  sendMessage({
    type: "info",
  });
};

// Theme handling
const changeTheme = (theme: Theme) => {
  localStorage.setItem("vite-ui-theme", theme);
};

// Initialize plugin
const init = async () => {
  const theme = await application.getTheme();
  changeTheme(theme);
};

// Wire up plugin handlers
application.onGetFeed = getFeed;
application.onGetUser = getUser;
application.onSearch = search;
application.onGetTrendingTopics = getTrendingTopics;
application.onGetTrendingTopicFeed = getTrendingTopicFeed;
application.onGetPlatformType = async () => "microblog";

application.onUiMessage = async (message: UiMessageType) => {
  switch (message.type) {
    case "check-info":
      getInfo();
      break;
  }
};

application.onChangeTheme = async (theme: Theme) => {
  changeTheme(theme);
};

application.onPostLogin = init;
init();
