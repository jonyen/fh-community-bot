module.exports = {
  apps: [
    {
      name: "fh-maintenance-bot",
      script: "src/app.js",
      restart_delay: 5000,
      max_restarts: 10,
    },
  ],
};
