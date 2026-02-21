require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes
} = require("discord.js");
const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ===============================
// ENV VARIABLES
// ===============================
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  IRACING_CLIENT_ID,
  IRACING_CLIENT_SECRET,
  IRACING_REDIRECT_URI,
  ANNOUNCE_CHANNEL_ID
} = process.env;

if (
  !DISCORD_TOKEN ||
  !CLIENT_ID ||
  !GUILD_ID ||
  !IRACING_CLIENT_ID ||
  !IRACING_CLIENT_SECRET ||
  !IRACING_REDIRECT_URI ||
  !ANNOUNCE_CHANNEL_ID
) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

// ===============================
// Persistent storage
// ===============================
const DATA_DIR = "/app/data";
const LINKED_FILE = path.join(DATA_DIR, "linked-drivers.json");

function loadLinkedDrivers() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(LINKED_FILE)) return [];
    const data = fs.readFileSync(LINKED_FILE, "utf8");
    return JSON.parse(data);
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

// ===============================
// iRacing secret masking
// ===============================
function maskSecret(secret, clientId) {
  if (!secret || !clientId) throw new Error("Missing client secret or ID");
  const normalizedId = clientId.trim().toLowerCase();
  const input = secret + normalizedId;
  const hash = crypto.createHash("sha256").update(input, "utf8").digest();
  return hash.toString("base64");
}

// ===============================
// Token refresh helper
// ===============================
async function getValidAccessToken(user) {
  if (Date.now() < user.expiresAt - 60000) return user.accessToken;

  console.log(`Refreshing token for Discord ID ${user.discordId}`);
  const maskedSecret = maskSecret(IRACING_CLIENT_SECRET, IRACING_CLIENT_ID);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: IRACING_CLIENT_ID,
      client_secret: maskedSecret,
      refresh_token: user.refreshToken
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Refresh failed: ${res.status} - ${errText}`);
    throw new Error("Token refresh failed");
  }

  const data = await res.json();
  user.accessToken = data.access_token;
  user.refreshToken = data.refresh_token || user.refreshToken;
  user.expiresAt = Date.now() + data.expires_in * 1000;

  let drivers = loadLinkedDrivers();
  const index = drivers.findIndex(d => d.discordId === user.discordId);
  if (index !== -1) {
    drivers[index] = user;
    saveLinkedDrivers(drivers);
  }

  return user.accessToken;
}

// ===============================
// Fetch Road iRating (category_id=5)
// ===============================
async function getCurrentIRating(user) {
  const token = await getValidAccessToken(user);
  const rootUrl = "https://members-ng.iracing.com/data/member/chart_data?chart_type=1&category_id=5";
  const rootRes = await fetch(rootUrl, { headers: { Authorization: `Bearer ${token}` } });

  if (!rootRes.ok) {
    console.error(`Root chart fetch failed: ${rootRes.status}`);
    return null;
  }

  const rootJson = await rootRes.json();
  let chartUrl = rootUrl;
  if (rootJson.link) chartUrl = rootJson.link;

  const chartRes = await fetch(chartUrl);
  if (!chartRes.ok) {
    console.error(`Chart fetch failed: ${chartRes.status}`);
    return null;
  }

  const chartJson = await chartRes.json();
  if (chartJson.data && Array.isArray(chartJson.data) && chartJson.data.length > 0) {
    return chartJson.data[chartJson.data.length - 1].value;
  }
  return null;
}

// ===============================
// DISCORD + EXPRESS setup
// ===============================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const app = express();
const PORT = process.env.PORT || 3000;
const AUTHORIZE_URL = "https://oauth.iracing.com/oauth2/authorize";
const TOKEN_URL = "https://oauth.iracing.com/oauth2/token";
let pkceStore = {};

// Login route - NOW requests iracing.profile scope
app.get("/oauth/login", (req, res) => {
  const codeVerifier = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(codeVerifier).digest("base64");
  const codeChallenge = hash.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  pkceStore.verifier = codeVerifier;

  const authUrl =
    `${AUTHORIZE_URL}?` +
    `response_type=code` +
    `&client_id=${encodeURIComponent(IRACING_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(IRACING_REDIRECT_URI)}` +
    `&scope=iracing.auth iracing.profile` +
    `&code_challenge=${codeChallenge}` +
    `&code_challenge_method=S256`;

  console.log("Redirecting to:", authUrl);
  res.redirect(authUrl);
});

// Callback - fetches iracing_name from /iracing/profile
app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing authorization code.");

  try {
    const maskedSecret = maskSecret(IRACING_CLIENT_SECRET, IRACING_CLIENT_ID);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: IRACING_CLIENT_ID,
      client_secret: maskedSecret,
      code,
      redirect_uri: IRACING_REDIRECT_URI,
      code_verifier: pkceStore.verifier
    });

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    const tokenData = await tokenRes.json();
    console.log("TOKEN RESPONSE STATUS:", tokenRes.status);
    console.log("TOKEN RESPONSE BODY:", JSON.stringify(tokenData, null, 2));

    if (!tokenRes.ok || tokenData.error) {
      return res.status(400).send(`OAuth Error: ${tokenData.error || "Unknown"}`);
    }

    const discordId = req.query.state || "unknown";

    // Fetch name from official /iracing/profile endpoint
    const profileUrl = "https://oauth.iracing.com/oauth2/iracing/profile";
    const profileRes = await fetch(profileUrl, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    let iracingName = "Unknown";
    if (profileRes.ok) {
      const profileJson = await profileRes.json();
      console.log("[LINK] /iracing/profile response:", JSON.stringify(profileJson, null, 2));

      if (profileJson.iracing_name && typeof profileJson.iracing_name === 'string' && profileJson.iracing_name.trim()) {
        const fullName = profileJson.iracing_name.trim();
        const parts = fullName.split(/\s+/);
        if (parts.length >= 2) {
          const first = parts[0];
          const lastInitial = parts[parts.length - 1][0].toUpperCase();
          iracingName = `${first} ${lastInitial}.`;
        } else {
          iracingName = fullName;
        }
      } else {
        console.warn("[LINK] No iracing_name in profile response");
      }
    } else {
      console.error("[LINK] /iracing/profile failed:", profileRes.status);
    }

    console.log("[LINK] Final saved name:", iracingName);

    let drivers = loadLinkedDrivers();
    drivers = drivers.filter(d => d.discordId !== discordId);
    drivers.push({
      discordId,
      iracingName,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000
    });
    saveLinkedDrivers(drivers);

    res.send(`✅ Linked as **${iracingName}**!<br><br>You can now close this window.`);
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).send("Linking failed. Check logs.");
  }
});

// Root route
app.get("/", (req, res) => {
  res.send("🏁 GSR Bot OAuth Server is running.");
});

// Test route - Road iRating
app.get("/test-irating", async (req, res) => {
  try {
    const drivers = loadLinkedDrivers();
    if (drivers.length === 0) return res.send("No linked drivers yet.");
    const user = drivers[0];
    const irating = await getCurrentIRating(user);
    res.send(`Your current Road iRating: <b>${irating ?? "Not found"}</b>`);
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

app.listen(PORT, () => console.log(`🌐 OAuth server running on port ${PORT}`));

// ===============================
// DISCORD READY + COMMANDS
// ===============================
client.once("ready", () => console.log("✅ Bot logged in!"));

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    return interaction.reply("🏁 Pong!");
  }

  if (interaction.commandName === "link") {
    const state = encodeURIComponent(interaction.user.id);
    const loginUrl = `https://www.gsracing.app/oauth/login?state=${state}`;
    return interaction.reply({
      content: `🔗 Link iRacing: ${loginUrl}`,
      ephemeral: true
    });
  }
});

