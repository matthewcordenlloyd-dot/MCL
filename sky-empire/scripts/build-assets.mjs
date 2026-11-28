// Runs every Blender generator script headless and exports .glb files into /public/models.
// Usage: npm run assets            (all)
//        npm run assets -- a320neo (one, by script suffix)
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

const candidates = [
  process.env.BLENDER,
  'C:/Program Files/Blender Foundation/Blender 5.3/blender.exe',
  '/Applications/Blender.app/Contents/MacOS/Blender',
  'blender',
].filter(Boolean);
const blender = candidates.find((p) => p === 'blender' || existsSync(p));

const only = process.argv.slice(2);
const scripts = readdirSync('blender')
  .filter((f) => /^build_.*\.py$/.test(f))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)));

for (const s of scripts) {
  console.log(`\n=== ${s} ===`);
  const t = Date.now();
  const r = spawnSync(blender, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', `blender/${s}`], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`FAILED: ${s}`); process.exit(1); }
  console.log(`done in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
