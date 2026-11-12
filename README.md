# Twitter Plugin for SocialGata

A SocialGata plugin that allows browsing Twitter/X content through public [Nitter](https://github.com/zedeus/nitter) instances, without requiring authentication.

## Features

- Browse trending topics
- Search for tweets
- View user profiles and their tweets
- No login required

## Building

```bash
npm install
npm run build
```

This will generate:
- `dist/index.js` - The main plugin script
- `dist/options.html` - The options page

## How It Works

Tweets, profiles, replies and search come from public Nitter instances, listed
in `src/sources/nitter/instances.ts`. Instances are volunteer-run and come and
go, so each request walks the list until one answers:

- the instance that last worked is tried first;
- an instance that fails (down, rate limited, a bot check that did not clear) is
  skipped for 30 minutes;
- each instance gets 20 seconds before the plugin moves on;
- "user not found" is believed once a second instance agrees, since an
  instance having a bad moment says it about accounts that exist;
- if every instance fails, the error lists each one and why.

Search is only sent to instances where it has been seen to return results;
several render the search page but always come back empty.

Most instances sit behind a bot check (Gandalf, Anubis, Shield, a
proof-of-work) that only a real page on the instance can pass, so every
instance is listed under `pageContextRequests` in `manifest.json` and the
InfoGata extension makes those requests from a pinned background tab on the
instance. The first request to an instance asks for the extension's consent.
**A new instance must be added to both `instances.ts` and the manifest.**

Media links are rewritten from the instance's proxy to Twitter's own CDN, and
posts carry Twitter ids, so nothing saved depends on an instance staying up.

Trending topics still come from [TWstalker](https://twstalker.com), whose list
works although its search does not; each topic's feed is a Nitter search.

### Limitations

- Read-only, no login
- Availability depends on the volunteer instances. Their operators ask that
  instances not be used for scraping; this plugin fetches only what a reader
  opens, and sticks to one instance at a time.
- Checks that need a person (image CAPTCHAs, click-through pages) are not
  attempted, so those instances are left out

## Testing

```bash
npm test
```

Parser and fallback tests run against pages saved from live instances in
`src/test/fixtures/`.

