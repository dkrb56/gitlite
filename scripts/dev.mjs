// Dev runner: compile main/preload, start Vite, launch Electron against the dev server.
import { createServer } from 'vite';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

execSync('npx tsc -p tsconfig.main.json', { stdio: 'inherit' });

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`[dev] vite at ${url}`);

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on('exit', async () => {
  await server.close();
  process.exit(0);
});
