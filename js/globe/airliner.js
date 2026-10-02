// A procedurally built twin-jet airliner (original model).
// Local frame: nose toward +Y, right wing toward +X, up = +Z. Length 2 units.
import * as THREE from "../../vendor/three.core-0.185.1.min.js";

function extrude(points, depth, z = 0) {
  const s = new THREE.Shape();
  points.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: depth * 0.35, bevelSize: depth * 0.35, bevelSegments: 2, curveSegments: 4 });
  g.translate(0, 0, z - depth / 2);
  return g;
}

export function buildAirliner(accent = "#f4b15a") {
  const group = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: "#f4f6f9", roughness: 0.38, metalness: 0.08 });
  const grey = new THREE.MeshStandardMaterial({ color: "#c5ccd6", roughness: 0.5, metalness: 0.25 });
  const dark = new THREE.MeshStandardMaterial({ color: "#2a2f3a", roughness: 0.6, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: "#11161f", roughness: 0.15, metalness: 0.6 });
  const tail = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.45, metalness: 0.1 });

  // fuselage: a lathe profile (radius by station), nose round, tail cone tapering up
  const prof = [];
  const L = 2, R = 0.085;
  const stations = [
    [1.0, 0], [0.99, 0.03], [0.96, 0.055], [0.9, 0.075], [0.82, 0.084], [0.7, R],
    [-0.45, R], [-0.6, 0.078], [-0.75, 0.06], [-0.88, 0.04], [-0.97, 0.018], [-1.0, 0.004],
  ];
  for (const [y, r] of stations) prof.push(new THREE.Vector2(r, y));
  const fus = new THREE.LatheGeometry(prof.reverse(), 28);
  const body = new THREE.Mesh(fus, white);
  body.scale.set(1, 1, 1.08);                       // slightly taller than wide
  group.add(body);

  // cockpit windscreen
  const ws = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), glass);
  ws.rotation.x = Math.PI / 2 - 0.5;
  ws.position.set(0, 0.86, 0.04);
  ws.scale.set(1.2, 0.8, 0.6);
  group.add(ws);

  // wings: swept, low-mounted, with a little dihedral
  const wingPts = [[0.07, 0.24], [0.95, -0.30], [0.97, -0.37], [0.9, -0.38], [0.07, -0.16]];
  for (const side of [1, -1]) {
    const pts = wingPts.map(([x, y]) => [x * side, y]);
    const w = new THREE.Mesh(extrude(pts, 0.022, -0.035), grey);
    w.rotation.y = side * 0.06;
    group.add(w);
    // winglet: drawn in XY, stood up so its height runs along +Z
    const wlGeo = extrude([[0, 0], [0.05, 0], [0.025, 0.13], [0.005, 0.13]], 0.012);
    wlGeo.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1));
    const wl = new THREE.Mesh(wlGeo, grey);
    wl.position.set(0.95 * side - (side < 0 ? 0.05 : 0), -0.38, -0.02);
    wl.rotation.y = side * -0.25;
    group.add(wl);
    // engine nacelle hanging under the wing
    const nac = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.038, 0.3, 20), white);
    nac.position.set(0.33 * side, 0.1, -0.085);
    group.add(nac);
    const inlet = new THREE.Mesh(new THREE.CircleGeometry(0.036, 20), dark);
    inlet.rotation.x = -Math.PI / 2;
    inlet.position.set(0.33 * side, 0.251, -0.085);
    group.add(inlet);
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.16, 0.05), grey);
    pylon.position.set(0.33 * side, 0.02, -0.05);
    group.add(pylon);
    // horizontal stabiliser
    const st = new THREE.Mesh(extrude([[0.03, -0.62], [0.36, -0.84], [0.36, -0.9], [0.03, -0.8]].map(([x, y]) => [x * side, y]), 0.014, 0.02), grey);
    group.add(st);
  }

  // vertical fin: drawn as (station, height), mapped so station → Y, height → Z, thickness → X
  const finGeo = extrude([[-0.56, 0], [-0.86, 0.36], [-0.97, 0.37], [-0.98, 0]], 0.014);
  finGeo.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
  const fin = new THREE.Mesh(finGeo, tail);
  fin.position.z = 0.06;
  group.add(fin);

  for (const m of group.children) { m.castShadow = false; m.receiveShadow = false; }
  return group;
}
