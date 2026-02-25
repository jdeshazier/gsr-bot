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
const os = require("os");
const https = require("https");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

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

// ====================== FONT REGISTRATION ======================
const SYSTEM_FONT_PATHS = [
  { regular: "/usr/share/fonts/truetype/google-fonts/Poppins-Regular.ttf",
    bold:    "/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf",
    name:    "Poppins" },
  { regular: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    bold:    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    name:    "DejaVu Sans" },
];

let FONT_NAME = "Poppins";

function registerFont() {
  for (const entry of SYSTEM_FONT_PATHS) {
    if (fs.existsSync(entry.regular) && fs.existsSync(entry.bold)) {
      try {
        GlobalFonts.registerFromPath(entry.regular, entry.name);
        GlobalFonts.registerFromPath(entry.bold, entry.name);
        FONT_NAME = entry.name;
        console.log(`✅ Fonts registered: ${entry.name}`);
        return;
      } catch (e) {
        console.warn(`Font registration failed for ${entry.name}:`, e.message);
      }
    }
  }
  console.log("No system fonts found — downloading Inter as fallback...");
  downloadAndRegisterInter();
}

function downloadAndRegisterInter() {
  const regularPath = path.join(os.tmpdir(), "inter-regular.ttf");
  const boldPath    = path.join(os.tmpdir(), "inter-bold.ttf");
  const downloads   = [
    { url: "https://github.com/rsms/inter/raw/master/docs/font-files/Inter-Regular.ttf", dest: regularPath },
    { url: "https://github.com/rsms/inter/raw/master/docs/font-files/Inter-Bold.ttf",    dest: boldPath },
  ];
  let completed = 0;
  for (const dl of downloads) {
    if (fs.existsSync(dl.dest)) { completed++; continue; }
    const file = fs.createWriteStream(dl.dest);
    https.get(dl.url, res => {
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        completed++;
        if (completed === downloads.length) {
          GlobalFonts.registerFromPath(regularPath, "Inter");
          GlobalFonts.registerFromPath(boldPath,    "Inter");
          FONT_NAME = "Inter";
          console.log("✅ Inter fonts downloaded and registered.");
        }
      });
    }).on("error", err => console.error("Font download error:", err.message));
  }
}

// ====================== STORAGE ======================
const DATA_DIR   = "/app/data";
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
  const input = secret + normalizedId;
  return crypto.createHash("sha256").update(input).digest("base64");
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
  return user.accessToken;
}

async function getCurrentIRating(user) {
  try {
    const token   = await getValidAccessToken(user);
    const rootUrl = "https://members-ng.iracing.com/data/member/chart_data?chart_type=1&category_id=5";
    const rootRes = await fetch(rootUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!rootRes.ok) return null;

    const rootJson = await rootRes.json();
    let chartUrl   = rootUrl;
    if (rootJson.link) chartUrl = rootJson.link;

    const chartRes  = await fetch(chartUrl);
    if (!chartRes.ok) return null;

    const chartJson = await chartRes.json();
    if (chartJson.data && chartJson.data.length > 0) {
      return chartJson.data[chartJson.data.length - 1].value;
    }
  } catch (e) {}
  return null;
}

async function fetchIRacingData(token, url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const json = await res.json();
  if (json.link) {
    const dataRes = await fetch(json.link);
    if (!dataRes.ok) return null;
    return dataRes.json();
  }
  return json;
}

