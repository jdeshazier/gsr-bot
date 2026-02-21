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
// Persistent storage (Railway volume at /app/data)
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
// iRacing client secret masking (REQUIRED by iRacing)
// ===============================
function maskSecret(secret, clientId) {
  if (!secret || !clientId) {
    throw new Error("Missing client secret or client ID for masking");
  }
  const normalizedId = clientId.trim().toLowerCase();
  const input = secret + normalizedId;
  const hash = crypto.createHash("sha256").update(input, "utf8").digest();
  return hash.toString("base64"); // Standard base64 with padding
}

// Helper: Get a valid (fresh) access token for a user (refreshes if needed)
async function getValidAccessToken(user) {
  if (Date.now() < user.expiresAt - 60000) {
    return user.accessToken;
  }
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
    console.error(`Refresh failed for ${user.discordId}: ${res.status} - ${errText}`);
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

// Helper: Fetch current Road (Sports Car) iRating (category_id=5)
async function getCurrentIRating(user) {
  const token = await getValidAccessToken(user);
  const rootUrl = "https://members-ng.iracing.com/data/member/chart_data?chart_type=1&category_id=5";
  const rootRes = await fetch(rootUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!rootRes.ok) {
    console.error(`Root chart fetch failed: ${rootRes.status}`);
    return null;
  }
  const rootJson = await rootRes.json();
  console.log("Root chart_data response:", JSON.stringify(rootJson, null, 2));
  let chartUrl = rootUrl;
  if (rootJson.link) {
    chartUrl = rootJson.link;
    console.log("Following chart link:", chartUrl);
  }
  const chartRes = await fetch(chartUrl);
  if (!chartRes.ok) {
    console.error(`Chart data fetch from link failed: ${chartRes.status}`);
    return null;
  }
  const chartJson = await chartRes.json();
  console.log("Full chart JSON:", JSON.stringify(chartJson, null, 2));
  if (chartJson.data && Array.isArray(chartJson.data) && chartJson.data.length > 0) {
    const latest = chartJson.data[chartJson.data.length - 1];
    return latest.value; // the iRating number
  }
  console.log("No 'data' array or empty in chart JSON");
  return null;
}

// ===============================
// DISCORD CLIENT
// ===============================
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ===============================
// EXPRESS SERVER
// ===============================
const app = express();
const PORT = process.env.PORT || 3000;
const AUTHORIZE_URL = "https://oauth.iracing.com/oauth2/authorize";
const TOKEN_URL = "https://oauth.iracing.com/oauth2/token";
// Temporary PKCE storage
let pkceStore = {};

// --------------------------------
// LOGIN ROUTE
// --------------------------------
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
    `&scope=iracing.auth` +
    `&code_challenge=${codeChallenge}` +
    `&code_challenge_method=S256`;
  console.log("Redirecting to:", authUrl);
  res.redirect(authUrl);
});

// --------------------------------
// CALLBACK ROUTE - Link + fetch name from full profile JSON
// --------------------------------
app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send("Missing authorization code.");
  }
  try {
    const maskedSecret = maskSecret(IRACING_CLIENT_SECRET, IRACING_CLIENT_ID);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: IRACING_CLIENT_ID,
      client_secret: maskedSecret,
      code: code,
      redirect_uri: IRACING_REDIRECT_URI,
      code_verifier: pkceStore.verifier
    });
    const tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    const tokenData = await tokenResponse.json();
    console.log("TOKEN RESPONSE STATUS:", tokenResponse.status);
    console.log("TOKEN RESPONSE BODY:", JSON.stringify(tokenData, null, 2));
    if (!tokenResponse.ok || tokenData.error) {
      return res.status(tokenResponse.status || 400).send(
        `OAuth Error: ${tokenData.error || "Unknown error"}\n` +
        `Description: ${tokenData.error_description || "No description"}\n` +
        `Full response: ${JSON.stringify(tokenData)}`
      );
    }

    const discordId = req.query.state || "unknown";

    let iracingName = "Unknown";

    // Fetch profile root (presigned link)
    const profileRootUrl = "https://members-ng.iracing.com/data/member/profile";
    const profileRootRes = await fetch(profileRootUrl, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (profileRootRes.ok) {
      const profileRootJson = await profileRootRes.json();
      console.log("[LINK] Profile root response:", JSON.stringify(profileRootJson, null, 2));

      let fullProfileUrl = profileRootUrl;
      if (profileRootJson.link) {
        fullProfileUrl = profileRootJson.link;
        console.log("[LINK] Following profile link:", fullProfileUrl);
      }

      // Fetch full profile JSON
      const fullProfileRes = await fetch(fullProfileUrl);
      if (fullProfileRes.ok) {
        const fullProfileJson = await fullProfileRes.json();
        console.log("[LINK] Full profile JSON:", JSON.stringify(fullProfileJson, null, 2));

        // Try common name fields
        let rawName = fullProfileJson.display_name || fullProfileJson.name || "";
        if (rawName.trim()) {
          const nameParts = rawName.trim().split(/\s+/);
          if (nameParts.length >= 2) {
            const first = nameParts[0];
            const lastInitial = nameParts[nameParts.length - 1][0].toUpperCase();
            iracingName = `${first} ${lastInitial}.`;
          } else {
            iracingName = rawName.trim();
          }
        } else {
          console.warn("[LINK] No display_name or name in full profile JSON");
        }
      } else {
        console.error("[LINK] Full profile fetch failed:", fullProfileRes.status);
      }
    } else {
      console.error("[LINK] Profile root fetch failed:", profileRootRes.status);
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

// Test route - Road (Sports Car) iRating
app.get("/test-irating", async (req, res) => {
  try {
    const drivers = loadLinkedDrivers();
    if (drivers.length === 0) {
      return res.send("No linked drivers yet. Link one first!");
    }
    const user = drivers[0];
    const token = await getValidAccessToken(user);
    const rootUrl = "https://members-ng.iracing.com/data/member/chart_data?chart_type=1&category_id=5";
    const rootRes = await fetch(rootUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const rootJson = await rootRes.json();
    console.log("Root chart_data response:", JSON.stringify(rootJson, null, 2));
    let chartUrl = rootUrl;
    if (rootJson.link) {
      chartUrl = rootJson.link;
      console.log("Following chart link:", chartUrl);
    }
    const chartRes = await fetch(chartUrl);
    if (!chartRes.ok) {
      console.error(`Chart fetch failed: ${chartRes.status}`);
      return res.send("Chart data fetch failed.");
    }
    const chartJson = await chartRes.json();
    console.log("Full chart JSON:", JSON.stringify(chartJson, null, 2));
    let irating = "Not found";
    if (chartJson.data && Array.isArray(chartJson.data) && chartJson.data.length > 0) {
      const latest = chartJson.data[chartJson.data.length - 1];
      irating = latest.value || "No value";
    } else {
      irating = "No data array or empty. See logs.";
    }
    res.send(
      `Your current Road iRating: <b>${irating}</b><br><br>` +
      `Check Railway logs for full JSON responses.`
    );
  } catch (err) {
    console.error("Test error:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🌐 OAuth server running on port ${PORT}`);
});

// ===============================
// DISCORD READY
// ===============================
client.once("ready", () => {
  console.log("✅ Bot is logged into Discord!");
});

// ===============================
// SLASH COMMANDS
// ===============================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "ping") {
    return interaction.reply("🏁 Pong! Bot is alive.");
  }
  if (interaction.commandName === "link") {
    const state = encodeURIComponent(interaction.user.id);
    const loginUrl = `https://www.gsracing.app/oauth/login?state=${state}`;
    return interaction.reply({
      content: `🔗 Click here to link your iRacing account:\n${loginUrl}`,
      ephemeral: true
    });
  }
});

const commands = [
  { name: "ping", description: "Test if the bot is responding" },
  { name: "link", description: "Link your iRacing account" }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log("✅ Slash commands registered.");
  } catch (error) {
    console.error("Error registering commands:", error);
  }
})();
client.login(DISCORD_TOKEN);

