// generate app bone data: id, fma name -> display name, region, group
// display rules: "Left femur" -> "Femur (L)", "Eighth thoracic vertebra" -> "T8 Vertebra", etc.
import fs from 'node:fs';
const bones = JSON.parse(fs.readFileSync('manifest_bones.json', 'utf8'));

const ordinal = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };

function pretty(name) {
  let n = name;
  let side = '';
  let lm = n.match(/^(Left|Right) (.+)$/);
  if (lm) { side = lm[1] === 'Left' ? 'L' : 'R'; n = lm[2]; }
  // thoracic/cervical/lumbar vertebrae
  let vm = n.match(/^([A-Za-z]+) (cervical|thoracic|lumbar) vertebra$/);
  if (vm) {
    const num = ordinal[vm[1].toLowerCase()];
    if (num) n = `${vm[2][0].toUpperCase()}${num} Vertebra`;
  }
  // ribs
  let rm = n.match(/^([A-Za-z]+) rib$/);
  if (rm && ordinal[rm[1]]) n = `Rib ${ordinal[rm[1]]}`;
  // fingers/toes phalanges
  n = n.replace('phalanx of ', 'phalanx, ');
  // metacarpals/metatarsals
  let mm = n.match(/^([A-Za-z]+) metacarpal bone$/);
  if (mm && ordinal[mm[1]]) n = `Metacarpal ${ordinal[mm[1]]}`;
  let mtm = n.match(/^([A-Za-z]+) metatarsal bone$/);
  if (mtm && ordinal[mtm[1]]) n = `Metatarsal ${ordinal[mtm[1]]}`;
  n = n.replace('Navicular bone of left foot', 'Navicular').replace('Navicular bone of right foot', 'Navicular');
  if (side) n = `${n} (${side})`;
  n = n.split(' ').map(w => w.length > 2 || /\d/.test(w) ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
  // fix all-caps artifacts
  n = n.replace(/\bOf\b/g, 'of');
  return n;
}

const REGION_LABEL = { skull: 'Skull', spine: 'Spine', thorax: 'Ribcage & Sternum', shoulder: 'Shoulder Girdle', arm: 'Arm', hand: 'Hand', pelvis: 'Pelvis', leg: 'Leg', foot: 'Foot' };

// enrich with subregion grouping for list UI
function subregion(b) {
  const n = b.name;
  if (b.region === 'skull') {
    if (/Mandible|Hyoid/.test(n)) return 'Jaw & Throat';
    if (/Maxilla|Vomer|Nasal|Concha|Lacrimal|Ethmoid/.test(n)) return 'Facial Bones';
    return 'Cranial Bones';
  }
  if (b.region === 'spine') {
    if (/cervical/.test(n)) return 'Cervical (Neck)';
    if (/thoracic/.test(n)) return 'Thoracic (Chest)';
    if (/lumbar/.test(n)) return 'Lumbar (Lower Back)';
    if (/Atlas|Axis/.test(n)) return 'Cervical (Neck)';
    if (/Sacrum/.test(n)) return 'Sacrum';
    return 'Spine';
  }
  if (b.region === 'thorax') {
    if (/rib/i.test(n)) return 'Ribs';
    return 'Sternum';
  }
  if (b.region === 'hand') {
    if (/carpal|scaphoid|lunate|triquetral|pisiform|trapezium|trapezoid|capitate|hamate/i.test(n) && !/metacarpal|phalanx/i.test(n)) return 'Carpals (Wrist)';
    if (/metacarpal/i.test(n)) return 'Metacarpals';
    if (/phalanx/i.test(n)) return 'Phalanges (Fingers)';
    return 'Hand';
  }
  if (b.region === 'foot') {
    if (/calcaneus|talus|navicular|cuboid|cuneiform/i.test(n)) return 'Tarsals (Ankle)';
    if (/metatarsal/i.test(n)) return 'Metatarsals';
    if (/phalanx/i.test(n)) return 'Phalanges (Toes)';
    return 'Foot';
  }
  return REGION_LABEL[b.region];
}

const out = bones.map(b => ({
  id: b.id,
  fma: b.name,
  label: pretty(b.name),
  region: b.region,
  regionLabel: REGION_LABEL[b.region],
  group: subregion(b),
}));

fs.writeFileSync('../app/public/bones.json', JSON.stringify(out));
console.log('bones.json written,', out.length, 'bones');
console.log(out.slice(0, 3), out.slice(30, 33));