// ====================== STATS FETCHER ======================
async function fetchDriverStats(user) {
  const token = await getValidAccessToken(user);

  const careerData  = await fetchIRacingData(token, "https://members-ng.iracing.com/data/stats/member_career");
  const recentData  = await fetchIRacingData(token, "https://members-ng.iracing.com/data/results/member_recent_races");
  const irChartData = await fetchIRacingData(token, "https://members-ng.iracing.com/data/member/chart_data?chart_type=1&category_id=5");
  const srChartData = await fetchIRacingData(token, "https://members-ng.iracing.com/data/member/chart_data?chart_type=2&category_id=5");

  const sportsCar = careerData?.stats?.find(s => s.category_id === 5) || {};

  let irChange = 0, currentIR = user.lastIRating ?? 0;
  if (irChartData?.data?.length >= 2) {
    const pts = irChartData.data;
    currentIR = pts[pts.length - 1].value;
    irChange  = pts[pts.length - 1].value - pts[pts.length - 2].value;
  }

  let srChange = 0, currentSR = 0;
  if (srChartData?.data?.length >= 2) {
    const pts = srChartData.data;
    currentSR = pts[pts.length - 1].value / 100;
    srChange  = (pts[pts.length - 1].value - pts[pts.length - 2].value) / 100;
  }

  const seasonRaces    = (recentData?.races || []).filter(r => r.category_id === 5);
  const seasonStarts   = seasonRaces.length;
  const seasonWins     = seasonRaces.filter(r => r.finish_position_in_class === 1).length;
  const seasonPodiums  = seasonRaces.filter(r => r.finish_position_in_class <= 3).length;
  const seasonPoles    = seasonRaces.filter(r => r.starting_position_in_class === 1).length;
  const seasonLaps     = seasonRaces.reduce((a, r) => a + (r.laps_complete || 0), 0);
  const seasonLapsLed  = seasonRaces.reduce((a, r) => a + (r.laps_led || 0), 0);
  const seasonAvgStart  = seasonStarts > 0 ? (seasonRaces.reduce((a, r) => a + (r.starting_position_in_class + 1 || 0), 0) / seasonStarts).toFixed(2) : "N/A";
  const seasonAvgFinish = seasonStarts > 0 ? (seasonRaces.reduce((a, r) => a + (r.finish_position_in_class + 1 || 0), 0) / seasonStarts).toFixed(2) : "N/A";
  const seasonAvgPoints = seasonStarts > 0 ? Math.round(seasonRaces.reduce((a, r) => a + (r.champ_points || 0), 0) / seasonStarts) : "N/A";

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

  const srClass = currentSR >= 4.0 ? "A" : currentSR >= 3.0 ? "B" : currentSR >= 2.0 ? "C" : currentSR >= 1.0 ? "D" : "R";

  return {
    name: user.iracingName,
    currentIR, irChange, irPercentile,
    currentSR: currentSR.toFixed(2), srClass, srChange: srChange.toFixed(2),
    career: {
      starts: sportsCar.starts ?? 0, wins: sportsCar.wins ?? 0, top5: sportsCar.top5 ?? 0,
      poles: sportsCar.poles ?? 0, laps: sportsCar.laps_complete ?? 0, lapsLed: sportsCar.laps_led ?? 0,
      avgStart:  sportsCar.avg_start_position?.toFixed(2)  ?? "N/A",
      avgFinish: sportsCar.avg_finish_position?.toFixed(2) ?? "N/A",
      avgPoints: sportsCar.avg_champ_points ? Math.round(sportsCar.avg_champ_points) : "N/A",
      winPct:    sportsCar.starts > 0 ? Math.round((sportsCar.wins / sportsCar.starts) * 100) : 0,
      podiumPct: sportsCar.starts > 0 ? Math.round(((sportsCar.top5 ?? 0) / sportsCar.starts) * 100) : 0,
      polePct:   sportsCar.starts > 0 ? Math.round((sportsCar.poles / sportsCar.starts) * 100) : 0,
    },
    season: {
      starts: seasonStarts, wins: seasonWins, podiums: seasonPodiums, poles: seasonPoles,
      laps: seasonLaps, lapsLed: seasonLapsLed,
      avgStart: seasonAvgStart, avgFinish: seasonAvgFinish, avgPoints: seasonAvgPoints,
      winPct:    seasonStarts > 0 ? Math.round((seasonWins    / seasonStarts) * 100) : 0,
      podiumPct: seasonStarts > 0 ? Math.round((seasonPodiums / seasonStarts) * 100) : 0,
      polePct:   seasonStarts > 0 ? Math.round((seasonPoles   / seasonStarts) * 100) : 0,
    }
  };
}

