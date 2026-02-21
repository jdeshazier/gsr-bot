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
// Persistent storage - with retry & raw logging
// ===============================
const DATA_DIR = "/app/data";
const LINKED_FILE = path.join(DATA_DIR, "linked-drivers.json");

async function loadLinkedDrivers() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        console.log("[STORAGE] Creating data dir (attempt " + attempt + ")");
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (!fs.existsSync(LINKED_FILE)) {
        console.log("[STORAGE] No file yet - returning empty (attempt " + attempt + ")");
        return [];
      }
      const raw = fs.readFileSync(LINKED_FILE, "utf8");
      console.log("[STORAGE] Raw file contents on load (attempt " + attempt + "):", raw);
      const parsed = JSON.parse(raw);
      console.log("[STORAGE] Loaded", parsed.length, "drivers (attempt " + attempt + ")");
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error("[STORAGE] Load failed (attempt " + attempt + "):", err.message, err.stack);
      if (attempt === 3) return [];
      await new Promise(r => setTimeout(r, 2000)); // wait 2 sec before retry
    }
  }
  return [];
}

async function saveLinkedDrivers(drivers) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const json = JSON.stringify(drivers, null, 2);
    fs.writeFileSync(LINKED_FILE, json, "utf8");
    // Extra delay for volume sync
    await new Promise(r => setTimeout(r, 3000)); // 3 sec
    console.log("[STORAGE] Raw saved contents:", json);
    console.log(`[STORAGE] Saved ${drivers.length} drivers successfully`);
  } catch (err) {
    console.error("[STORAGE] Save failed:", err.message, err.stack);
  }
}

// ... (maskSecret, getValidAccessToken, getCurrentIRating remain the same as your latest code)

// ===============================
// DISCORD + EXPRESS setup
// ===============================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const app = express();
const PORT = process.env.PORT || 3000;
const AUTHORIZE_URL = "https://oauth.iracing.com/oauth2/authorize";
const TOKEN_URL = "https://oauth.iracing.com/oauth2/token";
let pkceStore = {};

// Login route
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

// Callback - robust multi-driver append
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

    const profileUrl = "https://oauth.iracing.com/oauth2/iracing/profile";
    const profileRes = await fetch(profileUrl, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    let iracingName = "Unknown";
    if (profileRes.ok) {
      const profileJson = await profileRes.json();
      console.log("[LINK] /iracing/profile response:", JSON.stringify(profileJson, null, 2));

      if (profileJson.iracing_name && typeof profileJson.iracing_name === 'string' && profileJson.iracing_name.trim()) {
        let fullName = profileJson.iracing_name.trim();
        const nameParts = fullName.split(/\s+/);
        if (nameParts.length >= 2) {
          const first = nameParts[0];
          const lastInitial = nameParts[nameParts.length - 1].charAt(0).toUpperCase();
          iracingName = `${first} ${lastInitial}.`;
        } else {
          iracingName = fullName;
        }
      } else {
        console.warn("[LINK] No valid iracing_name found");
      }
    } else {
      console.error("[LINK] Profile endpoint failed:", profileRes.status);
    }

    console.log("[LINK] Final saved name:", iracingName);

    let drivers = await loadLinkedDrivers();
    console.log(`[LINK] Loaded ${drivers.length} drivers before update`);

    const existingIndex = drivers.findIndex(d => d.discordId === discordId);
    if (existingIndex !== -1) {
      console.log(`[LINK] Updating existing entry for ${discordId}`);
      drivers[existingIndex] = {
        ...drivers[existingIndex],
        iracingName,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: Date.now() + tokenData.expires_in * 1000
      };
    } else {
      console.log(`[LINK] Adding new driver ${discordId}`);
      drivers.push({
        discordId,
        iracingName,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: Date.now() + tokenData.expires_in * 1000
      });
    }

    console.log(`[LINK] After update/push: ${drivers.length} drivers`);

    // Extra delay + retry save
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await saveLinkedDrivers(drivers);
        console.log(`[LINK] Save succeeded on attempt ${attempt}`);
        break;
      } catch (err) {
        console.error(`[LINK] Save attempt ${attempt} failed:`, err.message);
        if (attempt === 3) break;
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    res.send(`✅ Linked as **${iracingName}**!<br><br>You can now close this window.`);
  } catch (err) {
    console.error("Callback error:", err.stack || err);
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
  '*/5 * * * *',
  async () => {
    console.log('[CRON] Starting Road leaderboard test');

    let drivers = await loadLinkedDrivers();
    if (drivers.length === 0) {
      console.log('[CRON] No linked drivers — skipping');
      return;
    }

    console.log(`[CRON] Found ${drivers.length} linked drivers`);

    // Update iRating for every driver
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
      }
    }

    // Safe list for sorting
    const validDrivers = drivers.map(d => ({
      ...d,
      lastIRating: d.lastIRating ?? 0,
      iracingName: d.iracingName || 'Unknown'
    }));

    validDrivers.sort((a, b) => b.lastIRating - a.lastIRating);

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

      const original = drivers.find(d => d.discordId === driver.discordId);
      if (original) original.lastRank = newRank;
    });

    await saveLinkedDrivers(drivers);

    const channel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      console.error(`[CRON] Channel ${ANNOUNCE_CHANNEL_ID} not found`);
      return;
    }

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