import { MessageType, UiMessageType } from "./shared";

const pluginName = "twitter";
const TWSTALKER_BASE_URL = "https://twstalker.com";

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

      // Extract author info from the h4 heading
      const authorHeading = postContainer.querySelector("h4");
      const authorText = authorHeading?.textContent?.trim() || "";

      let authorName = "";
      let authorHandle = "";

      if (authorText.includes("@")) {
        const parts = authorText.split("@");
        authorName = parts[0]?.trim().replace(/Verified/g, "").trim() || "";
        authorHandle = parts[1]?.trim().split(/\s/)[0] || ""; // Take only the handle, not any text after it
      }

      // Skip if we couldn't extract author info
      if (!authorName && !authorHandle) return;

      // Extract avatar
      const avatarImg = postContainer.querySelector(
        'img[alt*="Profile Picture"]'
      );
      const authorAvatar = avatarImg?.getAttribute("src") ?? undefined;

      // Extract post body - find the first substantial paragraph after the heading
      const allParagraphs = Array.from(postContainer.querySelectorAll("p"));
      let body = "";

      for (const p of allParagraphs) {
        const text = p.textContent?.trim() || "";

        // Skip if it's just a timestamp
        if (
          text.match(
            /^(less than a minute ago|\d+\s*(hours?|minutes?|days?|seconds?)\s*ago)$/i
          )
        ) {
          continue;
        }

        // Skip if it's part of a quoted/nested tweet (has specific parent structure)
        const parentDiv = p.closest(
          'div[class*="quote"], div[class*="retweet"]'
        );
        if (parentDiv && parentDiv !== postContainer) {
          continue;
        }

        // Add non-empty, non-timestamp text
        if (text.length > 0) {
          body += text + "\n";
        }
      }

      body = body.trim();

      // Extract timestamp from the status link
      const timeLinkText = statusLink.textContent?.trim() || "";
      const timeText = timeLinkText.match(
        /^\d+\s*(hours?|minutes?|days?|seconds?)\s*ago|less than a minute ago/i
      )
        ? timeLinkText
        : "";

      // Extract engagement metrics - look for links with numbers
      const metricLinks = postContainer.querySelectorAll('a[href="#"]');
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
      const mediaImg = postContainer.querySelector('img[alt*="tweet picture"]');
      const mediaVideo = postContainer.querySelector('a[href*=".mp4"]');

      let mediaUrl: string | undefined;
      let mediaType: "image" | "video" | undefined;

      if (mediaVideo) {
        mediaUrl = mediaVideo.getAttribute("href") || undefined;
        mediaType = "video";
      } else if (mediaImg) {
        mediaUrl = mediaImg.getAttribute("src") || undefined;
        mediaType = "image";
      }

      // Always add the post if we have author info - body can be empty for media-only posts
      posts.push({
        apiId: postId,
        body: body || undefined,
        authorName: authorName,
        authorApiId: authorHandle,
        authorAvatar: authorAvatar,
        publishedDate: timeText || undefined,
        pluginId: pluginName,
        url: mediaUrl,
        thumbnailUrl: mediaType === "image" ? mediaUrl : undefined,
        score: likes,
        numOfComments: replies,
        originalUrl: `https://twitter.com/i/status/${postId}`,
      });
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

const getUser = async (request: GetUserRequest): Promise<GetUserResponse> => {
  try {
    const url = `${TWSTALKER_BASE_URL}/${request.apiId}`;
    const doc = await fetchHTML(url);

    // Extract user info
    const nameElement = doc.querySelector("h1");
    const nameText = nameElement?.textContent?.trim() || "";
    const nameParts = nameText.split("@");
    const displayName = nameParts[0]?.trim();

    // Extract avatar
    const avatarImg = doc.querySelector('img[alt*="Profile Picture"]');
    const avatar = avatarImg?.getAttribute("src") ?? undefined;

    const posts = scrapePostsFromDocument(doc);

    return {
      user: {
        apiId: request.apiId,
        name: displayName || request.apiId,
        avatar: avatar,
      },
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
