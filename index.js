require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder,
  AttachmentBuilder,
  PermissionsBitField
} = require("discord.js");
const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const Parser = require("rss-parser");

// ====================== ENV ======================
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  IRACING_CLIENT_ID,
  IRACING_CLIENT_SECRET,
  IRACING_REDIRECT_URI,
  ANNOUNCE_CHANNEL_ID
} = process.env;

const NEWS_CHANNEL_ID = "1410663955759759410";

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !IRACING_CLIENT_ID ||
    !IRACING_CLIENT_SECRET || !IRACING_REDIRECT_URI || !ANNOUNCE_CHANNEL_ID) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

// ====================== SEASON HELPER ======================
// iRacing seasons: S1=Jan-Mar, S2=Apr-Jun, S3=Jul-Sep, S4=Oct-Dec
function getCurrentSeason() {
  const now    = new Date();
  const year   = now.getFullYear();
  const month  = now.getMonth() + 1;
  const season = month <= 3 ? 1 : month <= 6 ? 2 : month <= 9 ? 3 : 4;
  return { year, season, label: `${year} S${season}` };
}

// ====================== STORAGE ======================
const DATA_DIR       = "/app/data";
const LINKED_FILE    = path.join(DATA_DIR, "linked-drivers.json");
const LAST_NEWS_FILE = path.join(DATA_DIR, "last-news.json");

function loadLinkedDrivers() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(LINKED_FILE)) return [];
    return JSON.parse(fs.readFileSync(LINKED_FILE, "utf8"));
  } catch (err) {
    console.error("Error loading linked-drivers:", err.message);
    return [];
  }
}

function saveLinkedDrivers(drivers) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LINKED_FILE, JSON.stringify(drivers, null, 2), "utf8");
    console.log(`Saved ${drivers.length} linked driver(s)`);
  } catch (err) {
    console.error("Error saving linked-drivers:", err.message);
  }
}

function loadLastNewsUrl() {
  try {
    if (!fs.existsSync(LAST_NEWS_FILE)) return null;
    return JSON.parse(fs.readFileSync(LAST_NEWS_FILE, "utf8")).url || null;
  } catch { return null; }
}

function saveLastNewsUrl(url) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LAST_NEWS_FILE, JSON.stringify({ url }), "utf8");
  } catch (err) {
    console.error("Error saving last news URL:", err.message);
  }
}

// ====================== HELPERS ======================
function maskSecret(secret, clientId) {
  const normalizedId = clientId.trim().toLowerCase();
  return crypto.createHash("sha256").update(secret + normalizedId).digest("base64");
}

async function getValidAccessToken(user) {
  if (Date.now() < user.expiresAt - 60000) return user.accessToken;

  console.log(`Refreshing token for ${user.discordId}`);
  const maskedSecret = maskSecret(IRACING_CLIENT_SECRET, IRACING_CLIENT_ID);
  const res = await fetch("https://oauth.iracing.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     IRACING_CLIENT_ID,
      client_secret: maskedSecret,
      refresh_token: user.refreshToken
    })
  });
  if (!res.ok) throw new Error("Token refresh failed");

  const data = await res.json();
  user.accessToken  = data.access_token;
  user.refreshToken = data.refresh_token || user.refreshToken;
  user.expiresAt    = Date.now() + data.expires_in * 1000;

  const drivers = loadLinkedDrivers();
  const idx = drivers.findIndex(d => d.discordId === user.discordId);
  if (idx !== -1) {
    drivers[idx].accessToken  = user.accessToken;
    drivers[idx].refreshToken = user.refreshToken;
    drivers[idx].expiresAt    = user.expiresAt;
    saveLinkedDrivers(drivers);
  }

  return user.accessToken;
}

async function getCurrentIRating(user) {
  try {
    const token   = await getValidAccessToken(user);
    const rootRes = await fetch(
      "https://members-ng.iracing.com/data/member/chart_data?chart_type=1&category_id=5",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!rootRes.ok) return null;
    const rootJson = await rootRes.json();
    if (!rootJson.link) return null;
    const chartRes  = await fetch(rootJson.link);
    if (!chartRes.ok) return null;
    const chartJson = await chartRes.json();
    if (chartJson.data?.length > 0) {
      return chartJson.data[chartJson.data.length - 1].value;
    }
  } catch (e) {}
  return null;
}

async function fetchIRacingData(token, url) {
  if (!url) return null;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    console.log(`fetchIRacingData failed: ${res.status} ${url} | ${body.slice(0, 200)}`);
    return null;
  }
  const json = await res.json();
  if (json.link) {
    const dataRes = await fetch(json.link);
    if (!dataRes.ok) {
      console.log(`fetchIRacingData link failed: ${dataRes.status}`);
      return null;
    }
    return dataRes.json();
  }
  return json;
}

// ====================== NEWS CHECKER ======================
const rssParser = new Parser();

