const release = process.env.SITUATION_STUDIO_RELEASE;

if (!release) throw new Error("SITUATION_STUDIO_RELEASE is required.");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const webUser = required("SITUATION_STUDIO_WEB_USER");
const reviewUser = required("SITUATION_STUDIO_REVIEW_USER");
const publisherUser = required("SITUATION_STUDIO_PUBLISHER_USER");
const webEnvironment = required("SITUATION_STUDIO_WEB_ENV_FILE");
const reviewEnvironment = required("SITUATION_STUDIO_REVIEW_ENV_FILE");
const publisherEnvironment = required("SITUATION_STUDIO_PUBLISHER_ENV_FILE");

module.exports = {
  apps: [
    {
      name: "situation-studio-web",
      cwd: release,
      uid: webUser,
      script: "ops/start-isolated-process.sh",
      args: "web",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
        SITUATION_STUDIO_RELEASE: release,
        SITUATION_STUDIO_PROCESS_ENV_FILE: webEnvironment,
      },
    },
    {
      name: "situation-studio-review-worker",
      cwd: release,
      uid: reviewUser,
      script: "ops/start-isolated-process.sh",
      args: "review-worker",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
        SITUATION_STUDIO_RELEASE: release,
        SITUATION_STUDIO_PROCESS_ENV_FILE: reviewEnvironment,
      },
    },
    {
      name: "situation-studio-publisher",
      cwd: release,
      uid: publisherUser,
      script: "ops/start-isolated-process.sh",
      args: "publisher",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
        SITUATION_STUDIO_RELEASE: release,
        SITUATION_STUDIO_PROCESS_ENV_FILE: publisherEnvironment,
      },
    },
  ],
};
