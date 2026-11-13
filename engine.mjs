// CONTENT OUTLIER ENGINE
// Finds the short and long form videos that overperformed in a niche this week,
// then has Claude turn them into a ready to film 7 reel + 1 YouTube plan in the
// creator's own voice. Delivered as a Markdown file, an HTML dashboard and (optionally) Telegram.
//
// Everything specific to a creator lives in config/: accounts.json (who to watch),
// settings.json (scoring knobs) and brand.json (voice, rules, weekly format).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ================== CONFIG ==================
// All creator specific settings live in config/. Edit those files, not this one.
const loadJSON = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const accounts = loadJSON("./config/accounts.json");
const settings = loadJSON("./config/settings.json");
const brand = loadJSON("./config/brand.json");

// ================== TEST DATA for dry runs ==================
const FIXTURES = [
  {"platform":"youtube","account":"@TJRTrades","url":"https://example.com/TEST-DATA-NOT-A-REAL-VIDEO-1","title":"This liquidity trick changed my trading","published":"2026-07-12T10:00:00Z","views":840000,"seconds":58},
  {"platform":"youtube","account":"@TJRTrades","url":"https://example.com/TEST-DATA-NOT-A-REAL-VIDEO-2","title":"Daily recap","published":"2026-07-10T10:00:00Z","views":95000,"seconds":55},
  {"platform":"youtube","account":"@TJRTrades","url":"https://example.com/TEST-DATA-NOT-A-REAL-VIDEO-3","title":"Daily recap 2","published":"2026-07-08T10:00:00Z","views":88000,"seconds":52},
  {"platform":"youtube","account":"@TJRTrades","url":"https://example.com/TEST-DATA-NOT-A-REAL-VIDEO-4","title":"Market structure full guide","published":"2026-07-05T10:00:00Z","views":420000,"seconds":900},
  {"platform":"youtube","account":"@PhotonTrading","url":"https://example.com/TEST-DATA-NOT-A-REAL-VIDEO-5","title":"Supply and demand in 60 seconds","published":"2026-07-14T10:00:00Z","views":510000,"seconds":61},
  {"platform":"youtube","account":"@PhotonTrading","url":"https://example.com/TEST-DATA-NOT-A-REAL-VIDEO-6","title":"Weekly outlook","published":"2026-07-11T10:00:00Z","views":40000,"seconds":700},
  {"platform":"youtube","account":"@PhotonTrading","url":"https://example.com/TEST-DATA-NOT-A-REAL-VIDEO-7","title":"Weekly outlook 2","published":"2026-07-04T10:00:00Z","views":38000,"seconds":720},
  {"platform":"instagram","account":"umarashraf","url":"https://example.com/TEST-DATA-NOT-A-REAL-VIDEO-8","title":"The one habit every funded trader has","published":"2026-07-13T10:00:00Z","views":2200000,"seconds":34},
  {"platform":"instagram","account":"umarashraf","url":"https://example.com/TEST-DATA-NOT-A-REAL-VIDEO-9","title":"Morning routine","published":"2026-07-09T10:00:00Z","views":180000,"seconds":30},
  {"platform":"instagram","account":"umarashraf","url":"https://example.com/TEST-DATA-NOT-A-REAL-VIDEO-10","title":"Desk setup","published":"2026-07-06T10:00:00Z","views":160000,"seconds":28},
  {"platform":"youtube","account":"Some Search Channel","url":"https://example.com/TEST-DATA-NOT-A-REAL-VIDEO-11","title":"How prop firm challenges actually work","published":"2026-07-15T10:00:00Z","views":310000,"seconds":840,"fromSearch":"prop firm challenge passed"}
];

// ================== YOUTUBE ==================
// YouTube discovery via the official Data API v3. Free tier: 10,000 units/day.
// This module stays well under quota: ~4 units per channel + 100 per search topic.

const BASE = "https://www.googleapis.com/youtube/v3";

async function yt(path, params, key) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", key);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function parseDuration(iso) {
  // PT1H2M10S -> seconds
  const m = iso?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

