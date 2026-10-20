import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// npm occasionally extracts node-pty's prebuilt spawn-helper without the
// executable bit. Without it, PTY creation fails with "posix_spawnp failed".
// Fixing it here keeps `npm install` enough to run the terminal on macOS/Linux.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const prebuilt = path.join(root, 'node_modules', 'node-pty', 'prebuilds');

if (!fs.existsSync(prebuilt)) {
  process.exit(0);
}

let fixed = 0;
for (const entry of fs.readdirSync(prebuilt, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const helper = path.join(prebuilt, entry.name, 'spawn-helper');
  if (!fs.existsSync(helper)) continue;
  try {
    fs.chmodSync(helper, 0o755);
    fixed += 1;
  } catch (error) {
    console.warn(`[codepair] could not chmod ${helper}:`, error.message);
  }
}

if (fixed > 0) {
  console.log(`[codepair] made ${fixed} node-pty spawn-helper binary(ies) executable`);
}
