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

// These lines let us work with files on the computer
const fs = require('fs');
const path = require('path');

// This is the permanent folder Railway gave us
const DATA_DIR = '/app/data';
const LINKED_FILE = path.join(DATA_DIR, 'linked-drivers.json');

// Helper 1: Read the list of linked people (or empty list if no file yet)
function loadLinkedDrivers() {
  try {
    // Make sure the folder exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    // If no file yet, return empty list
    if (!fs.existsSync(LINKED_FILE)) {
      return [];
    }
    // Read the file and turn it into a list
    const data = fs.readFileSync(LINKED_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Could not read linked-drivers.json:', err.message);
    return []; // safe fallback
  }
}

// Helper 2: Save the list back to the file
function saveLinkedDrivers(drivers) {
  try {
    // Make sure folder exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    // Turn the list into text and save it
    fs.writeFileSync(LINKED_FILE, JSON.stringify(drivers, null, 2), 'utf8');
    console.log(`Saved ${drivers.length} linked driver(s)!`);
  } catch (err) {
    console.error('Could not save linked-drivers.json:', err.message);
  }
}

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
// CALLBACK ROUTE - Exchange code for token + store user
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

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("Token failed:", tokenResponse.status, errorText);
      return res.status(tokenResponse.status).send(`Token request failed: ${errorText}`);
    }

    const tokenData = await tokenResponse.json();
    console.log("Got tokens:", JSON.stringify(tokenData, null, 2));

    // FIXED: Use chart_data endpoint to get the authenticated member's info
    // (this call returns the current user's chart, but root often has cust_id and name)
    const memberRes = await fetch(
      "https://members-ng.iracing.com/data/member/chart_data?chart_type=1&category_id=5",
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`
        }
      }
    );

    if (!memberRes.ok) {
      const errText = await memberRes.text();
      console.error("Member info (chart_data) fetch failed:", memberRes.status, errText);
      throw new Error(`Could not get member info: ${memberRes.status} - ${errText}`);
    }

    const member = await memberRes.json();

    // Parse from chart_data response (root level fields)
    const custId = member.cust_id;
    const iracingName = member.name || "Unknown";  // field is usually "name"

    if (!custId) {
      console.error("No cust_id in chart_data response:", JSON.stringify(member, null, 2));
      throw new Error("No cust_id returned");
    }

    // Get Discord user ID from state (passed from /link)
    const discordId = req.query.state || "unknown";

    // Load current linked drivers, remove old entry for this Discord ID
    let drivers = loadLinkedDrivers();
    drivers = drivers.filter(d => d.discordId !== discordId);

    // Add the new linked user
    drivers.push({
      discordId,
      iracingCustId: custId,
      iracingName,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + (tokenData.expires_in * 1000),
      lastIRating: null,
      lastRank: null
    });

    saveLinkedDrivers(drivers);

    // Success message
    res.send(
      `✅ Success! Your iRacing account is linked.<br><br>` +
      `Name: **${iracingName}**<br>` +
      `Cust ID: #${custId}<br>` +
      `Discord ID: ${discordId}<br><br>` +
      `You can close this tab now and go back to Discord.`
    );
  } catch (err) {
    console.error("Problem in callback:", err.message, err.stack);
    res.status(500).send("Linking failed. Check the bot logs in Railway.");
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
  const state = encodeURIComponent(interaction.user.id);
  const loginUrl = `https://www.gsracing.app/oauth/login?state=${state}`;
  return interaction.reply({
    content: `🔗 Click here to link iRacing:\n${loginUrl}`,
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