async function pullChannel(handle, key, settings) {
  // Resolve @handle to channel + uploads playlist
  const ch = await yt("/channels", { part: "contentDetails,snippet", forHandle: handle });
  const item = ch.items?.[0];
  if (!item) return { handle, videos: [], error: "channel not found" };
  const uploads = item.contentDetails.relatedPlaylists.uploads;

  const pl = await yt("/playlistItems", {
    part: "contentDetails",
    playlistId: uploads,
    maxResults: String(settings.videos_per_channel),
  });
  const ids = (pl.items || []).map((i) => i.contentDetails.videoId);
  if (!ids.length) return { handle, videos: [] };

  const vids = await yt("/videos", {
    part: "statistics,contentDetails,snippet",
    id: ids.join(","),
  });

  const videos = (vids.items || []).map((v) => ({
    platform: "youtube",
    account: handle,
    url: `https://youtube.com/watch?v=${v.id}`,
    title: v.snippet.title,
    published: v.snippet.publishedAt,
    views: +(v.statistics.viewCount || 0),
    seconds: parseDuration(v.contentDetails.duration),
  }));
  return { handle, videos };
}

async function searchTopic(topic, key, settings) {
  // Search costs 100 units. Recent, view-ordered, then hydrate stats.
  const after = new Date(Date.now() - settings.days_back * 864e5).toISOString();
  const s = await yt("/search", {
    part: "snippet",
    q: topic,
    type: "video",
    order: "viewCount",
    publishedAfter: after,
    maxResults: "10",
    relevanceLanguage: "en",
  });
  const ids = (s.items || []).map((i) => i.id.videoId).filter(Boolean);
  if (!ids.length) return [];
  const vids = await yt("/videos", {
    part: "statistics,contentDetails,snippet",
    id: ids.join(","),
  });
  return (vids.items || []).map((v) => ({
    platform: "youtube",
    account: v.snippet.channelTitle,
    url: `https://youtube.com/watch?v=${v.id}`,
    title: v.snippet.title,
    published: v.snippet.publishedAt,
    views: +(v.statistics.viewCount || 0),
    seconds: parseDuration(v.contentDetails.duration),
    fromSearch: topic,
  }));
}

// ================== INSTAGRAM ==================
// Instagram discovery via Apify's official instagram-reel-scraper actor.
// Requires APIFY_TOKEN. If absent, the engine skips IG gracefully and runs on YouTube alone.
// Cost note: pay-per-result, typically a few dollars per month at ~10 accounts weekly.

const ACTOR = "apify~instagram-reel-scraper";

async function pullReels(usernames, token, settings) {
  if (!token) return { reels: [], skipped: true };
  const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${token}&timeout=300`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: usernames,
      resultsLimit: settings.reels_per_account,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Apify ${res.status}: ${body.slice(0, 300)}`);
  }
  const items = await res.json();
  const reels = (Array.isArray(items) ? items : [])
    .map((r) => ({
      platform: "instagram",
      account: r.ownerUsername || r.username || "unknown",
      url: r.url || (r.shortCode ? `https://www.instagram.com/reel/${r.shortCode}/` : null),
      title: (r.caption || "").slice(0, 120),
      published: r.timestamp || null,
      views: +(r.videoPlayCount || r.videoViewCount || r.playsCount || 0),
      seconds: +(r.videoDuration || 30),
    }))
    .filter((r) => r.url && r.views > 0);
  return { reels, skipped: false };
}