// ====================== STATS CARD RENDERER ======================
function renderStatsCard(stats) {
  const W = 780, H = 460;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");
  const F      = FONT_NAME;

  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, W, H);

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "rgba(99, 102, 241, 0.08)");
  grad.addColorStop(1, "rgba(16, 185, 129, 0.08)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#16213e";
  ctx.fillRect(0, 0, W, 80);

  const srColor = getSRColor(stats.srClass);
  ctx.fillStyle = srColor;
  roundRect(ctx, 18, 18, 72, 44, 8);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `11px "${F}"`;
  ctx.textAlign = "center";
  ctx.fillText(stats.srClass + " " + stats.currentSR, 54, 36);
  ctx.font = `bold 13px "${F}"`;
  ctx.fillText(stats.currentIR.toLocaleString(), 54, 54);

  ctx.fillStyle = "#ffffff";
  ctx.font = `bold 28px "${F}"`;
  ctx.textAlign = "center";
  ctx.fillText(stats.name, W / 2, 42);

  ctx.fillStyle = "#a0aec0";
  ctx.font = `14px "${F}"`;
  ctx.fillText("Sports Car · 2026 Season 1", W / 2, 64);

  if (stats.irPercentile !== null) {
    ctx.fillStyle = "#a0aec0";
    ctx.font = `12px "${F}"`;
    ctx.textAlign = "right";
    ctx.fillText(`top ${100 - stats.irPercentile + 1}% of Sports Car drivers`, W - 18, 36);
  }

  const irChangeText  = stats.irChange >= 0 ? `iR +${stats.irChange}` : `iR ${stats.irChange}`;
  const srChangeText  = parseFloat(stats.srChange) >= 0 ? `SR +${stats.srChange}` : `SR ${stats.srChange}`;
  const irChangeColor = stats.irChange > 0 ? "#10b981" : stats.irChange < 0 ? "#ef4444" : "#6b7280";
  const srChangeColor = parseFloat(stats.srChange) > 0 ? "#10b981" : parseFloat(stats.srChange) < 0 ? "#ef4444" : "#6b7280";

  drawPill(ctx, W - 18,      54, irChangeText, irChangeColor, "right", F);
  drawPill(ctx, W - 18 - 95, 54, srChangeText, srChangeColor, "right", F);

  ctx.fillStyle = "#6366f1";
  ctx.font = `bold 12px "${F}"`;
  ctx.textAlign = "left";
  ctx.fillText("CURRENT SEASON", 30, 105);
  ctx.textAlign = "right";
  ctx.fillText("CAREER", W - 30, 105);

  ctx.fillStyle = "#4a5568";
  ctx.font = `11px "${F}"`;
  ctx.textAlign = "center";
  ctx.fillText("STAT", W / 2, 105);

  ctx.strokeStyle = "#2d3748";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(30, 112);
  ctx.lineTo(W - 30, 112);
  ctx.stroke();

  const rows = [
    { label: "Starts",     season: stats.season.starts,                                    career: stats.career.starts },
    { label: "Wins",       season: `${stats.season.wins} (${stats.season.winPct}%)`,       career: `${stats.career.wins} (${stats.career.winPct}%)` },
    { label: "Podiums",    season: `${stats.season.podiums} (${stats.season.podiumPct}%)`, career: `${stats.career.top5} (${stats.career.podiumPct}%)` },
    { label: "Poles",      season: `${stats.season.poles} (${stats.season.polePct}%)`,     career: `${stats.career.poles} (${stats.career.polePct}%)` },
    { label: "Total Laps", season: stats.season.laps,                                      career: stats.career.laps },
    { label: "Laps Led",   season: stats.season.lapsLed,                                   career: stats.career.lapsLed },
    { label: "Avg Start",  season: stats.season.avgStart,                                  career: stats.career.avgStart },
    { label: "Avg Finish", season: stats.season.avgFinish,                                 career: stats.career.avgFinish },
    { label: "Avg Points", season: stats.season.avgPoints,                                 career: stats.career.avgPoints },
  ];

  const rowH = 34, startY = 128;
  rows.forEach((row, i) => {
    const y = startY + i * rowH;
    if (i % 2 === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      roundRect(ctx, 18, y - 2, W - 36, rowH - 2, 6);
      ctx.fill();
    }
    ctx.fillStyle = "#a0aec0";
    ctx.font = `13px "${F}"`;
    ctx.textAlign = "center";
    ctx.fillText(row.label, W / 2, y + 18);
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold 15px "${F}"`;
    ctx.textAlign = "left";
    ctx.fillText(String(row.season), 36, y + 19);
    ctx.textAlign = "right";
    ctx.fillText(String(row.career), W - 36, y + 19);
  });

  ctx.fillStyle = "#2d3748";
  ctx.fillRect(0, H - 28, W, 28);
  ctx.fillStyle = "#718096";
  ctx.font = `11px "${F}"`;
  ctx.textAlign = "center";
  ctx.fillText("GSR · iRacing Sports Car Stats · Data via iRacing Members API", W / 2, H - 10);

  return canvas.toBuffer("image/png");
}

function roundRect(ctx, x, y, w, h, r) {
  if (typeof r === "number") r = { tl: r, tr: r, br: r, bl: r };
  ctx.beginPath();
  ctx.moveTo(x + r.tl, y);
  ctx.lineTo(x + w - r.tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r.tr);
  ctx.lineTo(x + w, y + h - r.br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r.br, y + h);
  ctx.lineTo(x + r.bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r.bl);
  ctx.lineTo(x, y + r.tl);
  ctx.quadraticCurveTo(x, y, x + r.tl, y);
  ctx.closePath();
}

function drawPill(ctx, x, y, text, color, align = "left", fontName = "sans-serif") {
  const padding = 10;
  ctx.font = `bold 12px "${fontName}"`;
  const tw = ctx.measureText(text).width;
  const pw = tw + padding * 2;
  const px = align === "right" ? x - pw : x;
  ctx.fillStyle = color + "33";
  roundRect(ctx, px, y, pw, 20, 10);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = align === "right" ? "right" : "left";
  ctx.fillText(text, align === "right" ? x - padding : x + padding, y + 14);
}

function getSRColor(srClass) {
  switch (srClass) {
    case "A": return "#10b981";
    case "B": return "#3b82f6";
    case "C": return "#f59e0b";
    case "D": return "#f97316";
    default:  return "#6b7280";
  }
}

// ====================== EXPRESS ======================
const app = express();
const PORT         = process.env.PORT || 3000;
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
  console.log("Redirecting to:", authUrl);
  res.redirect(authUrl);
});

app.get("/oauth/callback", async (req, res) => {
  const code      = req.query.code;
  if (!code) return res.status(400).send("Missing authorization code.");

  const discordId = req.query.state || "unknown";
  const pkceEntry = pkceStore[discordId];
  delete pkceStore[discordId];

  if (!pkceEntry) return res.status(400).send("OAuth session expired or not found. Please try linking again.");
  if (Date.now() - pkceEntry.createdAt > TEN_MINUTES) return res.status(400).send("OAuth session expired. Please try linking again.");

  try {
    const maskedSecret = maskSecret(IRACING_CLIENT_SECRET, IRACING_CLIENT_ID);
    const body = new URLSearchParams({
      grant_type: "authorization_code", client_id: IRACING_CLIENT_ID,
      client_secret: maskedSecret, code,
      redirect_uri: IRACING_REDIRECT_URI, code_verifier: pkceEntry.verifier
    });

    const tokenRes  = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error) return res.status(400).send(`OAuth Error: ${tokenData.error || "Unknown"}`);

    const profileRes = await fetch("https://oauth.iracing.com/oauth2/iracing/profile", { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    let iracingName  = "Unknown";
    if (profileRes.ok) {
      const profileJson = await profileRes.json();
      if (profileJson.iracing_name) {
        const parts = profileJson.iracing_name.trim().split(/\s+/);
        iracingName = parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
      }
    }

    let drivers = loadLinkedDrivers();
    drivers = drivers.filter(d => d.discordId !== discordId);
    drivers.push({ discordId, iracingName, accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token, expiresAt: Date.now() + tokenData.expires_in * 1000 });
    saveLinkedDrivers(drivers);

    res.send(`✅ Linked as **${iracingName}**!<br><br>You can now close this window.`);
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).send("Linking failed.");
  }
});

app.get("/", (req, res) => res.send("🏁 GSR Bot OAuth Server is running."));
app.listen(PORT, () => console.log(`🌐 OAuth server running on port ${PORT}`));

// ====================== DISCORD ======================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", () => console.log("✅ Bot logged in!"));

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") return interaction.reply("🏁 Pong!");

  if (interaction.commandName === "link") {
    const state    = encodeURIComponent(interaction.user.id);
    const loginUrl = `https://www.gsracing.app/oauth/login?state=${state}`;
    return interaction.reply({ content: `🔗 Link iRacing: ${loginUrl}`, ephemeral: true });
  }

  if (interaction.commandName === "unlinkme") {
    let drivers = loadLinkedDrivers();
    const initial = drivers.length;
    drivers = drivers.filter(d => d.discordId !== interaction.user.id);
    if (drivers.length < initial) {
      saveLinkedDrivers(drivers);
      return interaction.reply({ content: "✅ You have been unlinked from the leaderboard.", ephemeral: true });
    }
    return interaction.reply({ content: "You were not linked.", ephemeral: true });
  }

  // ── /unlink — remove by Discord user picker (must be in server) ──
  if (interaction.commandName === "unlink") {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: "❌ Only administrators can use this command.", ephemeral: true });
    }
    const target = interaction.options.getUser("user");
    if (!target) return interaction.reply({ content: "Please select a user.", ephemeral: true });

    let drivers = loadLinkedDrivers();
    const initial = drivers.length;
    drivers = drivers.filter(d => d.discordId !== target.id);
    if (drivers.length < initial) {
      saveLinkedDrivers(drivers);
      return interaction.reply({ content: `✅ Successfully unlinked **${target.tag}**.`, ephemeral: true });
    }
    return interaction.reply({ content: "That user was not linked.", ephemeral: true });
  }

  // ── /unlinkname — remove by iRacing name (works even after leaving server) ──
  if (interaction.commandName === "unlinkname") {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: "❌ Only administrators can use this command.", ephemeral: true });
    }

    const inputName = interaction.options.getString("name").trim().toLowerCase();
    let drivers     = loadLinkedDrivers();

    // Find all drivers whose iRacing name matches (case-insensitive)
    const matches = drivers.filter(d => d.iracingName?.toLowerCase().includes(inputName));

    if (matches.length === 0) {
      // Show the full list of linked drivers to help the admin
      const names = drivers.map((d, i) => `${i + 1}. ${d.iracingName}`).join("\n") || "None";
      return interaction.reply({
        content: `❌ No driver found matching **"${inputName}"**.\n\nCurrently linked drivers:\n\`\`\`\n${names}\n\`\`\``,
        ephemeral: true
      });
    }

    if (matches.length > 1) {
      const names = matches.map(d => d.iracingName).join("\n");
      return interaction.reply({
        content: `⚠️ Multiple drivers match **"${inputName}"**. Please be more specific:\n\`\`\`\n${names}\n\`\`\``,
        ephemeral: true
      });
    }

    // Exactly one match — remove them
    const removed = matches[0];
    drivers = drivers.filter(d => d.discordId !== removed.discordId);
    saveLinkedDrivers(drivers);

    return interaction.reply({
      content: `✅ Successfully unlinked **${removed.iracingName}**.`,
      ephemeral: true
    });
  }

  if (interaction.commandName === "myirating") {
    const drivers = loadLinkedDrivers();
    const driver  = drivers.find(d => d.discordId === interaction.user.id);
    if (!driver) return interaction.reply({ content: "You are not linked yet. Use `/link` first!", ephemeral: true });

    const current    = driver.lastIRating ?? "??";
    let   changeText = "No change yet";
    if (driver.lastChange !== undefined) {
      changeText = driver.lastChange > 0 ? `**+${driver.lastChange}**` : `**${driver.lastChange}**`;
    }

    const embed = new EmbedBuilder()
      .setTitle("📊 Your iRating")
      .setColor(0x00ff88)
      .addFields(
        { name: "iRacing Name",   value: driver.iracingName || "Unknown", inline: true },
        { name: "Current iRating", value: current.toString(),             inline: true },
        { name: "Change",         value: changeText,                      inline: true },
        { name: "Current Rank",   value: driver.lastRank ? `#${driver.lastRank}` : "Not ranked yet", inline: true }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
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

    const stats       = await fetchDriverStats(driver);
    const imageBuffer = renderStatsCard(stats);
    const attachment  = new AttachmentBuilder(imageBuffer, { name: "stats.png" });

    await interaction.editReply({ files: [attachment] });
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
      if (isInteraction) return interactionOrChannel.reply({ content: "No drivers linked yet.", ephemeral: true });
      return interactionOrChannel.send({ content: "No drivers linked yet." });
    }

    if (isInteraction) await interactionOrChannel.deferReply();

    for (const driver of drivers) {
      try {
        const ir = await getCurrentIRating(driver);
        if (ir !== null) {
          const old      = driver.lastIRating ?? ir;
          driver.lastIRating = ir;
          driver.lastChange  = ir - old;
        }
      } catch (e) {}
    }

    drivers.sort((a, b) => (b.lastIRating ?? 0) - (a.lastIRating ?? 0));
    drivers.forEach((d, i) => d.lastRank = i + 1);
    saveLinkedDrivers(drivers);

    let embedColor = 0x00ff88;
    if      (drivers[0]?.lastChange > 0) embedColor = 0x00cc66;
    else if (drivers[0]?.lastChange < 0) embedColor = 0xff4444;

    const totalDrivers = drivers.length;
    const displayed    = Math.min(drivers.length, 20);

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setThumbnail("https://cdn.discordapp.com/attachments/1396172486558613514/1402298298450186350/Maybe.png?ex=699a6acf&is=6999194f&hm=5bd0de5d8200e0af87742858135e252c608bc6ad1d144046203fee96edbd8d17&")
      .setDescription("**🏁 GSR iRating Leaderboard**")
      .setTimestamp();

    drivers.slice(0, 20).forEach((d, i) => {
      const rankDisplay = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}️⃣`;
      let change = "";
      if (d.lastChange !== undefined) {
        if      (d.lastChange > 0) change = ` 🟢 **+${d.lastChange}** ⬆️`;
        else if (d.lastChange < 0) change = ` 🔴 **${d.lastChange}** ⬇️`;
        else                       change = ` ⚪ **0**`;
      }
      embed.addFields({
        name:   `${rankDisplay} **${i + 1}.** ${d.iracingName || "Unknown"}`,
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
      const respond = interactionOrChannel.deferred
        ? interactionOrChannel.editReply.bind(interactionOrChannel)
        : interactionOrChannel.reply.bind(interactionOrChannel);
      await respond({ content: "❌ Failed to load leaderboard. Please try again." }).catch(() => {});
    }
  }
}

// ====================== REGISTER COMMANDS ======================
const commands = [
  { name: "ping",        description: "Test bot" },
  { name: "link",        description: "Link iRacing account" },
  { name: "unlinkme",    description: "Unlink yourself" },
  {
    name: "unlink",
    description: "Admin: Unlink a driver who is still in the server",
    options: [{ name: "user", description: "User to unlink", type: 6, required: true }]
  },
  {
    name: "unlinkname",
    description: "Admin: Unlink a driver by iRacing name (use when they've left the server)",
    options: [{
      name:        "name",
      description: "Full or partial iRacing name (e.g. 'Jesse D.' or just 'Jesse')",
      type:        3, // STRING
      required:    true
    }]
  },
  { name: "myirating",   description: "Show your personal iRating" },
  { name: "leaderboard", description: "Show GSR iRating Leaderboard" },
  { name: "stats",       description: "Show your Sports Car stats card" }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Commands registered.");
  } catch (err) {
    console.error(err);
  }
})();

// ====================== STARTUP ======================
registerFont();
client.login(DISCORD_TOKEN);

// ====================== CRON ======================
const { CronJob } = require("cron");
new CronJob("0 12 * * *", async () => {
  const channel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
  if (channel) await showLeaderboard(channel);
}, null, true, "America/Chicago");