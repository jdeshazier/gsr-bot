const db = require("./db");

// Update iRatings instead of deleting drivers
const update = db.prepare(
  "UPDATE drivers SET irating = ? WHERE name = ?"
);

// Change numbers here to test movement
update.run(2300, "Driver One");
update.run(2700, "Driver Two"); // should move up
update.run(1800, "Driver Three");

console.log("✅ iRatings updated.");
