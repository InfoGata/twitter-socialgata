import { MessageType, UiMessageType } from "./shared";
import type { TwitterSource } from "./sources/types";
import { twstalker } from "./sources/twstalker";

/**
 * The mirror site this plugin reads from. Each source lives in its own file
 * behind `TwitterSource`, so switching to another one is this single line.
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
