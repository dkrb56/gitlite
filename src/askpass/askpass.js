// Runs as GIT_ASKPASS / SSH_ASKPASS (through askpass.sh): asks the GitLite window for the answer
// over a local HTTP call and prints it for git. Plain Node, no dependencies.
'use strict';
const http = require('http');

const prompt = process.argv.slice(2).join(' ');
const port = Number(process.env.GITLITE_ASKPASS_PORT);
const token = process.env.GITLITE_ASKPASS_TOKEN;
if (!port || !token) process.exit(1);

const body = JSON.stringify({ prompt });
const req = http.request(
  {
    host: '127.0.0.1',
    port,
    path: '/askpass',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gitlite-token': token, 'content-length': Buffer.byteLength(body) },
  },
  (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      if (res.statusCode !== 200) process.exit(1);
      let value = null;
      try {
        value = JSON.parse(data).value;
      } catch {
        process.exit(1);
      }
      if (value === null || value === undefined) process.exit(1); // cancelled: git reports the failure
      process.stdout.write(String(value) + '\n');
      process.exit(0);
    });
  },
);
req.setTimeout(10 * 60 * 1000, () => process.exit(1));
req.on('error', () => process.exit(1));
req.end(body);