const commands = [
  { name: "ping", description: "Test bot" },
  { name: "link", description: "Link iRacing account" }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Commands registered.");
  } catch (err) {
    console.error("Command register error:", err);
  }
})();

client.login(DISCORD_TOKEN);

// ===============================
// CRON - every 5 min test
// ===============================
const { CronJob } = require('cron');

new CronJob(
  '*/5 * * * *',  // keep for testing
  async () => {
    console.log('[CRON] Starting Road leaderboard test');

    let drivers = loadLinkedDrivers();
    if (drivers.length === 0) {
      console.log('[CRON] No linked drivers — skipping');
      return;
    }

    // Update iRating for as many as possible
    for (const driver of drivers) {
      try {
        const irating = await getCurrentIRating(driver);
        if (irating !== null) {
          const oldIRating = driver.lastIRating ?? irating;
          const change = irating - oldIRating;

          driver.lastIRating = irating;
          driver.lastChange = change;

          console.log(`[CRON] Updated ${driver.iracingName || driver.discordId}: ${irating} iR (change ${change})`);
        } else {
          console.log(`[CRON] No new iRating for ${driver.iracingName || driver.discordId} — keeping last known`);
        }
      } catch (err) {
        console.error(`[CRON] Failed to update ${driver.discordId || 'unknown'}: ${err.message}`);
        // Keep last known data
      }
    }

    // Sort all drivers by lastIRating (descending), treat missing as 0
    drivers.sort((a, b) => {
      const aRating = a.lastIRating ?? 0;
      const bRating = b.lastIRating ?? 0;
      return bRating - aRating;
    });

    // Build announcements for rank gains
    const announcements = [];
    drivers.forEach((driver, idx) => {
      const newRank = idx + 1;
      const oldRank = driver.lastRank ?? Infinity;

      if (newRank < oldRank && oldRank !== Infinity) {
        const spots = oldRank - newRank;
        announcements.push(
          `**${driver.iracingName || 'Unknown'}** gained ${spots} spot${spots === 1 ? '' : 's'}! ` +
          `Now #${newRank} with ${driver.lastIRating ?? '??'} iR`
        );
      }

      driver.lastRank = newRank;
    });

    // Save all updates back
    saveLinkedDrivers(drivers);

    const channel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      console.error(`[CRON] Channel ID ${ANNOUNCE_CHANNEL_ID} not found or not text-based`);
      return;
    }

    // Build leaderboard message - show ALL drivers (or top 20 if many)
    let leaderboardMsg = '**Daily Road iRating Leaderboard** — Test (5 min)\n\n';
    const displayDrivers = drivers.slice(0, 20); // limit to top 20 if >20 linked
    displayDrivers.forEach((d, i) => {
      const ir = d.lastIRating ?? '??';
      const changeStr = d.lastChange
        ? (d.lastChange > 0 ? ` (+${d.lastChange})` : ` (${d.lastChange})`)
        : '';
      leaderboardMsg += `${i + 1}. **${d.iracingName || 'Unknown'}** — ${ir} iR${changeStr}\n`;
    });

    if (displayDrivers.length === 0) {
      leaderboardMsg += "No recent iRating data available yet.\n";
    }

    await channel.send(leaderboardMsg).catch(err => {
      console.error('[CRON] Failed to send leaderboard:', err);
    });

    // Send gains if any
    if (announcements.length > 0) {
      await channel.send(announcements.join('\n')).catch(err => {
        console.error('[CRON] Failed to send announcements:', err);
      });
    }

    console.log(`[CRON] Posted leaderboard with ${displayDrivers.length} entries`);
  },
  null,
  true,
  'America/Chicago'
);