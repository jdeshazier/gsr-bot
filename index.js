require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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

// ====================== STORAGE ======================
const DATA_DIR = "/app/data";
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
  if (!res.ok) throw new Error("Token refresh failed");
  const data = await res.json();
  user.accessToken = data.access_token;
  user.refreshToken = data.refresh_token || user.refreshToken;
  user.expiresAt = Date.now() + data.expires_in * 1000;
  return user.accessToken;
}

async function getCurrentIRating(user) {
  try {
    const token = await getValidAccessToken(user);
    const rootUrl = "https://members-ng.iracing.com/data/member/chart_data?chart_type=1&category_id=5";
    const rootRes = await fetch(rootUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!rootRes.ok) return null;
    const rootJson = await rootRes.json();
    let chartUrl = rootUrl;
    if (rootJson.link) chartUrl = rootJson.link;
    const chartRes = await fetch(chartUrl);
    if (!chartRes.ok) return null;
    const chartJson = await chartRes.json();
    if (chartJson.data && chartJson.data.length > 0) {
      return chartJson.data[chartJson.data.length - 1].value;
    }
  } catch (e) {}
  return null;
}

// ====================== EXPRESS ======================
const app = express();
const PORT = process.env.PORT || 3000;
const AUTHORIZE_URL = "https://oauth.iracing.com/oauth2/authorize";
const TOKEN_URL = "https://oauth.iracing.com/oauth2/token";
let pkceStore = {};

// Login & Callback (unchanged)
app.get("/oauth/login", (req, res) => {
  const codeVerifier = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(codeVerifier).digest("base64");
  const codeChallenge = hash.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  pkceStore.verifier = codeVerifier;
  const authUrl = `${AUTHORIZE_URL}?response_type=code&client_id=${encodeURIComponent(IRACING_CLIENT_ID)}&redirect_uri=${encodeURIComponent(IRACING_REDIRECT_URI)}&scope=iracing.auth iracing.profile&state=${encodeURIComponent(req.query.state || "unknown")}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
  console.log("Redirecting to:", authUrl);
  res.redirect(authUrl);
});

app.get("/oauth/callback", async (req, res) => {
  // ... (your working callback from before - unchanged) ...
  // I'll keep it short here, but use your last working version
  // Just make sure discordId = req.query.state
});

// Root + test
app.get("/", (req, res) => res.send("🏁 GSR Bot OAuth Server is running."));

app.listen(PORT, () => console.log(`🌐 OAuth server running on port ${PORT}`));

// ====================== DISCORD COMMANDS ======================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => console.log("✅ Bot logged in!"));

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") return interaction.reply("🏁 Pong!");

  if (interaction.commandName === "link") {
    const state = encodeURIComponent(interaction.user.id);
    const loginUrl = `https://www.gsracing.app/oauth/login?state=${state}`;
    return interaction.reply({ content: `🔗 Link iRacing: ${loginUrl}`, ephemeral: true });
  }

  // UNLINK - ADMIN ONLY
  if (interaction.commandName === "unlink") {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: "❌ Only administrators can use this command.", ephemeral: true });
    }
    const target = interaction.options.getUser("user");
    if (!target) return interaction.reply({ content: "Please select a user.", ephemeral: true });

    const drivers = loadLinkedDrivers();
    const driver = drivers.find(d => d.discordId === target.id);
    if (!driver) return interaction.reply({ content: "That user is not linked.", ephemeral: true });

    const embed = new EmbedBuilder()
      .setTitle("⚠️ Confirm Unlink")
      .setColor(0xff0000)
      .setDescription("Are you sure?")
      .addFields(
        { name: "Discord", value: target.tag, inline: true },
        { name: "iRacing Name", value: driver.iracingName || "Unknown", inline: true },
        { name: "Last iRating", value: (driver.lastIRating ?? "??").toString(), inline: true }
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`unlink_yes_${target.id}`).setLabel("Yes, Unlink").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("unlink_no").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  // NEW: /leaderboard command
  if (interaction.commandName === "leaderboard") {
    await showLeaderboard(interaction);
  }
});

// Button handler for unlink confirmation
client.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;

  if (interaction.customId.startsWith("unlink_yes_")) {
    const targetId = interaction.customId.split("_")[2];
    let drivers = loadLinkedDrivers();
    drivers = drivers.filter(d => d.discordId !== targetId);
    saveLinkedDrivers(drivers);
    await interaction.update({ content: "✅ Driver unlinked successfully.", embeds: [], components: [] });
  }

  if (interaction.customId === "unlink_no") {
    await interaction.update({ content: "Unlink cancelled.", embeds: [], components: [] });
  }
});

// Reusable function for nice leaderboard embed
async function showLeaderboard(interaction) {
  let drivers = loadLinkedDrivers();
  if (drivers.length === 0) {
    return interaction.reply({ content: "No drivers linked yet.", ephemeral: true });
  }

  // Quick update iRatings (optional - can be removed if you want it instant)
  for (const driver of drivers) {
    try {
      const ir = await getCurrentIRating(driver);
      if (ir !== null) {
        const old = driver.lastIRating ?? ir;
        driver.lastIRating = ir;
        driver.lastChange = ir - old;
      }
    } catch (e) {}
  }

  drivers.sort((a, b) => (b.lastIRating ?? 0) - (a.lastIRating ?? 0));
  drivers.forEach((d, i) => d.lastRank = i + 1);
  saveLinkedDrivers(drivers);

  const embed = new EmbedBuilder()
    .setTitle("🏁 Road iRating Leaderboard")
    .setColor(0x00ff88)
    .setTimestamp()
    .setFooter({ text: `Updated just now • ${drivers.length} total drivers` });

  drivers.slice(0, 20).forEach((d, i) => {
    let change = "";
    if (d.lastChange) change = d.lastChange > 0 ? ` **(+${d.lastChange})** ⬆️` : ` **(${d.lastChange})** ⬇️`;
    embed.addFields({
      name: `${i+1}. ${d.iracingName || "Unknown"}`,
      value: `${d.lastIRating ?? "??"} iR${change}`,
      inline: true
    });
  });

  await interaction.reply({ embeds: [embed] });
}

// ====================== REGISTER COMMANDS ======================
const commands = [
  { name: "ping", description: "Test bot" },
  { name: "link", description: "Link iRacing account" },
  { 
    name: "unlink", 
    description: "Admin: Unlink a driver", 
    options: [{ name: "user", description: "Discord user to unlink", type: 6, required: true }]
  },
  { name: "leaderboard", description: "Show current Road iRating leaderboard" }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Commands registered (including /leaderboard).");
  } catch (err) {
    console.error(err);
  }
})();

client.login(DISCORD_TOKEN);

// ====================== CRON (same nice embed) ======================
const { CronJob } = require('cron');

new CronJob('*/5 * * * *', async () => {
  const channel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
  if (!channel) return;
  await showLeaderboard({ reply: async (msg) => channel.send(msg) }); // reuse the same function
}, null, true, 'America/Chicago');