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
// CALLBACK ROUTE - Exchange code for token
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

    // Success - in a real app, store access_token + refresh_token securely
    // (e.g. in a database tied to the Discord user who initiated the link)
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

app.get('/debug-volume', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const testFile = path.join('/app/data', 'test.txt');
  try {
    fs.writeFileSync(testFile, 'Volume is working! ' + new Date().toISOString());
    const content = fs.readFileSync(testFile, 'utf8');
    res.send(`Volume test OK: ${content}`);
  } catch (err) {
    res.status(500).send(`Volume test FAILED: ${err.message}`);
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
    return interaction.reply({
      content:
        "🔗 Click here to link your iRacing account:\n" +
        "https://www.gsracing.app/oauth/login",   // ← update domain/port if testing locally
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