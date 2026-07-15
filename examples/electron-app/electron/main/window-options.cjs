const path = require("node:path");

function windowOptions() {
  return {
    width: 900,
    height: 640,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "../preload/index.cjs"),
    },
  };
}

module.exports = { windowOptions };
