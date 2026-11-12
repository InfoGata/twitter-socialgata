import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPage,
  parseNextCursor,
  parseProfile,
  parseThread,
  parseTimeline,
  unproxyMediaUrl,
} from "../sources/nitter/parse";

/** Pages saved from live instances on 2026-11-12. */
const load = (name: string) => {
  const html = readFileSync(join(__dirname, "fixtures", `${name}.html`), "utf8");
  return { html, doc: new DOMParser().parseFromString(html, "text/html") };
};

const allMediaUrls = (posts: Post[]): string[] =>
  posts.flatMap((p) => [
    p.authorAvatar,
    p.thumbnailUrl,
    p.url,
    ...(p.images || []).flatMap((i) => [i.url, i.fullUrl]),
    ...(p.videoSources || []).map((v) => v.source),
    ...(p.quotedPost ? allMediaUrls([p.quotedPost]) : []),
  ]).filter((u): u is string => !!u);

describe("unproxyMediaUrl", () => {
  it.each([
    [
      "/pic/media%2FHW525iIbQAA4IYz.jpg%3Fname%3Dsmall%26format%3Dwebp",
      "https://pbs.twimg.com/media/HW525iIbQAA4IYz.jpg?name=small&format=webp",
    ],
    ["/pic/orig/media%2FHW525iIbQAA4IYz.jpg", "https://pbs.twimg.com/media/HW525iIbQAA4IYz.jpg?name=orig"],
    [
      "/pic/profile_images%2F1478215206480220160%2FFLAdE0bS_bigger.jpg",
      "https://pbs.twimg.com/profile_images/1478215206480220160/FLAdE0bS_bigger.jpg",
    ],
    [
      "/pic/https%3A%2F%2Fpbs.twimg.com%2Fprofile_banners%2F11348282%2F1788992290%2F1500x500",
      "https://pbs.twimg.com/profile_banners/11348282/1788992290/1500x500",
    ],
    [
      "/pic/video.twimg.com%2Ftweet_video%2FABC.mp4",
      "https://video.twimg.com/tweet_video/ABC.mp4",
    ],
    [
      "/video/92F3B61C69924/https%3A%2F%2Fvideo.twimg.com%2Famplify_video%2F1%2Fvid%2Fa.mp4%3Ftag%3D29",
      "https://video.twimg.com/amplify_video/1/vid/a.mp4?tag=29",
    ],
    [`/pic/enc/${btoa("media/X.jpg")}`, "https://pbs.twimg.com/media/X.jpg"],
    ["https://video.twimg.com/a.mp4?tag=29", "https://video.twimg.com/a.mp4?tag=29"],
  ])("%s", (input, expected) => {
    expect(unproxyMediaUrl(input)).toBe(expected);
  });

  it("drops what it cannot place", () => {
    expect(unproxyMediaUrl("/about")).toBeUndefined();
    expect(unproxyMediaUrl(undefined)).toBeUndefined();
  });
});

