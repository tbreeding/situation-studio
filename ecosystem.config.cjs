const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "situation-studio-web",
      cwd: __dirname,
      script: path.join(__dirname, "ops/start-web.sh"),
      interpreter: "/bin/bash",
      env: {
        NODE_ENV: "production",
        SITUATION_STUDIO_SHARED_DIR:
          "/home/admin/projects/situation-studio/shared",
      },
      max_memory_restart: "640M",
      kill_timeout: 10_000,
      listen_timeout: 10_000,
      autorestart: true,
    },
  ],
};
