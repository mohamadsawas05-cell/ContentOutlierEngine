# Content Outlier Engine

An automated content planner for short form creators. Every week it scans the YouTube and Instagram accounts in your niche, finds the videos that **overperformed their own account's normal**, and has Claude turn them into a ready to film plan: **7 reels and 1 YouTube video**, written in your voice and linked to the exact videos to learn from.

It runs on GitHub Actions on a schedule, so nothing needs to run on your own machine.

## The idea: outliers, not views

Raw views are misleading. A big account gets big views on everything. What matters is how a video did **compared with that account's usual results**.

For each account the engine:

1. Takes the **median views** of its recent posts as that account's baseline.
2. Scores every recent video as **views / baseline**. A video at 3x or more is an outlier, which means the format or hook worked.
3. Applies a **recency decay**, so this week's outliers rank above older ones.
4. Splits results into **short form** (3 minutes or under) and **long form**, removes duplicates and keeps the top few of each.
5. On a quiet week where nothing clears the bar, it falls back to the most viewed videos, so the plan always has real examples.

Before anything reaches the AI, every YouTube link is checked against YouTube's oEmbed endpoint and dead links are dropped.

## What you get each week

- **week.html**: a dashboard with the outlier videos (and their multiplier) at the top, then every reel with its hook, beats, CTA, comment keyword and the specific video to imitate, then the full YouTube package (title, spoken hook, visual hook, CTAs, description and 2 thumbnail options).
- **week.md**: the same plan as plain text.
- **Telegram** (optional): a summary message plus the HTML file.
- Every week is also saved to `weeks/` in the repo, so you keep a history.

## Pipeline

```
YouTube Data API ┐
                 ├─> outlier scoring ─> link check ─> Claude (3 calls) ─> week.md + week.html ─> Telegram
Apify (Instagram)┘
```

## Make it yours

Everything specific to a creator lives in `config/`. The defaults are an example for a trading education channel.

| File | What to change |
|---|---|
| `config/accounts.json` | YouTube handles, Instagram usernames and search topics to watch |
| `config/settings.json` | Outlier threshold, how many days back, short form cut off, how many videos to use, model |
| `config/brand.json` | Brand name, who you are, your voice, hard rules (for example no money claims), topics to rotate, the weekly reel formats and your YouTube CTAs |

## Try it with no API keys

```bash
node engine.mjs --dry-run
```

This uses built in test data, skips the AI step and writes `output/week.md` and `output/week.html` so you can see the format.

## Run it for real

Requires Node 20 or newer. No npm packages needed.

| Secret | Needed | Where from |
|---|---|---|
| `YOUTUBE_API_KEY` | Yes | Google Cloud console, enable YouTube Data API v3 (free tier) |
| `ANTHROPIC_API_KEY` | Yes | console.anthropic.com |
| `APIFY_TOKEN` | Optional | apify.com. Without it the engine runs on YouTube alone |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional | Create a bot with @BotFather |

**Locally:**

```bash
YOUTUBE_API_KEY=... ANTHROPIC_API_KEY=... node engine.mjs
```

**On GitHub Actions:** fork the repo, add the secrets under **Settings, Secrets and variables, Actions**, then run **Weekly content plan** from the Actions tab. After that it runs by itself every Sunday at 15:00 UTC.

## Design choices

- **Single file, zero dependencies.** Uses Node's built in `fetch`, so there is nothing to install and nothing to break.
- **Fails soft.** If Instagram or Telegram fails, the run logs it and still finishes the week on YouTube data.
- **Stays inside free quotas.** About 4 YouTube API units per channel plus 100 per search topic, well under the 10,000 daily limit.

## Note on Instagram data

Meta has no official API for other accounts' reels, so Instagram data comes from Apify's reel scraper, a third party service. Check that your use fits Instagram's terms and Apify's.