// ===============================
// DAILY LEADERBOARD CRON JOB (every 5 min for testing)
// ===============================
const { CronJob } = require('cron');

new CronJob(
  '*/5 * * * *',  // Every 5 minutes for testing
  async () => {
    console.log('[CRON] Starting Formula iRating leaderboard test (every 5 min)');

    let drivers = loadLinkedDrivers();
    if (drivers.length === 0) {
      console.log('[CRON] No linked drivers — skipping');
      return;
    }

    let updatedDrivers = [];

    for (const driver of drivers) {
      try {
        const irating = await getCurrentIRating(driver);

        if (irating !== null) {
          const oldIRating = driver.lastIRating ?? irating;
          const change = irating - oldIRating;

          driver.lastIRating = irating;
          driver.lastChange = change;

          updatedDrivers.push(driver);
        }
      } catch (err) {
        console.error(`[CRON] Failed to update driver ${driver.discordId}: ${err.message}`);
      }
    }

    if (updatedDrivers.length === 0) {
      console.log('[CRON] No valid iRating updates — skipping post');
      return;
    }

    // Sort highest to lowest
    updatedDrivers.sort((a, b) => b.lastIRating - a.lastIRating);

    // Calculate ranks & gains
    const announcements = [];
    updatedDrivers.forEach((driver, idx) => {
      const newRank = idx + 1;
      const oldRank = driver.lastRank ?? Infinity;

      if (newRank < oldRank && oldRank !== Infinity) {
        const spots = oldRank - newRank;
        announcements.push(
          `**${driver.iracingName || 'Driver'}** gained ${spots} spot${spots === 1 ? '' : 's'}! ` +
          `Now #${newRank} with ${driver.lastIRating} iR`
        );
      }

      driver.lastRank = newRank;
    });

    saveLinkedDrivers(updatedDrivers);

    const channel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);

    if (!channel || !channel.isTextBased()) {
      console.error(`[CRON] Channel ID ${ANNOUNCE_CHANNEL_ID} not found or not text-based`);
      return;
    }

    // Leaderboard message (top 20) - uses saved iracingName
    let leaderboardMsg = '**Daily Road iRating Leaderboard** — Test (every 5 min)\n\n';
    updatedDrivers.slice(0, 20).forEach((d, i) => {
      const changeStr = d.lastChange
        ? (d.lastChange > 0 ? ` (+${d.lastChange})` : ` (${d.lastChange})`)
        : '';
      leaderboardMsg += `${i + 1}. **${d.iracingName || 'Unknown'}** — ${d.lastIRating} iR${changeStr}\n`;
    });

    await channel.send(leaderboardMsg).catch(err => {
      console.error('[CRON] Failed to send leaderboard:', err);
    });

    if (announcements.length > 0) {
      await channel.send(announcements.join('\n')).catch(err => {
        console.error('[CRON] Failed to send announcements:', err);
      });
    }

    console.log('[CRON] Leaderboard posted to channel ' + ANNOUNCE_CHANNEL_ID);
  },
  null,
  true,
  'America/Chicago'
);