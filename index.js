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

IRACING_CLIENT_ID=gsrbot;
IRACING_CLIENT_SECRET=grandpa-rectangle-Exhale-DECEIVING-handcart-Suction;
IRACING_REDIRECT_URI=https://www.gsracing.app/oauth/callback;


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

  const hash = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64");

  // Convert to base64url manually
  const codeChallenge = hash
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  pkceStore.verifier = codeVerifier;

  const authUrl =
    `${AUTHORIZE_URL}?` +
    `response_type=code` +
    `&client_id=${IRACING_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(IRACING_REDIRECT_URI)}` +
    `&scope=openid` +
    `&audience=data-server` +
    `&code_challenge=${codeChallenge}` +
    `&code_challenge_method=S256`;

  res.redirect(authUrl);
});

// --------------------------------
// CALLBACK ROUTE
// --------------------------------

app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).send("Missing authorization code.");
  }

  try {
    // Basic Auth header (required by iRacing)
    const basicAuth = Buffer.from(
      `${IRACING_CLIENT_ID}:${IRACING_CLIENT_SECRET}`
    ).toString("base64");

    const tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${basicAuth}`
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: IRACING_CLIENT_ID, // 🔥 REQUIRED
        code: code,
        redirect_uri: IRACING_REDIRECT_URI,
        code_verifier: pkceStore.verifier
      })
    });

    const tokenData = await tokenResponse.json();

    console.log("TOKEN RESPONSE:", tokenData);

    if (tokenData.error) {
      return res.status(500).send(`OAuth Error: ${tokenData.error}`);
    }

    res.send("✅ iRacing account successfully linked!");
  } catch (err) {
    console.error("OAuth Error:", err);
    res.status(500).send("OAuth failed.");
  }
});

// Root route
app.get("/", (req, res) => {
  res.send("🏁 GSR Bot OAuth Server is running.");
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
        "🔗 Click here to link your iRacing account:\nhttps://www.gsracing.app/oauth/login",
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
    console.error(error);
  }
})();

client.login(DISCORD_TOKEN);