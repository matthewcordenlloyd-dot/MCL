// Copies the Draco WASM decoder from three.js into /public/draco so models load offline.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
const src = 'node_modules/three/examples/jsm/libs/draco/gltf';
const dst = 'public/draco';
if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
