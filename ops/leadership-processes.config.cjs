const studioCurrent = "/home/admin/projects/situation-studio/current";

function leadershipProcess(name, releaseLink, port, siteUrl) {
  return {
    name,
    cwd: "/home/admin/projects/leadership",
    script: `${studioCurrent}/ops/start-leadership-release.sh`,
    interpreter: "/bin/bash",
    env: {
      NODE_ENV: "production",
      LEADERSHIP_RELEASE_LINK: releaseLink,
      LEADERSHIP_BIND_ADDRESS: "192.168.1.120",
      LEADERSHIP_PORT: String(port),
      NEXT_PUBLIC_SITE_URL: siteUrl,
    },
    max_memory_restart: "640M",
    kill_timeout: 10_000,
    listen_timeout: 10_000,
    autorestart: true,
  };
}

module.exports = {
  apps: [
    leadershipProcess(
      "leadership-field-guide",
      "/home/admin/projects/leadership/current",
      3005,
      "https://leadership.timsprototypes.com",
    ),
  ],
};
