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

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !IRACING_CLIENT_ID ||
    !IRACING_CLIENT_SECRET || !IRACING_REDIRECT_URI || !ANNOUNCE_CHANNEL_ID) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

// ====================== STORAGE ======================
const DATA_DIR    = "/app/data";
const LINKED_FILE = path.join(DATA_DIR, "linked-drivers.json");

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

// ====================== STATS FETCHER ======================
async function fetchDriverStats(user) {
  const token = await getValidAccessToken(user);

  const [careerData, recentData, irChartData, srChartData] = await Promise.all([
    fetchIRacingData(token, "https://members-ng.iracing.com/data/stats/member_career"),
    fetchIRacingData(token, "https://members-ng.iracing.com/data/stats/member_recent_races"),
    fetchIRacingData(token, "https://members-ng.iracing.com/data/member/chart_data?chart_type=1&category_id=5"),
    fetchIRacingData(token, "https://members-ng.iracing.com/data/member/chart_data?chart_type=3&category_id=5"),
  ]);

  const sportsCar = careerData?.stats?.find(s => s.category_id === 5) || {};

  // iRating
  let irChange = 0, currentIR = user.lastIRating ?? 0;
  if (irChartData?.data?.length >= 2) {
    const pts = irChartData.data;
    currentIR = pts[pts.length - 1].value;
    irChange  = pts[pts.length - 1].value - pts[pts.length - 2].value;
  }

  // Safety Rating — each class is 1000 wide: R=0-999, D=1000-1999, C=2000-2999, B=3000-3999, A=4000+
  let srChange = 0, currentSR = 0, rawSR = 0;
  if (srChartData?.data?.length >= 2) {
    const pts  = srChartData.data;
    rawSR      = pts[pts.length - 1].value;
    const prev = pts[pts.length - 2].value;
    currentSR  = (rawSR % 1000) / 100;
    srChange   = (rawSR - prev) / 100;
  }

  const srClass = rawSR >= 4000 ? "A" : rawSR >= 3000 ? "B" : rawSR >= 2000 ? "C" : rawSR >= 1000 ? "D" : "R";

  // Recent races
  const allRaces    = recentData?.races || [];
  const seasonRaces = allRaces.filter(r => r.category_id === 5);
  console.log(`Recent races: ${allRaces.length} total, Sports Car: ${seasonRaces.length}`);

  const seasonStarts    = seasonRaces.length;
  const seasonWins      = seasonRaces.filter(r => r.finish_position_in_class === 1).length;
  const seasonTop5      = seasonRaces.filter(r => r.finish_position_in_class <= 5).length;
  const seasonPoles     = seasonRaces.filter(r => r.starting_position_in_class === 1).length;
  const seasonLaps      = seasonRaces.reduce((a, r) => a + (r.laps_complete || 0), 0);
  const seasonLapsLed   = seasonRaces.reduce((a, r) => a + (r.laps_led || 0), 0);
  const seasonAvgStart  = seasonStarts > 0
    ? (seasonRaces.reduce((a, r) => a + (r.starting_position_in_class + 1 || 0), 0) / seasonStarts).toFixed(2) : "N/A";
  const seasonAvgFinish = seasonStarts > 0
    ? (seasonRaces.reduce((a, r) => a + (r.finish_position_in_class + 1 || 0), 0) / seasonStarts).toFixed(2) : "N/A";
  const seasonAvgPoints = seasonStarts > 0
    ? Math.round(seasonRaces.reduce((a, r) => a + (r.champ_points || 0), 0) / seasonStarts) : "N/A";

  // iRating percentile (approximate)
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
      winPct:    sportsCar.starts > 0 ? Math.round((sportsCar.wins / sportsCar.starts) * 100) : 0,
      top5Pct:   sportsCar.starts > 0 ? Math.round(((sportsCar.top5 ?? 0) / sportsCar.starts) * 100) : 0,
      polePct:   sportsCar.starts > 0 ? Math.round((sportsCar.poles / sportsCar.starts) * 100) : 0,
    },
    season: {
      starts: seasonStarts, wins: seasonWins, top5: seasonTop5, poles: seasonPoles,
      laps: seasonLaps, lapsLed: seasonLapsLed,
      avgStart: seasonAvgStart, avgFinish: seasonAvgFinish, avgPoints: seasonAvgPoints,
      winPct:  seasonStarts > 0 ? Math.round((seasonWins / seasonStarts) * 100) : 0,
      top5Pct: seasonStarts > 0 ? Math.round((seasonTop5 / seasonStarts) * 100) : 0,
      polePct: seasonStarts > 0 ? Math.round((seasonPoles / seasonStarts) * 100) : 0,
    }
  };
}