// ================== SCORING ==================
// Outlier scoring. The core idea: raw views mean nothing, a big account gets big views
// on everything. What matters is views RELATIVE to that account's own normal.
// A video doing 5x its account's median is a format signal worth imitating.

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function scoreVideos(allVideos, settings) {
  const now = Date.now();
  const cutoff = now - settings.days_back * 864e5;

  // Group by account to compute each account's baseline
  const byAccount = {};
  for (const v of allVideos) {
    (byAccount[v.account] ||= []).push(v);
  }

  const scored = [];
  for (const [account, vids] of Object.entries(byAccount)) {
    const base = median(vids.map((v) => v.views).filter((x) => x > 0)) || 1;
    for (const v of vids) {
      const t = v.published ? new Date(v.published).getTime() : now;
      if (t < cutoff) continue;
      if (v.views < settings.min_views_floor && !v.fromSearch) continue;
      const multiplier = v.views / base;
      // Recency decay: full weight this week, fades toward 0.5 at days_back
      const ageDays = (now - t) / 864e5;
      const recency = 1 - 0.5 * Math.min(ageDays / settings.days_back, 1);
      scored.push({
        ...v,
        baseline: Math.round(base),
        multiplier: +multiplier.toFixed(1),
        score: +(multiplier * recency).toFixed(2),
      });
    }
  }

  const isShort = (v) => v.seconds > 0 && v.seconds <= settings.shorts_max_seconds;
  const outliers = scored.filter(
    (v) => v.multiplier >= settings.outlier_min || v.fromSearch
  );

  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter((v) => (seen.has(v.url) ? false : seen.add(v.url)));
  };

  let shorts = dedupe(outliers.filter(isShort).sort((a, b) => b.score - a.score)).slice(
    0,
    settings.top_shorts_to_use
  );
  let longform = dedupe(
    outliers.filter((v) => !isShort(v)).sort((a, b) => b.score - a.score)
  ).slice(0, settings.top_longform_to_use);

  // Fallback: a quiet week must never mean an empty schedule. If nothing cleared
  // the outlier bar, use the best available videos by views so links always exist.
  if (!shorts.length) {
    shorts = dedupe(scored.filter(isShort).sort((a, b) => b.views - a.views)).slice(
      0,
      settings.top_shorts_to_use
    );
    if (shorts.length) console.log("No shorts cleared the outlier bar, using top by views instead");
  }
  if (!longform.length) {
    longform = dedupe(
      scored.filter((v) => !isShort(v)).sort((a, b) => b.views - a.views)
    ).slice(0, settings.top_longform_to_use);
    if (longform.length) console.log("No long form cleared the outlier bar, using top by views instead");
  }

  return { shorts, longform, totalScanned: allVideos.length };
}

// ================== LINK VERIFICATION ==================
// Link verification. Belt and braces: even though every URL comes from live API data,
// a video can be deleted between scrape and read. This checks each YouTube link against
// YouTube's oEmbed endpoint (returns 200 only for live, public videos) and drops dead ones.
// Instagram URLs come from a scrape of the live profile minutes earlier, and IG blocks
// automated checks, so they pass through as-is.

