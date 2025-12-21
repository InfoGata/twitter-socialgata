# Twitter Plugin for SocialGata

A SocialGata plugin that allows browsing Twitter/X content via TWstalker without requiring authentication.

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

## Development

The plugin consists of two parts:
1. **Main Plugin** (`src/index.ts`) - Handles all the Twitter data fetching via TWstalker
2. **Options UI** (`src/options.tsx`, `src/App.tsx`) - Settings page for the plugin

### Build Scripts

- `npm run build` - Build both options UI and plugin
- `npm run build:options` - Build only the options UI
- `npm run build:plugin` - Build only the main plugin

## How It Works

This plugin scrapes data from [TWstalker](https://twstalker.com), a third-party Twitter/X viewer. It provides read-only access to:

- Trending topics (US-based)
- Search results
- User profiles and their tweets

### Limitations

- No authentication/login support
- Read-only access
- Content is scraped from TWstalker, so availability depends on that service
- Some Twitter features may not be available