// ====================== STATS CARD ======================
function getSRColor(srClass) {
  switch (srClass) {
    case "A": return "#10b981";
    case "B": return "#3b82f6";
    case "C": return "#f59e0b";
    case "D": return "#f97316";
    default:  return "#6b7280";
  }
}

function buildStatsHTML(stats) {
  const srColor      = getSRColor(stats.srClass);
  const irChangeText = stats.irChange >= 0 ? `+${stats.irChange}` : `${stats.irChange}`;
  const srChangeText = parseFloat(stats.srChange) >= 0 ? `+${stats.srChange}` : `${stats.srChange}`;
  const irChangeCss  = stats.irChange > 0 ? "positive" : stats.irChange < 0 ? "negative" : "neutral";
  const srChangeCss  = parseFloat(stats.srChange) > 0 ? "positive" : parseFloat(stats.srChange) < 0 ? "negative" : "neutral";
  const topPct       = stats.irPercentile !== null ? `top ${100 - stats.irPercentile + 1}% of Sports Car drivers` : "";

  const rows = [
    { label: "Starts",     season: stats.season.starts,                                career: stats.career.starts },
    { label: "Wins",       season: `${stats.season.wins} (${stats.season.winPct}%)`,   career: `${stats.career.wins} (${stats.career.winPct}%)` },
    { label: "Top 5",      season: `${stats.season.top5} (${stats.season.top5Pct}%)`,  career: `${stats.career.top5} (${stats.career.top5Pct}%)` },
    { label: "Poles",      season: `${stats.season.poles} (${stats.season.polePct}%)`, career: `${stats.career.poles} (${stats.career.polePct}%)` },
    { label: "Total Laps", season: stats.season.laps,                                  career: stats.career.laps },
    { label: "Laps Led",   season: stats.season.lapsLed,                               career: stats.career.lapsLed },
    { label: "Avg Start",  season: stats.season.avgStart,                              career: stats.career.avgStart },
    { label: "Avg Finish", season: stats.season.avgFinish,                             career: stats.career.avgFinish },
    { label: "Avg Points", season: stats.season.avgPoints,                             career: stats.career.avgPoints },
  ];

  const rowsHTML = rows.map((row, i) => `
    <div class="row ${i % 2 === 0 ? "row-even" : ""}">
      <div class="cell cell-value">${row.season}</div>
      <div class="cell cell-label">${row.label}</div>
      <div class="cell cell-value">${row.career}</div>
    </div>
  `).join("");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 780px; height: 460px;
    background: #1a1a2e;
    font-family: 'Inter', 'Arial', sans-serif;
    color: #fff; overflow: hidden; position: relative;
  }
  .bg-gradient {
    position: absolute; inset: 0;
    background: linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(16,185,129,0.08) 100%);
  }
  .header {
    position: relative; background: #16213e;
    height: 80px; display: flex; align-items: center; padding: 0 18px;
  }
  .sr-badge {
    background: ${srColor}; border-radius: 8px; width: 72px; height: 44px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .sr-badge .sr-label { font-size: 11px; font-weight: 600; }
  .sr-badge .ir-val   { font-size: 13px; font-weight: 700; }
  .header-center { flex: 1; text-align: center; }
  .driver-name { font-size: 28px; font-weight: 700; line-height: 1.1; }
  .subtitle    { font-size: 14px; color: #a0aec0; margin-top: 2px; }
  .header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; min-width: 160px; }
  .percentile  { font-size: 12px; color: #a0aec0; }
  .pills       { display: flex; gap: 8px; }
  .pill        { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
  .pill.positive { background: rgba(16,185,129,0.2); color: #10b981; }
  .pill.negative { background: rgba(239,68,68,0.2);  color: #ef4444; }
  .pill.neutral  { background: rgba(107,114,128,0.2); color: #9ca3af; }
  .section-headers {
    display: flex; align-items: center;
    padding: 10px 18px 6px; position: relative;
  }
  .section-label { font-size: 12px; font-weight: 700; color: #6366f1; letter-spacing: 0.05em; }
  .section-label.right { margin-left: auto; }
  .section-center {
    position: absolute; left: 50%; transform: translateX(-50%);
    font-size: 11px; color: #4a5568; letter-spacing: 0.08em;
  }
  .divider { height: 1px; background: #2d3748; margin: 0 18px; }
  .row { display: flex; align-items: center; height: 34px; padding: 0 18px; border-radius: 6px; }
  .row-even { background: rgba(255,255,255,0.03); }
  .cell { flex: 1; font-size: 15px; font-weight: 700; color: #fff; }
  .cell-label { text-align: center; font-size: 13px; font-weight: 400; color: #a0aec0; }
  .cell:last-child { text-align: right; }
  .footer {
    position: absolute; bottom: 0; left: 0; right: 0; height: 28px;
    background: #2d3748; display: flex; align-items: center;
    justify-content: center; font-size: 11px; color: #718096;
  }
</style>
</head>
<body>
  <div class="bg-gradient"></div>
  <div class="header">
    <div class="sr-badge">
      <span class="sr-label">${stats.srClass} ${stats.currentSR}</span>
      <span class="ir-val">${stats.currentIR.toLocaleString()}</span>
    </div>
    <div class="header-center">
      <div class="driver-name">${stats.name}</div>
      <div class="subtitle">Sports Car &middot; 2026 Season 1</div>
    </div>
    <div class="header-right">
      <div class="percentile">${topPct}</div>
      <div class="pills">
        <div class="pill ${srChangeCss}">SR ${srChangeText}</div>
        <div class="pill ${irChangeCss}">iR ${irChangeText}</div>
      </div>
    </div>
  </div>
  <div class="section-headers">
    <span class="section-label">CURRENT SEASON</span>
    <span class="section-center">STAT</span>
    <span class="section-label right">CAREER</span>
  </div>
  <div class="divider"></div>
  <div class="content">${rowsHTML}</div>
  <div class="footer">GSR &middot; iRacing Sports Car Stats &middot; Data via iRacing Members API</div>
</body>
</html>`;
}

async function renderStatsCard(stats) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 780, height: 460, deviceScaleFactor: 2 });
    await page.setContent(buildStatsHTML(stats), { waitUntil: "networkidle0" });
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
  const code      = req.query.code;
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
      console.log(`Profile fields: ${Object.keys(profileJson).join(", ")}`);
      console.log(`Linked: ${iracingName}, customerId: ${customerId}`);
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

client.once("clientReady", () => console.log("✅ Bot logged in!"));

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
        content: `❌ No driver found matching **"${inputName}"**.\n\nCurrently linked:\n\`\`\`\n${names}\n\`\`\``,
        flags: 64
      });
    }
    if (matches.length > 1) {
      const names = matches.map(d => d.iracingName).join("\n");
      return interaction.reply({
        content: `⚠️ Multiple matches for **"${inputName}"**. Be more specific:\n\`\`\`\n${names}\n\`\`\``,
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

// ====================== STATS ======================
async function showStats(interaction) {
  await interaction.deferReply();
  try {
    const drivers = loadLinkedDrivers();
    const driver  = drivers.find(d => d.discordId === interaction.user.id);
    if (!driver) return interaction.editReply({ content: "❌ You are not linked yet. Use `/link` first!" });

    const stats       = await fetchDriverStats(driver);
    const imageBuffer = await renderStatsCard(stats);
    await interaction.editReply({ files: [new AttachmentBuilder(imageBuffer, { name: "stats.png" })] });
  } catch (err) {
    console.error("Stats error:", err);
    await interaction.editReply({ content: "❌ Failed to load stats. Please try again." }).catch(() => {});
  }
}

// ====================== LEADERBOARD ======================
async function showLeaderboard(interactionOrChannel) {
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
    saveLinkedDrivers(drivers);

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
const { CronJob } = require("cron");
new CronJob("0 12 * * *", async () => {
  const channel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
  if (channel) await showLeaderboard(channel);
}, null, true, "America/Chicago");