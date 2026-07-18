const path = require("node:path");
const currentRelease = "/home/admin/projects/situation-studio/current";

module.exports = {
  apps: [
    {
      name: "situation-studio-web",
      cwd: currentRelease,
      script: path.join(currentRelease, "ops/start-web.sh"),
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
    {
      name: "situation-studio-worker",
      cwd: currentRelease,
      script: path.join(currentRelease, "ops/start-worker.sh"),
      interpreter: "/bin/bash",
      env: {
        NODE_ENV: "production",
        SITUATION_STUDIO_SHARED_DIR:
          "/home/admin/projects/situation-studio/shared",
      },
      max_memory_restart: "1536M",
      kill_timeout: 30_000,
      autorestart: true,
    },
  ],
};
