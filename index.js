require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder,
  PermissionsBitField
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
  const res = await fetch("https://oauth.iracing.com/oauth2/token", {
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

// PKCE store keyed by Discord user ID (state) to prevent race conditions
const pkceStore = {};
const TEN_MINUTES = 10 * 60 * 1000;

app.get("/oauth/login", (req, res) => {
  const state = req.query.state || "unknown";

  // Generate a 128-character verifier (iRacing recommends max length)
  const codeVerifier = crypto.randomBytes(64).toString("hex");
  const hash = crypto.createHash("sha256").update(codeVerifier).digest("base64");
  const codeChallenge = hash.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  // Store verifier keyed by Discord user ID instead of a single global slot
  pkceStore[state] = {
    verifier: codeVerifier,
    createdAt: Date.now()
  };

  // Clean up stale verifiers older than 10 minutes
  for (const key of Object.keys(pkceStore)) {
    if (Date.now() - pkceStore[key].createdAt > TEN_MINUTES) {
      delete pkceStore[key];
    }
  }

  const authUrl = `${AUTHORIZE_URL}?response_type=code&client_id=${encodeURIComponent(IRACING_CLIENT_ID)}&redirect_uri=${encodeURIComponent(IRACING_REDIRECT_URI)}&scope=iracing.auth iracing.profile&state=${encodeURIComponent(state)}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
  console.log("Redirecting to:", authUrl);
  res.redirect(authUrl);
});

app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing authorization code.");

  const discordId = req.query.state || "unknown";

  // Retrieve and immediately delete the verifier for this user
  const pkceEntry = pkceStore[discordId];
  delete pkceStore[discordId];

  if (!pkceEntry) return res.status(400).send("OAuth session expired or not found. Please try linking again.");
  if (Date.now() - pkceEntry.createdAt > TEN_MINUTES) return res.status(400).send("OAuth session expired. Please try linking again.");

  try {
    const maskedSecret = maskSecret(IRACING_CLIENT_SECRET, IRACING_CLIENT_ID);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: IRACING_CLIENT_ID,
      client_secret: maskedSecret,
      code,
      redirect_uri: IRACING_REDIRECT_URI,
      code_verifier: pkceEntry.verifier
    });

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error) return res.status(400).send(`OAuth Error: ${tokenData.error || "Unknown"}`);

    const profileUrl = "https://oauth.iracing.com/oauth2/iracing/profile";
    const profileRes = await fetch(profileUrl, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    let iracingName = "Unknown";
    if (profileRes.ok) {
      const profileJson = await profileRes.json();
      if (profileJson.iracing_name) {
        let fullName = profileJson.iracing_name.trim();
        const parts = fullName.split(/\s+/);
        if (parts.length >= 2) {
          iracingName = `${parts[0]} ${parts[parts.length-1][0].toUpperCase()}.`;
        } else {
          iracingName = fullName;
        }
      }
    }

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
    res.status(500).send("Linking failed.");
  }
});

app.get("/", (req, res) => res.send("🏁 GSR Bot OAuth Server is running."));
app.listen(PORT, () => console.log(`🌐 OAuth server running on port ${PORT}`));

// ====================== DISCORD ======================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Fixed deprecation warning: use clientReady instead of ready
client.once("clientReady", () => console.log("✅ Bot logged in!"));

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") return interaction.reply("🏁 Pong!");

  if (interaction.commandName === "link") {
    const state = encodeURIComponent(interaction.user.id);
    const loginUrl = `https://www.gsracing.app/oauth/login?state=${state}`;
    return interaction.reply({ content: `🔗 Link iRacing: ${loginUrl}`, ephemeral: true });
  }

  if (interaction.commandName === "unlinkme") {
    let drivers = loadLinkedDrivers();
    const initial = drivers.length;
    drivers = drivers.filter(d => d.discordId !== interaction.user.id);
    if (drivers.length < initial) {
      saveLinkedDrivers(drivers);
      return interaction.reply({ content: "✅ You have been unlinked from the leaderboard.", ephemeral: true });
    } else {
      return interaction.reply({ content: "You were not linked.", ephemeral: true });
    }
  }

  if (interaction.commandName === "unlink") {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: "❌ Only administrators can use this command.", ephemeral: true });
    }
    const target = interaction.options.getUser("user");
    if (!target) return interaction.reply({ content: "Please select a user.", ephemeral: true });

    let drivers = loadLinkedDrivers();
    const initial = drivers.length;
    drivers = drivers.filter(d => d.discordId !== target.id);
    if (drivers.length < initial) {
      saveLinkedDrivers(drivers);
      return interaction.reply(`✅ Successfully unlinked **${target.tag}**.`);
    } else {
      return interaction.reply({ content: "That user was not linked.", ephemeral: true });
    }
  }

  if (interaction.commandName === "myirating") {
    const drivers = loadLinkedDrivers();
    const driver = drivers.find(d => d.discordId === interaction.user.id);
    if (!driver) return interaction.reply({ content: "You are not linked yet. Use `/link` first!", ephemeral: true });

    const current = driver.lastIRating ?? "??";
    let changeText = "No change yet";
    if (driver.lastChange !== undefined) {
      changeText = driver.lastChange > 0 ? `**+${driver.lastChange}**` : `**${driver.lastChange}**`;
    }

    const embed = new EmbedBuilder()
      .setTitle("📊 Your iRating")
      .setColor(0x00ff88)
      .addFields(
        { name: "iRacing Name", value: driver.iracingName || "Unknown", inline: true },
        { name: "Current iRating", value: current.toString(), inline: true },
        { name: "Change", value: changeText, inline: true },
        { name: "Current Rank", value: driver.lastRank ? `#${driver.lastRank}` : "Not ranked yet", inline: true }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === "leaderboard") {
    await showLeaderboard(interaction);
  }
});

