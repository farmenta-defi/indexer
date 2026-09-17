// pm2 process file for the VPS (README, "Deploy"). Secrets are not here: Node loads them
// from .env in `cwd` (`--env-file`), before Ponder reads PORT.
module.exports = {
  apps: [
    {
      name: "farmenta-indexer",
      cwd: __dirname,
      script: "node_modules/ponder/dist/esm/bin/ponder.js",
      args: "start --schema ponder",
      interpreter: "node",
      node_args: "--env-file=.env",
      // One instance only: two Ponder processes on one schema fight over its lock.
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // A crash loop on a bad RPC key should not burn paid RPC quota at full speed.
      exp_backoff_restart_delay: 2000,
      max_memory_restart: "1G",
      time: true,
    },
  ],
};
