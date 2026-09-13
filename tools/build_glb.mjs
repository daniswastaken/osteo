// Build skeleton.glb from BodyParts3D STLs (BodyParts3D/Anatomography, CC BY-SA 2.1 JP)
// - parses tools/stls/*.stl per manifest_bones.json
// - welds verts, simplifies via meshopt, quantizes, packs one GLB
// - one node per bone named fma{ID}, extras carry name+region
import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { weld, prune, dedup, normals } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const __dirname = process.cwd();
const MANIFEST = path.join(__dirname, 'manifest_bones.json');
const STL_DIR = path.join(__dirname, 'stls');
const OUT = process.argv[2] || path.join(__dirname, '..', 'app', 'public', 'skeleton.glb');

const bones = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

function parseSTL(buf) {
  if (buf.length < 84) throw new Error('bad stl');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const dv = new DataView(ab);
  const triCount = dv.getUint32(80, true);
  if (buf.length < 84 + triCount * 50) throw new Error('truncated stl');
  const positions = new Float32Array(triCount * 9);
  let p = 0;
  for (let t = 0; t < triCount; t++) {
    const off = 84 + t * 50 + 12;
    for (let v = 0; v < 3; v++) {
      const base = off + v * 12;
      positions[p++] = dv.getFloat32(base, true);
      positions[p++] = dv.getFloat32(base + 4, true);
      positions[p++] = dv.getFloat32(base + 8, true);
    }
  }
  const indices = new Uint32Array(triCount * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices, triCount };
}

const doc = new Document();
doc.createBuffer('bin');
const scene = doc.createScene('scene');
const boneMat = doc.createMaterial('bone')
  .setBaseColorFactor([0.93, 0.91, 0.85, 1])
  .setMetallicFactor(0.05)
  .setRoughnessFactor(0.85)
  .setDoubleSided(true);

for (const b of bones) {
  const file = path.join(STL_DIR, `FMA${b.id}.stl`);
  if (!fs.existsSync(file)) { console.error('missing', file); process.exit(1); }
  const { positions, indices } = parseSTL(fs.readFileSync(file));
  const posAcc = doc.createAccessor().setArray(positions).setType('VEC3');
  const idxAcc = doc.createAccessor().setArray(indices).setType('SCALAR');
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', posAcc)
    .setIndices(idxAcc)
    .setMaterial(boneMat);
  const mesh = doc.createMesh(`m_fma${b.id}`).addPrimitive(prim);
  const node = doc.createNode(`fma${b.id}`).setMesh(mesh).setExtras({ fma: b.id, name: b.name, region: b.region });
  scene.addChild(node);
}

await doc.transform(weld({ tolerance: 1e-4 }));

// ensure every prim is indexed (weld may leave non-indexed prims)
for (const mesh of doc.getRoot().listMeshes())
  for (const prim of mesh.listPrimitives())
    if (!prim.getIndices()) {
      const vc = prim.getAttribute('POSITION').getCount();
      const ia = doc.createAccessor().setArray(vc > 65535 ? new Uint32Array([...Array(vc).keys()]) : new Uint16Array([...Array(vc).keys()])).setType('SCALAR');
      prim.setIndices(ia);
    }

let totalVerts = 0;
for (const mesh of doc.getRoot().listMeshes())
  for (const prim of mesh.listPrimitives())
    totalVerts += prim.getAttribute('POSITION').getCount();

const TARGET_VERTS = 220000;
const globalRatio = Math.min(1, TARGET_VERTS / totalVerts);
console.log('welded verts:', totalVerts, '| ratio:', globalRatio.toFixed(3));

await MeshoptSimplifier.ready;
let outTris = 0;

function computeNormals(positions, indices) {
  const n = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const e1x = positions[b] - ax, e1y = positions[b + 1] - ay, e1z = positions[b + 2] - az;
    const e2x = positions[c] - ax, e2y = positions[c + 1] - ay, e2z = positions[c + 2] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const posAcc = prim.getAttribute('POSITION');
    const idxAcc = prim.getIndices();
    const vcount = posAcc.getCount();
    if (vcount < 100) {
      const positions = posAcc.getArray();
      const idxs = idxAcc.getArray();
      const nnAcc = doc.createAccessor().setArray(computeNormals(positions, idxs)).setType('VEC3');
      prim.setAttribute('NORMAL', nnAcc);
      outTris += idxs.length / 3;
      continue;
    }
    const positions = posAcc.getArray();
    let indices = idxAcc.getArray();
    const stride = 3; // floats per vertex
    const r = Math.max(0.01, Math.min(1, globalRatio * Math.pow(1500 / vcount, 0.35)));
    const targetIndexCount = Math.max(36, Math.floor(indices.length * r / 3) * 3);
    const [newIdx, err] = MeshoptSimplifier.simplify(indices, positions, stride, targetIndexCount, 0.001);
    if (newIdx && newIdx.length >= 36 && newIdx.length < indices.length) {
      // compact vertex array to referenced verts
      const maxIdx = newIdx.reduce((a, b) => b > a ? b : a, 0);
      const remap = new Uint32Array(vcount).fill(0xFFFFFFFF);
      let next = 0;
      for (let i = 0; i < newIdx.length; i++) {
        const v = newIdx[i];
        if (remap[v] === 0xFFFFFFFF) remap[v] = next++;
      }
      const newPos = new Float32Array(next * 3);
      for (let v = 0; v < vcount; v++) {
        const t = remap[v];
        if (t !== 0xFFFFFFFF) { newPos[t * 3] = positions[v * 3]; newPos[t * 3 + 1] = positions[v * 3 + 1]; newPos[t * 3 + 2] = positions[v * 3 + 2]; }
      }
      const compactIdx = new Uint32Array(newIdx.length);
      for (let i = 0; i < newIdx.length; i++) compactIdx[i] = remap[newIdx[i]];
      const npAcc = doc.createAccessor().setArray(newPos).setType('VEC3');
      const nnAcc = doc.createAccessor().setArray(computeNormals(newPos, compactIdx)).setType('VEC3');
      const niAcc = doc.createAccessor().setArray(compactIdx).setType('SCALAR');
      prim.setAttribute('POSITION', npAcc);
      prim.setAttribute('NORMAL', nnAcc);
      prim.setIndices(niAcc);
      posAcc.dispose();
      outTris += compactIdx.length / 3;
    } else {
      const positions = posAcc.getArray();
      const idxs = idxAcc.getArray();
      const nnAcc = doc.createAccessor().setArray(computeNormals(positions, idxs)).setType('VEC3');
      prim.setAttribute('NORMAL', nnAcc);
      outTris += indices.length / 3;
    }
    idxAcc.dispose();
  }
}

await doc.transform(prune(), dedup());
let outVerts = 0;
for (const mesh of doc.getRoot().listMeshes())
  for (const prim of mesh.listPrimitives())
    outVerts += prim.getAttribute('POSITION').getCount();

console.log('final:', outVerts, 'verts,', Math.round(outTris), 'tris');
const io = new NodeIO();
await io.write(OUT, doc);
console.log('wrote', OUT, (fs.statSync(OUT).size / 1048576).toFixed(2) + ' MB');
