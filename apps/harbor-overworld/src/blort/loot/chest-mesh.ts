// Chest art, built from boxes like everything else in the world. The body
// and lid are separate meshes: the lid's origin is its hinge, so the renderer
// opens it by pitching it about that point.

import { type Color, Mesh } from '../../world/terrain.ts';

const WIDTH = 0.9;
const DEPTH = 0.62;
const BODY_HEIGHT = 0.5;
const LID_HEIGHT = 0.2;
const WALL = 0.06;

/** Where the lid's hinge sits in the body's frame: top of the back wall. */
export const CHEST_HINGE = { y: BODY_HEIGHT, z: DEPTH / 2 };
/** How far the lid swings back when fully open, in radians. */
export const CHEST_OPEN_ANGLE = 1.9;

const oak: Color = [0.56, 0.37, 0.19];
const oakLight: Color = [0.66, 0.45, 0.24];
const seam: Color = [0.36, 0.23, 0.12];
const hollow: Color = [0.17, 0.11, 0.06];
const iron: Color = [0.24, 0.24, 0.25];
const brass: Color = [0.95, 0.73, 0.28];

/** The box, open at the top, front facing -z, sitting on y = 0. */
export function chestBodyMesh() {
  const mesh = new Mesh();
  const x = -WIDTH / 2;
  const z = -DEPTH / 2;
  // Floor and four walls, so the inside reads as hollow when the lid is up.
  mesh.box(x, 0, z, WIDTH, WALL, DEPTH, oak);
  mesh.box(
    x + WALL,
    WALL,
    z + WALL,
    WIDTH - 2 * WALL,
    0.004,
    DEPTH - 2 * WALL,
    hollow,
  );
  mesh.box(x, 0, z, WIDTH, BODY_HEIGHT, WALL, oak);
  mesh.box(x, 0, -z - WALL, WIDTH, BODY_HEIGHT, WALL, oak);
  mesh.box(x, 0, z, WALL, BODY_HEIGHT, DEPTH, oak);
  mesh.box(-x - WALL, 0, z, WALL, BODY_HEIGHT, DEPTH, oak);
  // Plank seams on every outside face.
  for (const y of [0.16, 0.32]) {
    mesh.box(x, y, z - 0.004, WIDTH, 0.02, 0.006, seam);
    mesh.box(x, y, -z - 0.002, WIDTH, 0.02, 0.006, seam);
    mesh.box(x - 0.004, y, z, 0.006, 0.02, DEPTH, seam);
    mesh.box(-x - 0.002, y, z, 0.006, 0.02, DEPTH, seam);
  }
  // A lighter plank across the front.
  mesh.box(x + 0.08, 0.18, z - 0.006, WIDTH - 0.16, 0.13, 0.004, oakLight);
  // Iron corner posts and a rim band under the lid.
  for (const cx of [x - 0.012, -x - 0.058]) {
    for (const cz of [z - 0.012, -z - 0.058]) {
      mesh.box(cx, 0, cz, 0.07, BODY_HEIGHT, 0.07, iron);
    }
  }
  mesh.box(
    x - 0.01,
    BODY_HEIGHT - 0.05,
    z - 0.01,
    WIDTH + 0.02,
    0.05,
    0.012,
    iron,
  );
  // The lower half of the clasp, on the front.
  mesh.box(-0.06, BODY_HEIGHT - 0.12, z - 0.02, 0.12, 0.1, 0.02, brass);
  return new Float32Array(mesh.vertices);
}

/** The lid with its hinge at the origin; it extends forward along -z. */
export function chestLidMesh() {
  const mesh = new Mesh();
  const x = -WIDTH / 2 - 0.01;
  const w = WIDTH + 0.02;
  const d = DEPTH + 0.02;
  mesh.box(x, 0, -d, w, LID_HEIGHT, d, oak);
  mesh.box(
    x + 0.08,
    LID_HEIGHT,
    -d + 0.08,
    w - 0.16,
    0.004,
    d - 0.16,
    oakLight,
  );
  // Iron bands over the top, front to back.
  for (const bx of [x + 0.1, -x - 0.16]) {
    mesh.box(bx, -0.004, -d - 0.008, 0.06, LID_HEIGHT + 0.012, d + 0.012, iron);
  }
  // Rim around the bottom edge.
  mesh.box(x - 0.006, 0, -d - 0.006, w + 0.012, 0.04, d + 0.012, iron);
  // The clasp: a plate hanging off the front with a keyhole.
  mesh.box(-0.07, -0.1, -d - 0.022, 0.14, 0.2, 0.022, brass);
  mesh.box(-0.015, -0.06, -d - 0.026, 0.03, 0.06, 0.004, hollow);
  return new Float32Array(mesh.vertices);
}