async function checkIRacingNews() {
  try {
    const feed = await rssParser.parseURL("https://www.iracing.com/feed/");
    if (!feed.items || feed.items.length === 0) return;

    const latest      = feed.items[0];
    const latestUrl   = latest.link;
    const lastSeenUrl = loadLastNewsUrl();

    if (latestUrl === lastSeenUrl) return;

    saveLastNewsUrl(latestUrl);

    const channel = client.channels.cache.get(NEWS_CHANNEL_ID);
    if (!channel) {
      console.log("News channel not found:", NEWS_CHANNEL_ID);
      return;
    }

    const pubDate = latest.pubDate ? new Date(latest.pubDate).toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    }) : "";

    const embed = new EmbedBuilder()
      .setColor(0x0099ff)
      .setTitle(latest.title || "New iRacing Post")
      .setURL(latestUrl)
      .setDescription(pubDate ? `📅 ${pubDate}` : "New post from iRacing")
      .setFooter({ text: "iRacing News • iracing.com" })
      .setTimestamp();

    await channel.send({ content: "📰 **New iRacing update!**", embeds: [embed] });
    console.log(`News posted: ${latest.title}`);
  } catch (err) {
    console.error("News check error:", err.message);
  }
}

// ====================== STATS FETCHER ======================
async function fetchDriverStats(user) {
  const token = await getValidAccessToken(user);
  const { year } = getCurrentSeason();

  const [careerData, recentData, irChartData, srChartData] = await Promise.all([
    fetchIRacingData(token, "https://members-ng.iracing.com/data/stats/member_career"),
    fetchIRacingData(token, "https://members-ng.iracing.com/data/stats/member_yearly"),
    fetchIRacingData(token, "https://members-ng.iracing.com/data/member/chart_data?chart_type=1&category_id=5"),
    fetchIRacingData(token, "https://members-ng.iracing.com/data/member/chart_data?chart_type=3&category_id=5"),
  ]);

  const sportsCar = careerData?.stats?.find(s => s.category_id === 5) || {};

  let irChange = 0, currentIR = user.lastIRating ?? 0;
  if (irChartData?.data?.length >= 2) {
    const pts = irChartData.data;
    currentIR = pts[pts.length - 1].value;
    irChange  = pts[pts.length - 1].value - pts[pts.length - 2].value;
  }

  let srChange = 0, currentSR = 0, rawSR = 0;
  if (srChartData?.data?.length >= 2) {
    const pts  = srChartData.data;
    rawSR      = pts[pts.length - 1].value;
    const prev = pts[pts.length - 2].value;
    currentSR  = (rawSR % 1000) / 100;
    srChange   = (rawSR - prev) / 100;
  }

  const srClass = rawSR >= 4000 ? "A" : rawSR >= 3000 ? "B" : rawSR >= 2000 ? "C" : rawSR >= 1000 ? "D" : "R";

  const yearlyStats  = Array.isArray(recentData) ? recentData : (recentData?.stats || []);
  const seasonData   = yearlyStats.find(s => s.category_id === 5 && s.year === year) || {};

  const seasonStarts    = seasonData.starts    ?? 0;
  const seasonWins      = seasonData.wins      ?? 0;
  const seasonTop5      = seasonData.top5      ?? 0;
  const seasonPoles     = seasonData.poles     ?? 0;
  const seasonLaps      = seasonData.laps      ?? 0;
  const seasonLapsLed   = seasonData.laps_led  ?? 0;
  const seasonAvgStart  = seasonData.avg_start_position?.toFixed(2)  ?? "N/A";
  const seasonAvgFinish = seasonData.avg_finish_position?.toFixed(2) ?? "N/A";
  const seasonAvgPoints = seasonData.avg_points ? Math.round(seasonData.avg_points) : "N/A";
  const seasonWinPct    = seasonStarts > 0 ? Math.round((seasonWins  / seasonStarts) * 100) : 0;
  const seasonTop5Pct   = seasonStarts > 0 ? Math.round((seasonTop5  / seasonStarts) * 100) : 0;
  const seasonPolePct   = seasonStarts > 0 ? Math.round((seasonPoles / seasonStarts) * 100) : 0;

  let irPercentile = null;
  if (currentIR > 0) {
    if      (currentIR >= 6000) irPercentile = 99;
    else if (currentIR >= 5000) irPercentile = 98;
    else if (currentIR >= 4500) irPercentile = 97;
    else if (currentIR >= 4000) irPercentile = 96;
    else if (currentIR >= 3500) irPercentile = 93;
    else if (currentIR >= 3000) irPercentile = 88;
    else if (currentIR >= 2500) irPercentile = 78;
    else if (currentIR >= 2000) irPercentile = 65;
    else if (currentIR >= 1500) irPercentile = 50;
    else if (currentIR >= 1000) irPercentile = 30;
    else                        irPercentile = 15;
  }

  return {
    name: user.iracingName,
    currentIR, irChange, irPercentile,
    currentSR: currentSR.toFixed(2), srClass, srChange: srChange.toFixed(2),
    career: {
      starts:    sportsCar.starts    ?? 0,
      wins:      sportsCar.wins      ?? 0,
      top5:      sportsCar.top5      ?? 0,
      poles:     sportsCar.poles     ?? 0,
      laps:      sportsCar.laps      ?? 0,
      lapsLed:   sportsCar.laps_led  ?? 0,
      avgStart:  sportsCar.avg_start_position?.toFixed(2)  ?? "N/A",
      avgFinish: sportsCar.avg_finish_position?.toFixed(2) ?? "N/A",
      avgPoints: sportsCar.avg_points ? Math.round(sportsCar.avg_points) : "N/A",
      winPct:    sportsCar.starts > 0 ? Math.round((sportsCar.wins  / sportsCar.starts) * 100) : 0,
      top5Pct:   sportsCar.starts > 0 ? Math.round(((sportsCar.top5 ?? 0) / sportsCar.starts) * 100) : 0,
      polePct:   sportsCar.starts > 0 ? Math.round((sportsCar.poles / sportsCar.starts) * 100) : 0,
    },
    season: {
      starts: seasonStarts, wins: seasonWins, top5: seasonTop5, poles: seasonPoles,
      laps: seasonLaps, lapsLed: seasonLapsLed,
      avgStart: seasonAvgStart, avgFinish: seasonAvgFinish, avgPoints: seasonAvgPoints,
      winPct: seasonWinPct, top5Pct: seasonTop5Pct, polePct: seasonPolePct,
    }
  };
}

