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
  IRACING_REDIRECT_URI
} = process.env;
if (
  !DISCORD_TOKEN ||
  !CLIENT_ID ||
  !GUILD_ID ||
  !IRACING_CLIENT_ID ||
  !IRACING_CLIENT_SECRET ||
  !IRACING_REDIRECT_URI
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

// Helper: Get a valid (fresh) access token for a user (refreshes if needed)
async function getValidAccessToken(user) {
  // If still valid (with 1 min buffer), return it
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

  // Update user's tokens
  user.accessToken = data.access_token;
  user.refreshToken = data.refresh_token || user.refreshToken;
  user.expiresAt = Date.now() + data.expires_in * 1000;

  // Save updated user back to file
  let drivers = loadLinkedDrivers();
  const index = drivers.findIndex(d => d.discordId === user.discordId);
  if (index !== -1) {
    drivers[index] = user;
    saveLinkedDrivers(drivers);
  }

  return user.accessToken;
}

// Helper: Fetch current Formula iRating (category_id=6)
async function getCurrentIRating(user) {
  const token = await getValidAccessToken(user);

  const url = "https://members-ng.iracing.com/data/member/chart_data?chart_type=1&category_id=6";

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    console.error(`Formula iRating fetch failed: ${res.status}`);
    return null;
  }

  const data = await res.json();

  // Log the full response for debugging
  console.log("Full Formula chart_data response:", JSON.stringify(data, null, 2));

  if (data && data.data && Array.isArray(data.data) && data.data.length > 0) {
    const latest = data.data[data.data.length - 1];
    return latest.value;  // the iRating number
  }

  console.log("No Formula iRating data found in response");
  return null;
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
// Temporary PKCE storage (in production you'd use session or DB per user)
let pkceStore = {};

// --------------------------------
// LOGIN ROUTE - Start OAuth flow
// --------------------------------
app.get("/oauth/login", (req, res) => {
  const codeVerifier = crypto.randomBytes(32).toString("hex");
  const hash = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64");
  // Convert to base64url
  const codeChallenge = hash
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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
// CALLBACK ROUTE - Exchange code for token + SAVE to persistent file
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
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
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

    // Get Discord user ID from state (passed in /link command)
    const discordId = req.query.state || "unknown";

    // Load existing linked drivers, remove old entry for this user if exists
    let drivers = loadLinkedDrivers();
    drivers = drivers.filter(d => d.discordId !== discordId);

    // Save the tokens and basic info
    drivers.push({
      discordId,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000
    });

    saveLinkedDrivers(drivers);

    res.send("✅ iRacing account successfully linked!<br><br>You can now close this window.");
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).send("OAuth process failed. Check server logs.");
  }
});

// Root route
app.get("/", (req, res) => {
  res.send("🏁 GSR Bot OAuth Server is running.");
});

app.get("/test-irating", async (req, res) => {
  try {
    const drivers = loadLinkedDrivers();
    if (drivers.length === 0) {
      return res.send("No linked drivers yet. Link one first!");
    }

    const user = drivers[0]; // Your account
    const token = await getValidAccessToken(user);

    const url = "https://members-ng.iracing.com/data/member/chart_data?chart_type=1&category_id=6";

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const json = await response.json(); // Parse even on non-OK

    console.log("Full chart_data JSON response:", JSON.stringify(json, null, 2));

    let message = "Test result:<br>";
    if (!response.ok) {
      message += `API returned ${response.status}: ${await response.text()}`;
    } else if (json.data && Array.isArray(json.data) && json.data.length > 0) {
      const latest = json.data[json.data.length - 1];
      message += `Your current Sports Car iRating: <b>${latest.value}</b> (from ${latest.when})`;
    } else {
      message += "No iRating chart data available (empty or missing 'data' array). Raw response logged in Railway logs.";
    }

    res.send(message + "<br><br>Check Railway logs for 'Full chart_data JSON response'.");
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
    const state = encodeURIComponent(interaction.user.id); // Pass Discord ID
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