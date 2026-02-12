require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder
} = require("discord.js");

const express = require("express");
const fetch = require("node-fetch");

// ===============================
// ENV VARIABLES
// ===============================

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  ANNOUNCE_CHANNEL_ID,
  IRACING_CLIENT_ID,
  IRACING_CLIENT_SECRET,
  IRACING_REDIRECT_URI
} = process.env;

if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing.");
  process.exit(1);
}

// ===============================
// DISCORD CLIENT
// ===============================

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ===============================
// EXPRESS SERVER (OAUTH)
// ===============================

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Login route (redirects to iRacing)
app.get("/oauth/login", (req, res) => {
  const authUrl =
    "https://oauth.iracing.com/oauth2/authorize?" +
    `response_type=code` +
    `&client_id=${IRACING_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(IRACING_REDIRECT_URI)}` +
    `&scope=openid` +
    `&audience=data-server`;

  res.redirect(authUrl);
});

// Callback route
app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).send("Missing authorization code.");
  }

  try {
    const tokenResponse = await fetch(
      "https://oauth.iracing.com/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code,
          redirect_uri: IRACING_REDIRECT_URI,
          client_id: IRACING_CLIENT_ID,
          client_secret: IRACING_CLIENT_SECRET
        })
      }
    );

    const tokenData = await tokenResponse.json();

    console.log("✅ OAuth Success:", tokenData);

    res.send("✅ iRacing account successfully linked! You may close this window.");
  } catch (err) {
    console.error("❌ OAuth Error:", err);
    res.status(500).send("OAuth failed.");
  }
});

// Start Express
app.listen(PORT, () => {
  console.log(`🌐 OAuth server running on port ${PORT}`);
});

// ===============================
// BOT READY
// ===============================

client.once("ready", () => {
  console.log("✅ Bot is logged into Discord!");
});

// ===============================
// SLASH COMMAND HANDLER
// ===============================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    return interaction.reply("🏁 Pong! Bot is alive.");
  }

  if (interaction.commandName === "link") {
    const loginUrl = `${IRACING_REDIRECT_URI.replace(
      "/oauth/callback",
      ""
    )}/oauth/login`;

    return interaction.reply({
      content: `🔗 Click here to link your iRacing account:\n${loginUrl}`,
      ephemeral: true
    });
  }
});

// ===============================
// REGISTER SLASH COMMANDS
// ===============================

const commands = [
  {
    name: "ping",
    description: "Test if the bot is responding"
  },
  {
    name: "link",
    description: "Link your iRacing account"
  }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log("🔄 Registering slash commands...");

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log("✅ Slash commands registered.");
  } catch (error) {
    console.error("❌ Error registering commands:", error);
  }
})();

// ===============================
// START BOT
// ===============================

client.login(DISCORD_TOKEN);