// ====================== STATS CARD ======================
const B64_CARBON = "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";
const B64_LOGO   = "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";

// Fetch Discord avatar as base64; falls back to GSR logo if missing/default
async function getAvatarBase64(discordUser) {
  try {
    const avatarUrl = discordUser.displayAvatarURL({ extension: "png", size: 256, forceStatic: true });
    const res = await fetch(avatarUrl);
    if (!res.ok) return B64_LOGO;
    const buf = await res.buffer();
    return buf.toString("base64");
  } catch {
    return B64_LOGO;
  }
}

function buildStatsHTML(stats, avatarB64) {
  const { label: seasonLabel } = getCurrentSeason();

  const irChangeText = stats.irChange >= 0 ? `+${stats.irChange}` : `${stats.irChange}`;
  const srChangeText = parseFloat(stats.srChange) >= 0 ? `+${stats.srChange}` : `${stats.srChange}`;
  const irPillClass  = stats.irChange > 0 ? "ir-pos" : stats.irChange < 0 ? "ir-neg" : "ir-neu";
  const srPillClass  = parseFloat(stats.srChange) > 0 ? "sr-pos" : parseFloat(stats.srChange) < 0 ? "sr-neg" : "sr-neu";
  const topPct       = stats.irPercentile !== null ? `Top ${100 - stats.irPercentile + 1}% Sports Car` : "";

  const licColors = { A: "#1565C0", B: "#2e7d32", C: "#e65100", D: "#b71c1c", R: "#37474f" };
  const licColor  = licColors[stats.srClass] || "#37474f";

  // Split driver name so last token gets lime colour
  const nameParts  = stats.name.trim().split(" ");
  const nameHTML   = nameParts.length >= 2
    ? nameParts.slice(0, -1).join(" ") + ` <span class="last">${nameParts[nameParts.length - 1]}</span>`
    : stats.name;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600;700&family=Barlow+Condensed:wght@400;600;700;800;900&display=swap');

  :root {
    --lime: #a8d000;
    --lime-bright: #c2f000;
    --lime-dim: rgba(168,208,0,0.15);
    --text: #ffffff;
    --text-muted: rgba(255,255,255,0.45);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 460px; height: 780px; background: #060606; overflow: hidden; }

  .card {
    width: 460px; height: 780px;
    border-radius: 20px;
    border: 3px solid var(--lime);
    position: relative; overflow: hidden;
    font-family: 'Chakra Petch', monospace;
    color: var(--text);
    display: flex; flex-direction: column;
    box-shadow:
      0 0 0 1px rgba(0,0,0,0.9),
      0 0 22px rgba(168,208,0,0.75),
      0 0 65px rgba(168,208,0,0.35),
      inset 0 1px 0 rgba(255,255,255,0.04);
  }

  .hero { position: relative; height: 230px; flex-shrink: 0; overflow: hidden; }

  .hero-carbon {
    position: absolute; inset: 0;
    background-image: url('data:image/png;base64,${B64_CARBON}');
    background-size: cover; background-position: center;
  }
  .hero-fade {
    position: absolute; inset: 0;
    background: linear-gradient(180deg,
      rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.2) 40%,
      rgba(6,6,6,0.85) 85%, rgba(6,6,6,1.0) 100%
    );
    z-index: 1;
  }
  .hero-logo-bg {
    position: absolute; top: 0; right: 0;
    width: 160px; height: 110px; z-index: 2;
    background-image: url('data:image/png;base64,${B64_LOGO}');
    background-size: 140px auto;
    background-repeat: no-repeat;
    background-position: right 10px top 10px;
    -webkit-mask-image: radial-gradient(ellipse 80% 80% at 80% 20%, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.3) 45%, transparent 75%);
    mask-image: radial-gradient(ellipse 80% 80% at 80% 20%, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.3) 45%, transparent 75%);
    filter: brightness(0.7) saturate(0.85);
  }
  .hero-topbar {
    position: absolute; top: 0; left: 0; right: 0; z-index: 4;
    display: flex; align-items: center; justify-content: space-between;
    padding: 11px 14px;
    background: linear-gradient(180deg, rgba(0,0,0,0.65) 0%, transparent 100%);
  }
  .series-tag {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 10px; font-weight: 700; letter-spacing: 0.2em;
    color: var(--lime); text-transform: uppercase;
    background: var(--lime-dim); border: 1px solid rgba(168,208,0,0.4);
    padding: 3px 9px; border-radius: 3px;
  }
  .lic-badge {
    position: absolute; top: 42px; left: 0; z-index: 4;
    padding: 6px 12px 6px 14px; border-radius: 0 8px 8px 0;
    display: flex; flex-direction: column; align-items: center;
    background: ${licColor};
    box-shadow: 4px 0 14px rgba(0,0,0,0.5);
  }
  .lic-class { font-family: 'Barlow Condensed', sans-serif; font-size: 26px; font-weight: 900; color: #fff; line-height: 1; }
  .lic-sr    { font-size: 11px; font-weight: 700; color: rgba(255,255,255,0.85); }

  .ir-badge {
    position: absolute; top: 42px; right: 0; z-index: 4;
    background: var(--lime); padding: 6px 14px 6px 12px;
    border-radius: 8px 0 0 8px; text-align: center;
    box-shadow: -4px 0 14px rgba(168,208,0,0.4);
  }
  .ir-badge-val { font-family: 'Barlow Condensed', sans-serif; font-size: 30px; font-weight: 900; line-height: 1; color: #0a0a0a; }
  .ir-badge-lbl { font-size: 7px; font-weight: 700; letter-spacing: 0.18em; color: rgba(0,0,0,0.6); text-transform: uppercase; }

  .avatar-wrap {
    position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
    z-index: 3; width: 140px; height: 140px; border-radius: 50%;
    border: 3px solid var(--lime);
    box-shadow: 0 0 16px rgba(168,208,0,0.6), 0 0 40px rgba(168,208,0,0.2);
    overflow: hidden; background: #111;
  }
  .avatar-wrap img { width: 100%; height: 100%; object-fit: cover; }

  .nameplate {
    flex-shrink: 0; text-align: center; padding: 6px 14px 8px;
    background: rgba(6,6,6,0.98);
    border-bottom: 1px solid rgba(168,208,0,0.15);
  }
  .driver-name {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 46px; font-weight: 900; line-height: 0.9;
    letter-spacing: 0.02em; text-transform: uppercase; color: #fff;
    text-shadow: 0 0 30px rgba(168,208,0,0.15);
  }
  .driver-name .last { color: var(--lime); }

  .change-pills { display: flex; justify-content: center; gap: 8px; margin-top: 6px; }
  .pill {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 12px; font-weight: 700;
    padding: 2px 11px; border-radius: 999px; letter-spacing: 0.04em;
  }
  .sr-neg { background: rgba(255,70,70,0.15);   color: #f87171; border: 1px solid rgba(255,70,70,0.3); }
  .sr-pos { background: rgba(168,208,0,0.14);   color: var(--lime-bright); border: 1px solid rgba(168,208,0,0.3); }
  .sr-neu { background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.4); border: 1px solid rgba(255,255,255,0.1); }
  .ir-pos { background: rgba(34,197,94,0.15);   color: #4ade80; border: 1px solid rgba(34,197,94,0.35); }
  .ir-neg { background: rgba(239,68,68,0.15);   color: #f87171; border: 1px solid rgba(239,68,68,0.35); }
  .ir-neu { background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.4); border: 1px solid rgba(255,255,255,0.1); }

  .stripe {
    height: 3px; flex-shrink: 0;
    background: linear-gradient(90deg, transparent 0%, var(--lime) 20%, var(--lime) 80%, transparent 100%);
  }

  .body { flex: 1; display: flex; flex-direction: column; position: relative; overflow: hidden; }
  .body-carbon {
    position: absolute; inset: 0;
    background-image: url('data:image/png;base64,${B64_CARBON}');
    background-size: cover; background-position: center bottom;
  }
  .body-overlay { position: absolute; inset: 0; background: rgba(6,6,6,0.83); }
  .body-inner {
    position: relative; z-index: 1;
    padding: 9px 14px 0; flex: 1; display: flex; flex-direction: column;
  }

  .sec-title {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 10px; font-weight: 700; letter-spacing: 0.24em;
    color: var(--lime); text-transform: uppercase;
    display: flex; align-items: center; gap: 8px; margin-bottom: 7px;
  }
  .sec-title::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(168,208,0,0.3), transparent); }

  .big-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-bottom: 8px; }
  .bstat {
    background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.07);
    border-radius: 7px; padding: 7px 10px 6px; position: relative; overflow: hidden;
  }
  .bstat::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
    background: rgba(168,208,0,0.28); border-radius: 7px 0 0 7px;
  }
  .bstat.hot { border-color: rgba(168,208,0,0.22); background: rgba(168,208,0,0.09); }
  .bstat.hot::before { background: var(--lime); }

  .bv    { font-family: 'Barlow Condensed', sans-serif; font-size: 28px; font-weight: 700; line-height: 1; color: #fff; }
  .bv.sm { font-size: 19px; }
  .bl    { font-size: 9px; letter-spacing: 0.12em; color: rgba(255,255,255,0.55); text-transform: uppercase; margin-top: 2px; }
  .bp    { font-size: 11px; font-weight: 700; color: var(--lime); margin-top: 1px; }

  .table-head { display: flex; padding: 0 8px 3px; }
  .th-sp { flex: 1; }
  .th-s  { width: 76px; text-align: center; font-size: 9px; font-weight: 700; letter-spacing: 0.16em; color: var(--lime); text-transform: uppercase; }
  .th-c  { width: 76px; text-align: right;  font-size: 9px; font-weight: 700; letter-spacing: 0.16em; color: rgba(255,255,255,0.75); text-transform: uppercase; }

  .trow { display: flex; align-items: center; padding: 4px 8px; border-radius: 5px; }
  .trow:nth-child(odd)  { background: rgba(0,0,0,0.32); }
  .trow:nth-child(even) { background: rgba(0,0,0,0.12); }

  .tl  { flex: 1; font-size: 10.5px; letter-spacing: 0.1em; color: rgba(255,255,255,0.82); text-transform: uppercase; }
  .tvs { width: 76px; text-align: center; font-family: 'Barlow Condensed', sans-serif; font-size: 16px; font-weight: 700; color: #ffffff; }
  .tvc { width: 76px; text-align: right;  font-family: 'Barlow Condensed', sans-serif; font-size: 16px; font-weight: 600; color: rgba(255,255,255,0.72); }

  .footer {
    flex-shrink: 0; height: 32px;
    background: rgba(0,0,0,0.72);
    border-top: 1px solid rgba(168,208,0,0.18);
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 14px; position: relative; z-index: 2;
  }
  .ft { font-family: 'Barlow Condensed', sans-serif; font-size: 11px; letter-spacing: 0.1em; color: rgba(255,255,255,0.55); text-transform: uppercase; font-weight: 600; }
  .fp { font-family: 'Barlow Condensed', sans-serif; font-size: 11px; letter-spacing: 0.1em; color: rgba(168,208,0,0.85); font-weight: 700; }
</style>
</head>
<body>
<div class="card">

  <div class="hero">
    <div class="hero-carbon"></div>
    <div class="hero-fade"></div>
    <div class="hero-logo-bg"></div>
    <div class="hero-topbar">
      <span class="series-tag">Sports Car · ${seasonLabel}</span>
    </div>
    <div class="lic-badge">
      <span class="lic-class">${stats.srClass} ${stats.currentSR}</span>
      <span class="lic-sr">Safety Rating</span>
    </div>
    <div class="ir-badge">
      <div class="ir-badge-val">${stats.currentIR.toLocaleString()}</div>
      <div class="ir-badge-lbl">iRating</div>
    </div>
    <div class="avatar-wrap">
      <img src="data:image/png;base64,${avatarB64}" alt="avatar"/>
    </div>
  </div>

  <div class="nameplate">
    <div class="driver-name">${nameHTML}</div>
    <div class="change-pills">
      <span class="pill ${srPillClass}">SR ${srChangeText}</span>
      <span class="pill ${irPillClass}">iR ${irChangeText}</span>
    </div>
  </div>

  <div class="stripe"></div>

  <div class="body">
    <div class="body-carbon"></div>
    <div class="body-overlay"></div>
    <div class="body-inner">

      <div class="sec-title">Season Highlights</div>
      <div class="big-stats">
        <div class="bstat hot"><div class="bv">${stats.season.starts}</div><div class="bl">Starts</div></div>
        <div class="bstat hot"><div class="bv">${stats.season.wins}</div><div class="bl">Wins</div><div class="bp">${stats.season.winPct}%</div></div>
        <div class="bstat hot"><div class="bv">${stats.season.poles}</div><div class="bl">Poles</div><div class="bp">${stats.season.polePct}%</div></div>
        <div class="bstat"><div class="bv">${stats.season.top5}</div><div class="bl">Top 5</div><div class="bp">${stats.season.top5Pct}%</div></div>
        <div class="bstat"><div class="bv sm">${stats.season.avgStart}</div><div class="bl">Avg Start</div></div>
        <div class="bstat"><div class="bv sm">${stats.season.avgFinish}</div><div class="bl">Avg Finish</div></div>
      </div>

      <div class="sec-title">Season vs Career</div>
      <div class="table-head">
        <div class="th-sp"></div>
        <div class="th-s">Season</div>
        <div class="th-c">Career</div>
      </div>
      <div class="trow"><span class="tl">Starts</span><span class="tvs">${stats.season.starts}</span><span class="tvc">${stats.career.starts}</span></div>
      <div class="trow"><span class="tl">Wins</span><span class="tvs">${stats.season.wins} (${stats.season.winPct}%)</span><span class="tvc">${stats.career.wins} (${stats.career.winPct}%)</span></div>
      <div class="trow"><span class="tl">Top 5</span><span class="tvs">${stats.season.top5} (${stats.season.top5Pct}%)</span><span class="tvc">${stats.career.top5} (${stats.career.top5Pct}%)</span></div>
      <div class="trow"><span class="tl">Total Laps</span><span class="tvs">${stats.season.laps}</span><span class="tvc">${stats.career.laps}</span></div>
      <div class="trow"><span class="tl">Laps Led</span><span class="tvs">${stats.season.lapsLed}</span><span class="tvc">${stats.career.lapsLed}</span></div>
      <div class="trow"><span class="tl">Avg Points</span><span class="tvs">${stats.season.avgPoints}</span><span class="tvc">${stats.career.avgPoints}</span></div>

    </div>
    <div class="footer">
      <span class="ft">Gamma Sim Racing · iRacing Data</span>
      <span class="fp">${topPct}</span>
    </div>
  </div>

</div>
</body>
</html>`;
}

async function renderStatsCard(stats, avatarB64) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 460, height: 780, deviceScaleFactor: 2 });
    await page.setContent(buildStatsHTML(stats, avatarB64), { waitUntil: "networkidle0" });
    return await page.screenshot({ type: "png" });
  } finally {
    await browser.close();
  }
}

// ====================== EXPRESS ======================
const app = express();
const PORT          = process.env.PORT || 3000;
const AUTHORIZE_URL = "https://oauth.iracing.com/oauth2/authorize";
const TOKEN_URL     = "https://oauth.iracing.com/oauth2/token";
const pkceStore     = {};
const TEN_MINUTES   = 10 * 60 * 1000;

app.get("/oauth/login", (req, res) => {
  const state         = req.query.state || "unknown";
  const codeVerifier  = crypto.randomBytes(64).toString("hex");
  const hash          = crypto.createHash("sha256").update(codeVerifier).digest("base64");
  const codeChallenge = hash.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  pkceStore[state] = { verifier: codeVerifier, createdAt: Date.now() };
  for (const key of Object.keys(pkceStore)) {
    if (Date.now() - pkceStore[key].createdAt > TEN_MINUTES) delete pkceStore[key];
  }

  const authUrl = `${AUTHORIZE_URL}?response_type=code&client_id=${encodeURIComponent(IRACING_CLIENT_ID)}&redirect_uri=${encodeURIComponent(IRACING_REDIRECT_URI)}&scope=iracing.auth iracing.profile&state=${encodeURIComponent(state)}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
  res.redirect(authUrl);
});