describe("parseTimeline", () => {
  it("reads every tweet on a profile, with no instance urls left", () => {
    const { doc } = load("profile");
    const posts = parseTimeline(doc);
    expect(posts).toHaveLength(20);
    for (const post of posts) {
      expect(post.apiId).toMatch(/^\d+$/);
      expect(post.authorApiId).toBeTruthy();
      expect(post.authorName).toBeTruthy();
      expect(post.publishedDate).toMatch(/^20\d\d-/);
      expect(post.originalUrl).toBe(
        `https://x.com/${post.authorApiId}/status/${post.apiId}`
      );
    }
    for (const url of allMediaUrls(posts)) {
      expect(url).toMatch(/^https:\/\/(pbs|video)\.twimg\.com\/|^https?:\/\/(?!nitter)/);
      expect(url).not.toContain("privacyredirect");
    }
  });

  it("reads images with a full-size version", () => {
    const posts = parseTimeline(load("search_images").doc);
    const withImages = posts.filter((p) => p.images?.length);
    expect(withImages.length).toBeGreaterThan(10);
    const image = withImages[0].images![0];
    expect(image.url).toMatch(/^https:\/\/pbs\.twimg\.com\/media\//);
    expect(image.fullUrl).toMatch(/name=orig$/);
    expect(withImages[0].thumbnailUrl).toBe(image.url);
  });

  it("reads videos as playable mp4 sources with a poster", () => {
    const posts = parseTimeline(load("search_videos").doc);
    const videos = posts.filter((p) => p.isVideo);
    expect(videos.length).toBeGreaterThan(5);
    expect(videos[0].videoSources![0]).toEqual({
      source: expect.stringMatching(/^https:\/\/video\.twimg\.com\/.+\.mp4/),
      type: "video/mp4",
    });
    expect(videos[0].thumbnailUrl).toMatch(/^https:\/\/pbs\.twimg\.com\//);
  });

  it("embeds a quoted tweet instead of listing it separately", () => {
    const posts = parseTimeline(load("search_quotes").doc);
    const quoting = posts.filter((p) => p.quotedPost);
    expect(quoting.length).toBeGreaterThan(5);
    const { quotedPost } = quoting[0];
    expect(quotedPost!.apiId).toMatch(/^\d+$/);
    expect(quotedPost!.apiId).not.toBe(quoting[0].apiId);
    expect(quotedPost!.authorApiId).toBeTruthy();
    // The quote's text and media must not leak into the quoting tweet.
    expect(quoting[0].body || "").not.toContain(quotedPost!.body || "\u0000");
  });

  it("reads like and reply counts from the stat icons", () => {
    const posts = parseTimeline(load("search_quotes").doc);
    expect(posts.some((p) => (p.score ?? 0) > 0)).toBe(true);
  });

  it("writes external links out in full rather than Nitter's shortened text", () => {
    const posts = parseTimeline(load("search_images").doc);
    const bodies = posts.map((p) => p.body || "").join("\n");
    expect(bodies).not.toMatch(/…(\s|$)/);
    expect(bodies).toMatch(/https?:\/\/\S+/);
  });

  it("skips 'Load newest' and 'more replies' items", () => {
    const posts = parseTimeline(load("profile_page2").doc);
    expect(posts.length).toBe(13);
    expect(posts.every((p) => p.apiId)).toBe(true);
  });
});

describe("parseNextCursor", () => {
  it("reads the cursor from a profile and a search", () => {
    expect(parseNextCursor(load("profile").doc)).toMatch(/^[A-Za-z0-9_=-]{20,}$/);
    expect(parseNextCursor(load("search_images").doc)).toBeTruthy();
  });

  it("has none on an empty search", () => {
    expect(parseNextCursor(load("search_empty").doc)).toBeUndefined();
  });
});

describe("parseProfile", () => {
  it("reads the profile card", () => {
    const user = parseProfile(load("profile").doc, "NASA")!;
    expect(user).toMatchObject({
      apiId: "NASA",
      handle: "NASA",
      name: "NASA",
      bio: "Making the seemingly impossible, possible. ✨",
      location: "Pale Blue Dot",
      website: "http://www.nasa.gov/",
      joinedDate: "December 2007",
      verified: true,
      tweetCount: 74535,
      followingCount: 115,
      followerCount: 92256201,
      likeCount: 17106,
    });
    expect(user.avatar).toMatch(/^https:\/\/pbs\.twimg\.com\/profile_images\//);
    expect(user.banner).toMatch(/^https:\/\/pbs\.twimg\.com\/profile_banners\//);
  });
});

describe("parseThread", () => {
  it("separates the tweet from its replies and nests reply chains", () => {
    const { doc } = load("status");
    const id = doc
      .querySelector(".main-tweet a.tweet-link, .main-tweet .tweet-date a")!
      .getAttribute("href")!
      .match(/status\/(\d+)/)![1];
    const { post, replies } = parseThread(doc, id);
    expect(post?.apiId).toBe(id);
    expect(replies.length).toBeGreaterThan(10);
    expect(replies.every((r) => r.parentId === id)).toBe(true);
    expect(replies.some((r) => r.apiId === id)).toBe(false);
    for (const reply of replies) {
      for (const child of reply.comments || []) {
        expect(child.parentId).toBe(reply.apiId);
      }
    }
  });
});

describe("classifyPage", () => {
  const verdict = (name: string) => {
    const { html, doc } = load(name);
    return classifyPage(html, doc);
  };

  it("accepts real pages", () => {
    expect(verdict("profile").kind).toBe("ok");
    expect(verdict("status").kind).toBe("ok");
    expect(verdict("search_images").kind).toBe("ok");
  });

  it("names each bot check rather than reading it as an empty page", () => {
    expect(verdict("gandalf")).toEqual({ kind: "challenge", guard: "Gandalf" });
    expect(verdict("challenge_shield")).toEqual({ kind: "challenge", guard: "Shield" });
    expect(verdict("challenge_anubis")).toEqual({ kind: "challenge", guard: "Anubis" });
    expect(verdict("challenge_r4fo")).toEqual({ kind: "challenge", guard: "r4fo" });
  });

  it("treats an unknown user as a real answer", () => {
    expect(verdict("notfound")).toMatchObject({ kind: "not-found" });
  });

  it("spots disabled search and empty results", () => {
    expect(verdict("search_disabled").kind).toBe("disabled");
    expect(verdict("search_empty").kind).toBe("empty");
  });
});
