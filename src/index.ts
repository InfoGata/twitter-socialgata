import { MessageType, UiMessageType } from "./shared";
import type { TwitterSource } from "./sources/types";
import { twstalker } from "./sources/twstalker";

/**
 * The mirror site this plugin reads from. Each source lives in its own file
 * behind `TwitterSource`, so switching to another one is this single line.
 *
 * `twstalker` reads twstalker.com. Cloudflare there only answers requests that
 * come from one of its own pages, which is why the manifest lists the site under
 * `pageContextRequests`: the host then issues these fetches from a hidden page
 * on twstalker.com rather than from the app. Without a host that supports that
 * (the extension, or the desktop build) every request comes back challenged.
 *
 * twitterwebviewer.com was the source for 1.7.x. X Corp had it permanently
 * discontinued on 2026-08-28, along with Nitter and XCancel, so that source is
 * gone rather than merely blocked; see git history if another mirror with a JSON
 * API turns up and the mapping is worth reusing.
 */
const SOURCES = { twstalker } satisfies Record<string, TwitterSource>;

const ACTIVE_SOURCE: TwitterSource = SOURCES.twstalker;

// Plugin Methods

application.onGetFeed = (request) => ACTIVE_SOURCE.getFeed(request);
application.onGetUser = (request) => ACTIVE_SOURCE.getUser(request);
application.onGetComments = (request) => ACTIVE_SOURCE.getComments(request);
application.onSearch = (request) => ACTIVE_SOURCE.search(request);
application.onGetPlatformType = async () => "microblog";

// Registered only when the active source can serve them. SocialGata gates its
// Trending button on `hasDefined.onGetTrendingTopics()`, so leaving these unset
// hides the button instead of leading the reader to an empty page.
const { getTrendingTopics, getTrendingTopicFeed } = ACTIVE_SOURCE;
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