async function verifyLinks(videos) {
  const checks = videos.map(async (v) => {
    if (v.platform !== "youtube") return v; // IG: fresh by construction
    try {
      const res = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(v.url)}&format=json`,
        { redirect: "follow" }
      );
      // oEmbed answers 200 for live public videos, 400/404 for dead or private ones.
      // Anything else (proxy 403, rate limit 429, 5xx) is not YouTube's verdict on the
      // video, so keep the link rather than lose a good one to a network mood.
      if (res.ok) return v;
      return res.status === 400 || res.status === 404 || res.status === 401 ? null : v;
    } catch {
      // Network hiccup on the check itself: keep the video rather than lose a good link
      return v;
    }
  });
  const results = await Promise.all(checks);
  const alive = results.filter(Boolean);
  const dropped = videos.length - alive.length;
  if (dropped > 0) console.log(`Link check: dropped ${dropped} dead link(s)`);
  return alive;
}

// ================== GENERATION ==================
// Turns scored outliers into the weekly schedule via the Anthropic API.

const BRAND = `You are the content manager for ${brand.name}. ${brand.creator}
Voice: ${brand.voice}
HARD RULES, zero exceptions: ${brand.rules.join(" ")}`;

async function claude(prompt, apiKey, model) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = Math.min(
    ...[clean.indexOf("["), clean.indexOf("{")].filter((i) => i >= 0)
  );
  return JSON.parse(clean.slice(start));
}

function exampleBlock(shorts) {
  return shorts
    .map(
      (s, i) =>
        `[${i + 1}] ${s.url} | ${s.platform} | ${s.multiplier}x the account's normal views (${s.views.toLocaleString()} views) | "${(s.title || "").slice(0, 80)}"`
    )
    .join("\n");
}

async function generateWeek({ shorts, longform }, apiKey, model) {
  const exList = exampleBlock(shorts);

  const reelPrompt = (nums, spec) => `${BRAND}
This week's outlier short form videos found by the discovery engine (these overperformed their own account's baseline, that is the signal):
${exList}
Create reels ${nums} of a 7 reel week. ${spec}
Where a reel maps to an example, use its number in "ex" and say in "imitate" exactly what to copy (hook mechanic, structure, pacing) and what to switch to ${brand.name}'s topic and style. Never copy wording.
Respond ONLY with a JSON array, no other text, no fences. Each item: {"n":number,"day":"Mon..Sun","format":"...","keyword":"WORD or null","hook":"under 12 words","beats":["3 to 5 short beats"],"cta":"one line","ex":number or null,"imitate":"one line"}. Terse values.`;

  const reelsA = parseJSON(
    await claude(
      reelPrompt(
        "1 to 4",
        `${brand.week.reels_1_to_4} Rotate topics across the week: ${brand.topics.join(", ")}.`
      ),
      apiKey,
      model
    )
  );
  const reelsB = parseJSON(
    await claude(
      reelPrompt(
        "5 to 7",
        brand.week.reels_5_to_7
      ),
      apiKey,
      model
    )
  );

  const longList = longform
    .map(
      (l, i) =>
        `[${i + 1}] ${l.url} | ${l.multiplier}x baseline | "${(l.title || "").slice(0, 90)}"`
    )
    .join("\n");

  const yt = parseJSON(
    await claude(
      `${BRAND}
Outlier LONG FORM videos in the niche this week (titles show what beginners are clicking right now):
${longList || "none found this week, use your judgment on beginner search topics"}
Create this week's YouTube long form package. Beginner search content, not follower content. Pick the topic angle these outliers prove is working, adapted to ${brand.name}'s own expertise.
Respond ONLY with JSON, no fences: {"topic_reason":"one line on why this topic, referencing the outlier evidence","title":"under 60 chars, simple words","hook":"2 to 3 spoken sentences opening on the viewer's pain","visual_hook":"what is on screen first 5 seconds","cta_mid":"${brand.youtube.cta_mid}","cta_end":"${brand.youtube.cta_end}","description":"${brand.youtube.description}","thumb1":"thumbnail text under 5 words","thumb2":"second option","reference":number or null}`,
      apiKey,
      model
    )
  );

  return { reels: [...reelsA, ...reelsB].sort((a, b) => a.n - b.n), yt };
}

// ================== REPORTS ==================
// Renders the weekly output as week.md (for Telegram/reading) and week.html (dashboard).

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function renderReports({ shorts, longform, week, meta }, outDir) {
  mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);

  // ---------- MARKDOWN ----------
  let md = `# ${brand.name}. Week of ${date}\n\n`;
  if (meta.dry)
    md += `> TEST MODE. Every link below is deliberately fake placeholder data. Real links appear only after your API keys are set and the engine runs live.\n\n`;
  md += `Scanned ${meta.totalScanned} videos across ${meta.accounts} accounts. ${shorts.length} short form outliers, ${longform.length} long form outliers.${meta.igSkipped ? " Instagram skipped (no APIFY_TOKEN set)." : ""}\n\n`;
  md += `## Outlier examples this week\n\n`;
  for (const [i, s] of shorts.entries()) {
    md += `${i + 1}. ${s.url}\n   ${s.platform} · ${s.account} · ${s.views.toLocaleString()} views · ${s.multiplier}x their normal\n   "${s.title}"\n\n`;
  }
  md += `## Reels\n\n`;
  for (const r of week.reels) {
    const ex = r.ex != null && shorts[r.ex - 1] ? shorts[r.ex - 1] : null;
    md += `### Reel ${r.n} · ${r.day} · ${r.format}${r.keyword ? ` · KEYWORD: ${r.keyword}` : ""}\n`;
    md += `Hook: ${r.hook}\n`;
    md += r.beats.map((b, i) => `${i + 1}. ${b}`).join("\n") + "\n";
    md += `CTA: ${r.cta}\n`;
    if (ex) md += `Imitate: ${ex.url}\n${r.imitate}\n`;
    md += `\n`;
  }
  const y = week.yt;
  md += `## YouTube long form\n\n`;
  md += `Why this topic: ${y.topic_reason}\n\nTITLE: ${y.title}\n\nHOOK: ${y.hook}\n\nVISUAL HOOK: ${y.visual_hook}\n\nCTA MID: ${y.cta_mid}\n\nCTA END: ${y.cta_end}\n\nDESCRIPTION:\n${y.description}\n\nTHUMB 1: ${y.thumb1}\nTHUMB 2: ${y.thumb2}\n`;
  if (y.reference != null && longform[y.reference - 1])
    md += `\nReference video: ${longform[y.reference - 1].url}\n`;

  writeFileSync(`${outDir}/week.md`, md);

  // ---------- HTML DASHBOARD ----------
  const exCard = (s, i) => `
    <div class="ex"><div class="plat">${esc(s.platform)} · ${esc(s.account)}</div>
    <div class="mult">${s.multiplier}x <span>their normal · ${s.views.toLocaleString()} views</span></div>
    <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>
    <div class="why">${esc(s.title)}</div></div>`;

  const reelCard = (r) => {
    const ex = r.ex != null && shorts[r.ex - 1] ? shorts[r.ex - 1] : null;
    return `<div class="card">
      <div class="head"><span class="rn">REEL ${r.n}</span>
      ${r.keyword ? `<span class="kw">${esc(r.keyword)}</span>` : ""}
      <span class="fmt">${esc(r.format)}</span><span class="day">${esc(r.day)}</span></div>
      <div class="hook">"${esc(r.hook)}"</div>
      <ol class="beats">${r.beats.map((b) => `<li>${esc(b)}</li>`).join("")}</ol>
      <div class="cta"><b>CTA:</b> ${esc(r.cta)}</div>
      ${ex ? `<div class="exref"><b>Imitate:</b> <a href="${esc(ex.url)}" target="_blank" rel="noopener">${esc(ex.url)}</a><br>${esc(r.imitate || "")}</div>` : ""}
    </div>`;
  };

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(brand.name)} · Week of ${date}</title>
<style>
:root{--bg:#0a0a0c;--panel:#121216;--line:#26262e;--gold:#d4a94e;--blue:#4e8fd4;--text:#e8e6e1;--dim:#8b8a93}
*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:'Hanken Grotesk',system-ui,sans-serif;padding:28px 20px 80px;max-width:1100px;margin:0 auto}
h1{font-size:22px;font-weight:800;letter-spacing:-.02em}h1 span{color:var(--gold)}
.tag{font-family:ui-monospace,monospace;font-size:11px;color:var(--dim);letter-spacing:.08em;text-transform:uppercase;margin-top:6px}
h2{font-size:15px;color:var(--gold);text-transform:uppercase;margin:34px 0 14px}
.exgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.ex{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.ex a{color:var(--blue);font-family:ui-monospace,monospace;font-size:12px;word-break:break-all;text-decoration:none}
.ex .why{font-size:13px;color:var(--dim);margin-top:6px;line-height:1.5}
.plat{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.mult{font-weight:700;font-size:18px;color:var(--gold);margin:6px 0}.mult span{font-size:12px;color:var(--dim);font-weight:400}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:14px}
.head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.rn{font-weight:800;font-size:15px}
.kw{font-family:ui-monospace,monospace;font-size:11px;background:rgba(212,169,78,.12);color:var(--gold);border-radius:6px;padding:4px 10px;letter-spacing:.08em}
.fmt{font-family:ui-monospace,monospace;font-size:11px;color:var(--dim)}
.day{margin-left:auto;font-family:ui-monospace,monospace;font-size:11px;color:var(--blue)}
.hook{font-size:16px;font-weight:600;line-height:1.4;margin:6px 0 10px}
.beats{font-size:14px;line-height:1.7;padding-left:18px}
.cta,.exref{font-size:13px;color:var(--dim);margin-top:10px;line-height:1.5}
.cta b,.exref b{color:var(--text)}.exref a{color:var(--blue);word-break:break-all}
.field{margin-bottom:14px}.lab{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);margin-bottom:4px}
.val{font-size:14px;line-height:1.6;white-space:pre-wrap}.val.title{font-size:18px;font-weight:700}
@media(max-width:640px){.day{margin-left:0;width:100%}}
</style></head><body>
<h1>${esc(brand.name)} <span>content week</span></h1><div class="tag">week of ${date} · ${meta.totalScanned} videos scanned · ${shorts.length} outliers found</div>
${meta.dry ? `<div style="margin-top:16px;background:rgba(212,94,78,.12);border:1px solid #d45e4e;border-radius:8px;padding:14px 16px;font-size:14px;font-weight:600">TEST MODE. Every link on this page is deliberately fake placeholder data. Real links appear only after your API keys are set and the engine runs live.</div>` : ""}
<h2>Outlier examples</h2><div class="exgrid">${shorts.map(exCard).join("")}</div>
<h2>Reels</h2>${week.reels.map(reelCard).join("")}
<h2>YouTube long form</h2><div class="card">
<div class="field"><div class="lab">Why this topic</div><div class="val">${esc(y.topic_reason)}</div></div>
<div class="field"><div class="lab">Title</div><div class="val title">${esc(y.title)}</div></div>
<div class="field"><div class="lab">Spoken hook</div><div class="val">${esc(y.hook)}</div></div>
<div class="field"><div class="lab">Visual hook</div><div class="val">${esc(y.visual_hook)}</div></div>
<div class="field"><div class="lab">CTA · middle</div><div class="val">${esc(y.cta_mid)}</div></div>
<div class="field"><div class="lab">CTA · end</div><div class="val">${esc(y.cta_end)}</div></div>
<div class="field"><div class="lab">Description</div><div class="val">${esc(y.description)}</div></div>
<div class="field"><div class="lab">Thumbnails</div><div class="val">1. ${esc(y.thumb1)}\n2. ${esc(y.thumb2)}</div></div>
${y.reference != null && longform[y.reference - 1] ? `<div class="field"><div class="lab">Reference video</div><div class="val"><a style="color:var(--blue)" href="${esc(longform[y.reference - 1].url)}" target="_blank" rel="noopener">${esc(longform[y.reference - 1].url)}</a></div></div>` : ""}
</div></body></html>`;

  writeFileSync(`${outDir}/week.html`, html);
  return { md };
}

// ================== TELEGRAM ==================
// Sends the weekly schedule to Telegram. Optional: skips silently if tokens absent.

async function sendTelegram(outDir, botToken, chatId) {
  if (!botToken || !chatId) return { skipped: true };

  const md = readFileSync(`${outDir}/week.md`, "utf8");

  // Telegram message limit is 4096 chars; send the summary, attach the full file.
  const summary = md.slice(0, 3500);
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: summary }),
  });

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append(
    "document",
    new Blob([readFileSync(`${outDir}/week.html`)], { type: "text/html" }),
    "week.html"
  );
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { skipped: false };
}

// ================== MAIN ==================
// Orchestrator.
// Live run:   node engine.mjs            (needs YOUTUBE_API_KEY + ANTHROPIC_API_KEY, APIFY_TOKEN optional)
// Dry run:    node engine.mjs --dry-run  (no keys needed, uses fixture data, skips AI generation)


const DRY = process.argv.includes("--dry-run");


const OUT = "./output";

const {
  YOUTUBE_API_KEY,
  APIFY_TOKEN,
  ANTHROPIC_API_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
} = process.env;

async function collect() {
  if (DRY) {
    console.log("DRY RUN: loading fixture data instead of live APIs");
    // Shift the fixture dates so the newest one is 1 day old. Without this the test
    // data ages out of the days_back window and the dry run finds nothing.
    const newest = Math.max(...FIXTURES.map((v) => new Date(v.published).getTime()));
    const shift = Date.now() - 864e5 - newest;
    return {
      videos: FIXTURES.map((v) => ({ ...v, published: new Date(new Date(v.published).getTime() + shift).toISOString() })),
      igSkipped: true,
    };
  }
  if (!YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY missing");

  const videos = [];
  console.log(`Pulling ${accounts.youtube.length} YouTube channels...`);
  for (const handle of accounts.youtube) {
    try {
      const { videos: v, error } = await pullChannel(handle, YOUTUBE_API_KEY, settings);
      if (error) console.warn(`  ${handle}: ${error}`);
      else {
        videos.push(...v);
        console.log(`  ${handle}: ${v.length} videos`);
      }
    } catch (e) {
      console.warn(`  ${handle} failed: ${e.message}`);
    }
  }

  console.log(`Searching ${accounts.search_topics.length} topics...`);
  for (const topic of accounts.search_topics) {
    try {
      const found = await searchTopic(topic, YOUTUBE_API_KEY, settings);
      videos.push(...found);
      console.log(`  "${topic}": ${found.length} videos`);
    } catch (e) {
      console.warn(`  search "${topic}" failed: ${e.message}`);
    }
  }

  let igSkipped = true;
  try {
    const { reels, skipped } = await pullReels(accounts.instagram, APIFY_TOKEN, settings);
    igSkipped = skipped;
    if (!skipped) {
      videos.push(...reels);
      console.log(`Instagram: ${reels.length} reels from ${accounts.instagram.length} accounts`);
    } else {
      console.log("Instagram: skipped (no APIFY_TOKEN)");
    }
  } catch (e) {
    console.warn(`Instagram failed, continuing on YouTube alone: ${e.message}`);
  }

  return { videos, igSkipped };
}

async function main() {
  const { videos, igSkipped } = await collect();
  const scored = scoreVideos(videos, settings);
  console.log(
    `Scored ${scored.totalScanned} videos: ${scored.shorts.length} short form outliers, ${scored.longform.length} long form outliers`
  );

  if (!DRY) {
    console.log("Verifying every link is live...");
    scored.shorts = await verifyLinks(scored.shorts);
    scored.longform = await verifyLinks(scored.longform);
    console.log(
      `Verified: ${scored.shorts.length} shorts and ${scored.longform.length} long form confirmed live`
    );
  }

  let week;
  if (DRY) {
    console.log("DRY RUN: skipping AI generation, using placeholder week");
    week = {
      reels: scored.shorts.slice(0, 3).map((s, i) => ({
        n: i + 1,
        day: ["Mon", "Wed", "Fri"][i],
        format: "Split screen educational",
        keyword: ["STRUCTURE", "RISK", "LEVELS"][i],
        hook: "Placeholder hook for dry run",
        beats: ["beat one", "beat two", "beat three"],
        cta: "Comment the keyword",
        ex: i + 1,
        imitate: "dry run placeholder",
      })),
      yt: {
        topic_reason: "dry run",
        title: "Dry Run Title",
        hook: "Dry run hook.",
        visual_hook: "Chart on screen",
        cta_mid: "Free guide",
        cta_end: "Main offer CTA",
        description: "Dry run description. Not financial advice.",
        thumb1: "DRY RUN",
        thumb2: "TEST",
        reference: null,
      },
    };
  } else {
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
    console.log("Generating weekly schedule...");
    week = await generateWeek(scored, ANTHROPIC_API_KEY, settings.anthropic_model);
  }

  renderReports(
    {
      ...scored,
      week,
      meta: {
        totalScanned: scored.totalScanned,
        accounts: accounts.youtube.length + accounts.instagram.length,
        igSkipped,
        dry: DRY,
      },
    },
    OUT
  );
  console.log(`Wrote ${OUT}/week.md and ${OUT}/week.html`);

  if (!DRY) {
    try {
      const t = await sendTelegram(OUT, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID);
      console.log(t.skipped ? "Telegram: skipped (no tokens)" : "Telegram: sent");
    } catch (e) {
      console.warn(
        `Telegram delivery failed (${e.message}). The week is still saved in the repo under weeks/.`
      );
    }
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error("ENGINE FAILED:", e.message);
  process.exit(1);
});
