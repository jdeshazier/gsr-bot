const db = require("./db");

function checkForPositionChanges(client, channelId) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  const drivers = db.prepare(`
    SELECT * FROM drivers
    ORDER BY irating DESC
  `).all();

  drivers.forEach((driver, index) => {
    const newRank = index + 1;
    const oldRank = driver.last_rank;

    if (oldRank && oldRank !== newRank) {
      const movement = oldRank - newRank;
      const emoji = movement > 0 ? "📈" : "📉";

      channel.send(
        `${emoji} **${driver.name}** moved from **P${oldRank} → P${newRank}** (${movement > 0 ? "+" : ""}${movement})`
      );
    }

    // Save the new rank
    db.prepare(
      "UPDATE drivers SET last_rank = ? WHERE id = ?"
    ).run(newRank, driver.id);
  });
}

module.exports = { checkForPositionChanges };
