// pm2 config for a hosted install behind an HTTPS reverse proxy (e.g. nginx).
// Copy to ecosystem.config.js (not in git), fill in the values, then: pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [{
    name: 'songcontest',
    script: 'server.js',
    cwd: __dirname,
    env: {
      HOST: '127.0.0.1',
      PORT: 3010,
      NO_OPEN: '1',
      TRUST_PROXY: '1',
      PHONE_CONTROLLERS: '1',
      // Not a secret: Spotify sends the Client ID in every login URL (PKCE flow, no client secret).
      SPOTIFY_CLIENT_ID: '<your Spotify app Client ID>',
    },
    max_memory_restart: '200M',
    // One chronological file for stdout and stderr.
    out_file: '/var/log/songcontest.log',
    error_file: '/var/log/songcontest.log',
  }],
};