app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing authorization code.");

  const discordId = req.query.state || "unknown";
  const pkceEntry = pkceStore[discordId];
  delete pkceStore[discordId];

  if (!pkceEntry) return res.status(400).send("OAuth session expired. Please try linking again.");
  if (Date.now() - pkceEntry.createdAt > TEN_MINUTES) return res.status(400).send("OAuth session expired. Please try linking again.");

  try {
    const maskedSecret = maskSecret(IRACING_CLIENT_SECRET, IRACING_CLIENT_ID);
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: IRACING_CLIENT_ID,
        client_secret: maskedSecret, code,
        redirect_uri: IRACING_REDIRECT_URI, code_verifier: pkceEntry.verifier
      }).toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error) return res.status(400).send(`OAuth Error: ${tokenData.error || "Unknown"}`);

    const profileRes = await fetch("https://oauth.iracing.com/oauth2/iracing/profile", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    let iracingName = "Unknown";
    let customerId  = null;
    if (profileRes.ok) {
      const profileJson = await profileRes.json();
      if (profileJson.iracing_name) {
        const parts = profileJson.iracing_name.trim().split(/\s+/);
        iracingName = parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
      }
      customerId = profileJson.iracing_cust_id ?? null;
    }

    let drivers = loadLinkedDrivers();
    const existing = drivers.find(d => d.discordId === discordId);
    drivers = drivers.filter(d => d.discordId !== discordId);
    drivers.push({
      discordId, iracingName, customerId,
      accessToken:  tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt:    Date.now() + tokenData.expires_in * 1000,
      lastIRating:  existing?.lastIRating,
      lastChange:   existing?.lastChange,
      lastRank:     existing?.lastRank,
    });
    saveLinkedDrivers(drivers);
    res.send(`✅ Linked as <b>${iracingName}</b>!<br><br>You can now close this window.`);
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).send("Linking failed.");
  }
});