// ====================== LEADERBOARD ======================
async function showLeaderboard(interactionOrChannel) {
  // Determine if this is a slash command interaction or a channel (cron job)
  const isInteraction = !!(interactionOrChannel.deferReply);

  try {
    let drivers = loadLinkedDrivers();
    if (drivers.length === 0) {
      if (isInteraction) {
        return interactionOrChannel.reply({ content: "No drivers linked yet.", ephemeral: true });
      } else {
        return interactionOrChannel.send({ content: "No drivers linked yet." });
      }
    }

    // Defer immediately so Discord doesn't time out while we fetch iRatings
    if (isInteraction) {
      await interactionOrChannel.deferReply();
    }

    // Update iRatings
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

    // Determine embed color based on #1 change
    let embedColor = 0x00ff88;
    if (drivers[0]?.lastChange > 0) {
      embedColor = 0x00cc66;
    } else if (drivers[0]?.lastChange < 0) {
      embedColor = 0xff4444;
    }

    const totalDrivers = drivers.length;
    const displayed = Math.min(drivers.length, 20);

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setThumbnail("https://cdn.discordapp.com/attachments/1396172486558613514/1402298298450186350/Maybe.png?ex=699a6acf&is=6999194f&hm=5bd0de5d8200e0af87742858135e252c608bc6ad1d144046203fee96edbd8d17&")
      .setDescription("**🏁 GSR iRating Leaderboard**")
      .setTimestamp();

    drivers.slice(0, 20).forEach((d, i) => {
      let rankDisplay = "";
      if (i === 0) rankDisplay = "🥇";
      else if (i === 1) rankDisplay = "🥈";
      else if (i === 2) rankDisplay = "🥉";
      else rankDisplay = `${i + 1}️⃣`;

      let change = "";
      if (d.lastChange !== undefined) {
        if (d.lastChange > 0) {
          change = ` 🟢 **+${d.lastChange}** ⬆️`;
        } else if (d.lastChange < 0) {
          change = ` 🔴 **${d.lastChange}** ⬇️`;
        } else {
          change = ` ⚪ **0**`;
        }
      }

      embed.addFields({
        name: `${rankDisplay} **${i + 1}.** ${d.iracingName || "Unknown"}`,
        value: `**${d.lastIRating ?? "??"}** iR${change}`,
        inline: false
      });
    });

    embed.setFooter({
      text: displayed < totalDrivers
        ? `Showing top ${displayed} of ${totalDrivers} drivers`
        : `Total drivers: ${totalDrivers}`
    });

    if (isInteraction) {
      await interactionOrChannel.editReply({ embeds: [embed] });
    } else {
      await interactionOrChannel.send({ embeds: [embed] });
    }

  } catch (err) {
    console.error("Leaderboard error:", err);
    if (isInteraction) {
      // If we already deferred, use editReply — otherwise fall back to reply
      const respond = interactionOrChannel.deferred
        ? interactionOrChannel.editReply.bind(interactionOrChannel)
        : interactionOrChannel.reply.bind(interactionOrChannel);
      await respond({ content: "❌ Failed to load leaderboard. Please try again." }).catch(() => {});
    }
  }
}

// ====================== REGISTER COMMANDS ======================
const commands = [
  { name: "ping", description: "Test bot" },
  { name: "link", description: "Link iRacing account" },
  { name: "unlinkme", description: "Unlink yourself" },
  { name: "unlink", description: "Admin: Unlink another driver", options: [{ name: "user", description: "User to unlink", type: 6, required: true }] },
  { name: "myirating", description: "Show your personal iRating" },
  { name: "leaderboard", description: "Show GSR iRating Leaderboard" }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Commands registered.");
  } catch (err) {
    console.error(err);
  }
})();

client.login(DISCORD_TOKEN);

// ====================== CRON ======================
const { CronJob } = require('cron');
new CronJob('0 12 * * *', async () => {
  const channel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
  if (channel) await showLeaderboard(channel);
}, null, true, 'America/Chicago');