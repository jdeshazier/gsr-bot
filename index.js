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
/oauth/callback

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
  '*/5 * * * *',
  async () => {
    console.log('[CRON] Starting Road leaderboard test');

    let drivers = loadLinkedDrivers();
    if (drivers.length === 0) {
      console.log('[CRON] No linked drivers — skipping');
      return;
    }

    console.log(`[CRON] Found ${drivers.length} linked drivers`);

    // 1. Update iRating for every driver (keep last known if fetch fails)
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
          console.log(`[CRON] No new iRating for ${driver.iracingName || driver.discordId} — using last known ${driver.lastIRating ?? '??'}`);
        }
      } catch (err) {
        console.error(`[CRON] Failed update for ${driver.discordId || 'unknown'}: ${err.message}`);
        // Keep whatever was there before
      }
    }

    // 2. Create a safe list for sorting/display (filter out invalid, treat missing iR as 0)
    const validDrivers = drivers.map(d => ({
      ...d,
      lastIRating: d.lastIRating ?? 0,   // fallback to 0 for sorting
      iracingName: d.iracingName || 'Unknown'
    }));

    // 3. Sort by iRating descending
    validDrivers.sort((a, b) => b.lastIRating - a.lastIRating);

    // 4. Calculate rank changes & announcements
    const announcements = [];
    validDrivers.forEach((driver, idx) => {
      const newRank = idx + 1;
      const oldRank = driver.lastRank ?? Infinity;

      if (newRank < oldRank && oldRank !== Infinity) {
        const spots = oldRank - newRank;
        announcements.push(
          `**${driver.iracingName}** gained ${spots} spot${spots === 1 ? '' : 's'}! ` +
          `Now #${newRank} with ${driver.lastIRating} iR`
        );
      }

      // Update original driver with new rank
      const original = drivers.find(d => d.discordId === driver.discordId);
      if (original) original.lastRank = newRank;
    });

    // 5. Save all updated ranks & iRatings back to file
    saveLinkedDrivers(drivers);

    const channel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      console.error(`[CRON] Channel ${ANNOUNCE_CHANNEL_ID} not found`);
      return;
    }

    // 6. Build leaderboard message - show ALL valid drivers (top 20 limit optional)
    let leaderboardMsg = '**Daily Road iRating Leaderboard** — Test (5 min)\n\n';
    const topDrivers = validDrivers.slice(0, 20);

    if (topDrivers.length === 0) {
      leaderboardMsg += "No drivers with iRating data yet.\n";
    } else {
      topDrivers.forEach((d, i) => {
        const changeStr = d.lastChange
          ? (d.lastChange > 0 ? ` (+${d.lastChange})` : ` (${d.lastChange})`)
          : '';
        leaderboardMsg += `${i + 1}. **${d.iracingName}** — ${d.lastIRating} iR${changeStr}\n`;
      });
    }

    await channel.send(leaderboardMsg).catch(err => console.error('[CRON] Send leaderboard failed:', err));

    if (announcements.length > 0) {
      await channel.send(announcements.join('\n')).catch(err => console.error('[CRON] Send announcements failed:', err));
    }

    console.log(`[CRON] Posted leaderboard with ${topDrivers.length} entries (total linked: ${drivers.length})`);
  },
  null,
  true,
  'America/Chicago'
);