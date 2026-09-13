// verify GLB: parse JSON chunk directly, compute per-node bbox via accessor data
import fs from 'node:fs';
const buf = fs.readFileSync('../app/public/skeleton.glb');
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
console.log('nodes:', json.nodes.length, 'meshes:', json.meshes.length);
console.log('extensionsRequired:', json.extensionsRequired);
const binStart = 20 + jsonLen + 8;
const bin = buf.slice(binStart);
const acc = i => {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
  return { a, arr: bin.slice(off, off + a.count * 12) }; // assume float32 vec3
};
function nodeData(node) {
  const mesh = json.meshes[node.mesh];
  const prim = mesh.primitives[0];
  const pos = json.meshes[node.mesh].primitives[0].attributes.POSITION;
  const { a, arr } = acc(pos);
  const dv = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  const min = a.min, max = a.max;
  return { node, min, max, count: a.count, dv };
}
// NOTE: quantized positions - stored as normalized int16, need decode. min/max already decoded in accessor
let gMin = [1e9, 1e9, 1e9], gMax = [-1e9, -1e9, -1e9];
const cs = {};
for (const node of json.nodes) {
  if (node.mesh === undefined) continue;
  const m = json.meshes[node.mesh];
  for (const prim of m.primitives) {
    const a = json.accessors[prim.attributes.POSITION];
    // node.matrix may re-offset; check extras
    cs[node.name] = { min: a.min, max: a.max, ex: node.extras };
    for (let i = 0; i < 3; i++) {
      gMin[i] = Math.min(gMin[i], a.min[i]);
      gMax[i] = Math.max(gMax[i], a.max[i]);
    }
  }
}
console.log('global bbox min', gMin.map(v => v.toFixed(0)), 'max', gMax.map(v => v.toFixed(0)));
const show = k => { const v = cs[k]; if (v) console.log(k, 'min', v.min.map(x => x.toFixed(0)), 'max', v.max.map(x => x.toFixed(0)), v.ex); };
show('fma52734'); // frontal
show('fma24475'); // L femur
show('fma24498'); // L calcaneus
show('fma12519'); // atlas
show('fma7486');  // manubrium
show('fma16587'); // L hip
show('fma24487'); // L patella