app.get("/", (req, res) => res.send("🏁 GSR Bot OAuth Server is running."));
app.listen(PORT, () => console.log(`🌐 OAuth server running on port ${PORT}`));

// ====================== DISCORD CLIENT ======================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", () => {
  console.log("✅ Bot logged in!");
  checkIRacingNews();
  setInterval(checkIRacingNews, 60 * 60 * 1000);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    return interaction.reply("🏁 Pong!");
  }

  if (interaction.commandName === "link") {
    const state    = encodeURIComponent(interaction.user.id);
    const loginUrl = `https://www.gsracing.app/oauth/login?state=${state}`;
    return interaction.reply({ content: `🔗 Link your iRacing account: ${loginUrl}`, flags: 64 });
  }

  if (interaction.commandName === "unlinkme") {
    let drivers = loadLinkedDrivers();
    const initial = drivers.length;
    drivers = drivers.filter(d => d.discordId !== interaction.user.id);
    if (drivers.length < initial) {
      saveLinkedDrivers(drivers);
      return interaction.reply({ content: "✅ You have been unlinked from the leaderboard.", flags: 64 });
    }
    return interaction.reply({ content: "You were not linked.", flags: 64 });
  }

  if (interaction.commandName === "unlink") {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: "❌ Administrators only.", flags: 64 });
    }
    const target = interaction.options.getUser("user");
    if (!target) return interaction.reply({ content: "Please select a user.", flags: 64 });

    let drivers = loadLinkedDrivers();
    const initial = drivers.length;
    drivers = drivers.filter(d => d.discordId !== target.id);
    if (drivers.length < initial) {
      saveLinkedDrivers(drivers);
      return interaction.reply({ content: `✅ Unlinked **${target.tag}**.`, flags: 64 });
    }
    return interaction.reply({ content: "That user was not linked.", flags: 64 });
  }

  if (interaction.commandName === "unlinkname") {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: "❌ Administrators only.", flags: 64 });
    }

    const inputName = interaction.options.getString("name").trim().toLowerCase();
    const drivers   = loadLinkedDrivers();
    const matches   = drivers.filter(d => d.iracingName?.toLowerCase().includes(inputName));

    if (matches.length === 0) {
      const names = drivers.map((d, i) => `${i + 1}. ${d.iracingName}`).join("\n") || "None";
      return interaction.reply({
        content: `❌ No driver found matching **"${inputName}"**.\n\nCurrently linked:\n` + "```" + `\n${names}\n` + "```",
        flags: 64
      });
    }
    if (matches.length > 1) {
      const names = matches.map(d => d.iracingName).join("\n");
      return interaction.reply({
        content: `⚠️ Multiple matches for **"${inputName}"**. Be more specific:\n` + "```" + `\n${names}\n` + "```",
        flags: 64
      });
    }

    const removed    = matches[0];
    const newDrivers = drivers.filter(d => d.discordId !== removed.discordId);
    saveLinkedDrivers(newDrivers);
    return interaction.reply({ content: `✅ Unlinked **${removed.iracingName}**.`, flags: 64 });
  }

  if (interaction.commandName === "myirating") {
    const drivers = loadLinkedDrivers();
    const driver  = drivers.find(d => d.discordId === interaction.user.id);
    if (!driver) return interaction.reply({ content: "You are not linked yet. Use `/link` first!", flags: 64 });

    const current    = driver.lastIRating ?? "??";
    const changeText = driver.lastChange === undefined ? "No change yet"
      : driver.lastChange > 0 ? `**+${driver.lastChange}**` : `**${driver.lastChange}**`;

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle("📊 Your iRating")
        .setColor(0x00ff88)
        .addFields(
          { name: "iRacing Name",    value: driver.iracingName || "Unknown", inline: true },
          { name: "Current iRating", value: current.toString(),              inline: true },
          { name: "Change",          value: changeText,                      inline: true },
          { name: "Current Rank",    value: driver.lastRank ? `#${driver.lastRank}` : "Not ranked yet", inline: true }
        )
        .setTimestamp()
      ]
    });
  }

  if (interaction.commandName === "leaderboard") await showLeaderboard(interaction);
  if (interaction.commandName === "stats")       await showStats(interaction);
});

