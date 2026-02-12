// ===============================
// 🔐 ENVIRONMENT SETUP
// ===============================
require("dotenv").config();

// ===============================
// 📦 IMPORTS
// ===============================
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder
} = require("discord.js");

const cron = require("node-cron");
const db = require("./src/db");
const { checkForPositionChanges } = require("./src/announcer");

// ===============================
// 🔑 CONSTANTS
// ===============================
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = "1467611030455587053";
const GUILD_ID = "1382715146979508234";
const ANNOUNCE_CHANNEL_ID = "1466597846752034947";

// ===============================
// 🤖 CREATE CLIENT
// ===============================
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ===============================
// ✅ BOT READY
// ===============================
client.once("ready", () => {
  console.log("✅ Bot is logged into Discord!");

  // Initial snapshot after startup
  setTimeout(() => {
    console.log("📊 Initial leaderboard snapshot");
    checkForPositionChanges(client, ANNOUNCE_CHANNEL_ID);
  }, 5000);

  // Check every minute
  setInterval(() => {
    console.log("🔄 Checking for leaderboard changes...");
    checkForPositionChanges(client, ANNOUNCE_CHANNEL_ID);
  }, 60 * 1000);

  // 🕖 Daily leaderboard post (12:00 PM local time)
  cron.schedule("0 12 * * *", () => {
    const channel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
    if (!channel) return;

    const drivers = db.prepare(`
      SELECT * FROM drivers
      ORDER BY irating DESC
    `).all();

    let description = "";
    drivers.forEach((driver, index) => {
      description += `${index + 1}️⃣ **${driver.name}** — ${driver.irating}\n`;
    });

    const embed = new EmbedBuilder()
      .setTitle("🏁 GSR Daily iRating Leaderboard")
      .setColor(0xff0000)
      .setDescription(description)
      .setFooter({ text: "Daily automatic update" });

    channel.send({ embeds: [embed] });
  });
});

// ===============================
// 💬 SLASH COMMAND HANDLER
// ===============================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // /ping
    if (interaction.commandName === "ping") {
      return interaction.reply("🏁 Pong! Slash command works.");
    }

    // /leaderboard
    if (interaction.commandName === "leaderboard") {
      const drivers = db.prepare(`
        SELECT * FROM drivers
        ORDER BY irating DESC
      `).all();

      let description = "";
      drivers.forEach((driver, index) => {
        description += `${index + 1}️⃣ **${driver.name}** — ${driver.irating}\n`;
      });

      const embed = new EmbedBuilder()
        .setTitle("🏁 GSR iRating Leaderboard")
        .setColor(0xff0000)
        .setDescription(description)
        .setFooter({ text: "Auto-tracked leaderboard" });

      return interaction.reply({ embeds: [embed] });
    }

    // /setirating (ROLE LOCKED)
    if (interaction.commandName === "setirating") {
      await interaction.deferReply({ ephemeral: true });

      const allowedRole = "Admin";
      const hasRole = interaction.member.roles.cache.some(
        role => role.name === allowedRole
      );

      if (!hasRole) {
        return interaction.editReply(
          `❌ You must have the **${allowedRole}** role to use this command.`
        );
      }

      const driverName = interaction.options.getString("driver");
      const newIRating = interaction.options.getInteger("irating");

      const result = db.prepare(
        "UPDATE drivers SET irating = ? WHERE name = ?"
      ).run(newIRating, driverName);

      if (result.changes === 0) {
        return interaction.editReply(
          `❌ Driver **${driverName}** not found.`
        );
      }

      return interaction.editReply(
        `✅ Updated **${driverName}** to **${newIRating} iRating**`
      );
    }

    // /forcepost (ROLE LOCKED)
    if (interaction.commandName === "forcepost") {
      await interaction.deferReply({ ephemeral: true });

      const allowedRole = "Admin";
      const hasRole = interaction.member.roles.cache.some(
        role => role.name === allowedRole
      );

      if (!hasRole) {
        return interaction.editReply(
          `❌ You must have the **${allowedRole}** role to use this command.`
        );
      }

      const channel = client.channels.cache.get(ANNOUNCE_CHANNEL_ID);
      if (!channel) {
        return interaction.editReply("❌ Announcement channel not found.");
      }

      const drivers = db.prepare(`
        SELECT * FROM drivers
        ORDER BY irating DESC
      `).all();

      let description = "";
      drivers.forEach((driver, index) => {
        description += `${index + 1}️⃣ **${driver.name}** — ${driver.irating}\n`;
      });

      const embed = new EmbedBuilder()
        .setTitle("🏁 GSR iRating Leaderboard")
        .setColor(0xff0000)
        .setDescription(description)
        .setFooter({ text: "Manually posted" });

      await channel.send({ embeds: [embed] });
      return interaction.editReply("✅ Leaderboard posted.");
    }

    // /link (STUB)
    if (interaction.commandName === "link") {
      return interaction.reply({
        content: "🔒 iRacing account linking is coming soon.",
        ephemeral: true
      });
    }

  } catch (error) {
    console.error("❌ Interaction error:", error);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply("❌ An unexpected error occurred.");
    } else {
      await interaction.reply({
        content: "❌ An unexpected error occurred.",
        ephemeral: true
      });
    }
  }
});

// ===============================
// 📋 REGISTER SLASH COMMANDS
// ===============================
const commands = [
  {
    name: "ping",
    description: "Test if the bot is responding"
  },
  {
    name: "leaderboard",
    description: "Show the iRating leaderboard"
  },
  {
    name: "setirating",
    description: "Set a driver's iRating (admin only)",
    options: [
      {
        name: "driver",
        description: "Driver name",
        type: 3,
        required: true
      },
      {
        name: "irating",
        description: "New iRating value",
        type: 4,
        required: true
      }
    ]
  },
  {
    name: "forcepost",
    description: "Manually post the leaderboard (admin only)"
  },
  {
    name: "link",
    description: "Link your iRacing account"
  }
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

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
// 🚀 START BOT
// ===============================
client.login(TOKEN);
