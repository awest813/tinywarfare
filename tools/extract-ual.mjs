// ============================================================================
// TINY WARFARE — tools/extract-ual.mjs
//
// Trims Quaternius' Universal Animation Library (Standard / free edition, CC0)
// down to the skeleton and the clips the soldiers use, so the repository
// vendors ~0.3 MB instead of the 4 MB pack:
//
//   git clone https://github.com/J-Ponzo/gltf-universal-animation-library ual
//   node tools/extract-ual.mjs ual/glTF/AnimationLibrary_Godot_Standard.gltf
//     -> assets/models/source/ual_clips.glb
//
// The output keeps every node of the rig (so world-space sampling sees the
// same hierarchy) but no mesh, skin or material, and drops each animation
// channel whose keys never leave the node's rest value — lossless, since an
// unanimated node simply holds its rest. tools/build-operatives.mjs retargets
// the result onto the Marine.
// ============================================================================

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const KEEP = [
  'A_TPose',
  'Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop',
  'Crouch_Idle_Loop', 'Crouch_Fwd_Loop',
  'Jump_Start', 'Jump_Loop', 'Jump_Land', 'Roll',
  'Hit_Chest', 'Hit_Head', 'Death01',
];
const OUT = new URL('../assets/models/source/ual_clips.glb', import.meta.url);

const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/extract-ual.mjs <AnimationLibrary_Godot_Standard.gltf>');
  process.exit(1);
}
const json = JSON.parse(await readFile(src, 'utf8'));
const bin = await readFile(join(dirname(src), json.buffers[0].uri));

const COMPONENTS = { SCALAR: 1, VEC3: 3, VEC4: 4 };
function readAccessor(index) {
  const acc = json.accessors[index];
  if (acc.componentType !== 5126) throw new Error('expected float accessor ' + index);
  const view = json.bufferViews[acc.bufferView];
  const n = COMPONENTS[acc.type];
  const stride = view.byteStride || n * 4;
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const out = new Float32Array(acc.count * n);
  for (let i = 0; i < acc.count; i++) {
    for (let k = 0; k < n; k++) out[i * n + k] = bin.readFloatLE(base + i * stride + k * 4);
  }
  return { data: out, type: acc.type, count: acc.count };
}

const REST = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
function isConstantAtRest(values, node, path) {
  const rest = node[path] || REST[path];
  const n = rest.length;
  for (let i = 0; i < values.length; i += n) {
    let same = true;
    for (let k = 0; k < n; k++) if (Math.abs(values[i + k] - rest[k]) > 1e-4) same = false;
    // q and -q are the same rotation
    if (!same && path === 'rotation') {
      same = true;
      for (let k = 0; k < n; k++) if (Math.abs(values[i + k] + rest[k]) > 1e-4) same = false;
    }
    if (!same) return false;
  }
  return true;
}

const out = { asset: { version: '2.0', generator: 'tools/extract-ual.mjs (Quaternius UAL, CC0)' },
  scene: 0, scenes: json.scenes, nodes: [], accessors: [], bufferViews: [], animations: [], buffers: [] };
out.nodes = json.nodes.map((n) => {
  const copy = { name: n.name };
  for (const k of ['translation', 'rotation', 'scale', 'children']) if (n[k]) copy[k] = n[k];
  return copy;
});

const chunks = [];
let offset = 0;
function addAccessor(data, type, count, minMax) {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  chunks.push(buf);
  out.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length });
  offset += buf.length; // floats keep 4-byte alignment
  out.accessors.push({ bufferView: out.bufferViews.length - 1, componentType: 5126, count, type, ...minMax });
  return out.accessors.length - 1;
}

for (const name of KEEP) {
  const anim = json.animations.find((a) => a.name === name);
  if (!anim) throw new Error('clip missing: ' + name);
  const inputs = new Map();
  const samplers = [];
  const channels = [];
  for (const ch of anim.channels) {
    const sampler = anim.samplers[ch.sampler];
    const node = json.nodes[ch.target.node];
    const values = readAccessor(sampler.output);
    if (isConstantAtRest(values.data, node, ch.target.path)) continue;
    if (!inputs.has(sampler.input)) {
      const t = readAccessor(sampler.input);
      inputs.set(sampler.input, addAccessor(t.data, 'SCALAR', t.count, {
        min: [t.data[0]], max: [t.data[t.count - 1]],
      }));
    }
    samplers.push({
      input: inputs.get(sampler.input),
      output: addAccessor(values.data, values.type, values.count),
      interpolation: sampler.interpolation || 'LINEAR',
    });
    channels.push({ sampler: samplers.length - 1, target: ch.target });
  }
  out.animations.push({ name, samplers, channels });
}

const body = Buffer.concat(chunks);
out.buffers.push({ byteLength: body.length });
let jsonBuf = Buffer.from(JSON.stringify(out), 'utf8');
if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + body.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(body.length, 0); bh.writeUInt32LE(0x004e4942, 4);
const glb = Buffer.concat([header, jh, jsonBuf, bh, body]);
await writeFile(OUT, glb);
console.log(`ual_clips.glb: ${(glb.length / 1024).toFixed(0)} KB, ${out.animations.length} clips`);