// ====================== STATS COMMAND ======================
async function showStats(interaction) {
  await interaction.deferReply();
  try {
    const drivers = loadLinkedDrivers();
    const driver  = drivers.find(d => d.discordId === interaction.user.id);
    if (!driver) return interaction.editReply({ content: "❌ You are not linked yet. Use `/link` first!" });

    // Fetch Discord avatar; automatically falls back to GSR logo if none set
    const avatarB64   = await getAvatarBase64(interaction.user);
    const stats       = await fetchDriverStats(driver);
    const imageBuffer = await renderStatsCard(stats, avatarB64);
    await interaction.editReply({ files: [new AttachmentBuilder(imageBuffer, { name: "stats.png" })] });
  } catch (err) {
    console.error("Stats error:", err);
    await interaction.editReply({ content: "❌ Failed to load stats. Please try again." }).catch(() => {});
  }
}

// ====================== LEADERBOARD ======================
async function showLeaderboard(interactionOrChannel, saveBaseline = false) {
  const isInteraction = !!(interactionOrChannel.deferReply);

  try {
    let drivers = loadLinkedDrivers();
    if (drivers.length === 0) {
      const msg = { content: "No drivers linked yet." };
      return isInteraction
        ? interactionOrChannel.reply({ ...msg, flags: 64 })
        : interactionOrChannel.send(msg);
    }

    if (isInteraction) await interactionOrChannel.deferReply();

    for (const driver of drivers) {
      try {
        const ir = await getCurrentIRating(driver);
        if (ir !== null) {
          const old          = driver.lastIRating ?? ir;
          driver.lastIRating = ir;
          driver.lastChange  = ir - old;
        }
      } catch (e) {}
    }

    drivers.sort((a, b) => (b.lastIRating ?? 0) - (a.lastIRating ?? 0));
    drivers.forEach((d, i) => d.lastRank = i + 1);

    if (saveBaseline) {
      saveLinkedDrivers(drivers);
      console.log("Weekly baseline saved.");
    }

    const embedColor   = drivers[0]?.lastChange > 0 ? 0x00cc66 : drivers[0]?.lastChange < 0 ? 0xff4444 : 0x00ff88;
    const totalDrivers = drivers.length;
    const displayed    = Math.min(totalDrivers, 20);

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setThumbnail("https://cdn.discordapp.com/attachments/1396172486558613514/1402298298450186350/Maybe.png?ex=699a6acf&is=6999194f&hm=5bd0de5d8200e0af87742858135e252c608bc6ad1d144046203fee96edbd8d17&")
      .setDescription("**🏁 GSR iRating Leaderboard**")
      .setTimestamp();

    drivers.slice(0, 20).forEach((d, i) => {
      const medal  = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}️⃣`;
      const change = d.lastChange === undefined ? ""
        : d.lastChange > 0 ? ` 🟢 **+${d.lastChange}** ⬆️`
        : d.lastChange < 0 ? ` 🔴 **${d.lastChange}** ⬇️`
        : ` ⚪ **0**`;
      embed.addFields({
        name:   `${medal} **${i + 1}.** ${d.iracingName || "Unknown"}`,
        value:  `**${d.lastIRating ?? "??"}** iR${change}`,
        inline: false
      });
    });

    embed.setFooter({
      text: displayed < totalDrivers
        ? `Showing top ${displayed} of ${totalDrivers} drivers`
        : `Total drivers: ${totalDrivers}`
    });

    if (isInteraction) await interactionOrChannel.editReply({ embeds: [embed] });
    else               await interactionOrChannel.send({ embeds: [embed] });

  } catch (err) {
    console.error("Leaderboard error:", err);
    if (isInteraction) {
      const fn = interactionOrChannel.deferred
        ? interactionOrChannel.editReply.bind(interactionOrChannel)
        : interactionOrChannel.reply.bind(interactionOrChannel);
      await fn({ content: "❌ Failed to load leaderboard. Please try again." }).catch(() => {});
    }
  }
}

// ====================== REGISTER COMMANDS ======================
const commands = [
  { name: "ping",        description: "Test bot" },
  { name: "link",        description: "Link your iRacing account" },
  { name: "unlinkme",    description: "Unlink yourself from the leaderboard" },
  {
    name: "unlink",
    description: "Admin: Unlink a driver still in the server",
    options: [{ name: "user", description: "User to unlink", type: 6, required: true }]
  },
  {
    name: "unlinkname",
    description: "Admin: Unlink a driver by iRacing name (works after they leave)",
    options: [{ name: "name", description: "Full or partial iRacing name", type: 3, required: true }]
  },
  { name: "myirating",   description: "Show your personal iRating and rank" },
  { name: "leaderboard", description: "Show the GSR iRating Leaderboard" },
  { name: "stats",       description: "Show your Sports Car stats card" }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Commands registered.");
  } catch (err) {
    console.error("Command registration error:", err);
  }
})();

client.login(DISCORD_TOKEN);

// ====================== CRON ======================
// Runs every Sunday at noon CST (18:00 UTC). saveBaseline=true so this is
// the only call that updates lastIRating/lastChange in storage.
const { CronJob } = require("cron");
new CronJob("0 12 * * 0", async () => {
  const channel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
  if (channel) await showLeaderboard(channel, true);
}, null, true, "America/Chicago");