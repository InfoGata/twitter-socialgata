import { MessageType, UiMessageType } from "./shared";
import type { TwitterSource } from "./sources/types";
import { nitter } from "./sources/nitter";
import { twstalker } from "./sources/twstalker";

/**
 * The mirror site this plugin reads from. Each source lives in its own file
 * behind `TwitterSource`, so switching to another one is this single line.
 *
 * `nitter` reads public Nitter instances, falling through a list of them as
 * they fail (see `sources/nitter/client.ts`). Most sit behind a bot check that
 * only a real page on the instance can pass, so the manifest lists every
 * instance under `pageContextRequests`.
 *
 * `twstalker` was the source until 2026-11-10, when every TWstalker search page
 * started returning 500. Its trending list still works, so `nitter` borrows
 * that one handler from it.
 *
 * twitterwebviewer.com was the source for 1.7.x. X Corp had it permanently
 * discontinued on 2026-08-28; see git history if another mirror with a JSON
 * API turns up and the mapping is worth reusing.
 */
const SOURCES = { nitter, twstalker } satisfies Record<string, TwitterSource>;

const ACTIVE_SOURCE: TwitterSource = SOURCES.nitter;

// Plugin Methods

application.onGetUser = (request) => ACTIVE_SOURCE.getUser(request);
application.onGetComments = (request) => ACTIVE_SOURCE.getComments(request);
application.onSearch = (request) => ACTIVE_SOURCE.search(request);
application.onGetPlatformType = async () => "microblog";

// Registered only when the active source can serve them. SocialGata gates its
// Trending button on `hasDefined.onGetTrendingTopics()`, so leaving these unset
// hides the button instead of leading the reader to an empty page.
// The same goes for the feed: SocialGata checks `hasDefined.onGetFeed()`.
const { getFeed, getTrendingTopics, getTrendingTopicFeed } = ACTIVE_SOURCE;
if (getFeed) {
  application.onGetFeed = (request) => getFeed.call(ACTIVE_SOURCE, request);
}
if (getTrendingTopics) {
  application.onGetTrendingTopics = (request) =>
    getTrendingTopics.call(ACTIVE_SOURCE, request);
}
if (getTrendingTopicFeed) {
  application.onGetTrendingTopicFeed = (request) =>
    getTrendingTopicFeed.call(ACTIVE_SOURCE, request);
}

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
