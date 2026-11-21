import { WALK_SPEED } from './movement.ts';
import type { Pose } from './presence-protocol.ts';
import { type Color, ground, inWorld, Mesh, WATER } from './terrain.ts';

export const LAND_SHARK_SPEED = WALK_SPEED * 1.5;
const OCEAN_START = { x: 18.5, z: 29.5 };
const OCEAN_PATROL = [{ x: 7.5, z: 25.5 }, { x: 20.5, z: 39.5 }, OCEAN_START];
const SCREAM_SECONDS = 0.9;
const CONTACT_RADIUS = 1.15;
const SWIM_HEIGHT = WATER - 0.92;
const SWIM_TURNS = [
  0,
  Math.PI / 4,
  -Math.PI / 4,
  Math.PI / 2,
  -Math.PI / 2,
  Math.PI,
];

export type SharkPose = Pose & {
  walking: boolean;
  inWater: boolean;
  dying: boolean;
};
type Swimmer = { id: number; x: number; y: number; z: number };

function inWater(player: Swimmer) {
  return ground(player.x, player.z) < WATER && player.y <= WATER + 0.15;
}

function swimStep(pose: SharkPose, yaw: number, distance: number) {
  for (const turn of SWIM_TURNS) {
    const course = yaw + turn;
    const dx = Math.sin(course) * distance;
    const dz = -Math.cos(course) * distance;
    const x = pose.x + dx;
    const z = pose.z + dz;
    if (
      inWorld(x, z) &&
      ground(x, z) < WATER &&
      ground(pose.x + dx / 2, pose.z + dz / 2) < WATER
    ) {
      return { x, z, yaw: Math.atan2(Math.sin(course), Math.cos(course)) };
    }
  }
  return pose;
}

function spawnShark(): SharkPose {
  return {
    ...OCEAN_START,
    y: SWIM_HEIGHT,
    yaw: -Math.PI / 2,
    walking: false,
    inWater: true,
    dying: false,
  };
}

/** The shark never leaves the sea: it patrols offshore and chases swimmers. */
export function createLandShark() {
  let pose = spawnShark();
  let patrolPoint = 0;
  let respawnDelay = 0;

  return {
    get pose() {
      return pose;
    },
    shoot() {
      if (pose.dying) return false;
      respawnDelay = SCREAM_SECONDS;
      pose = { ...pose, dying: true };
      return true;
    },
    step(seconds: number, players: readonly Swimmer[]) {
      if (pose.dying) {
        respawnDelay -= seconds;
        if (respawnDelay <= 1e-6) {
          pose = spawnShark();
          patrolPoint = 0;
        }
        return [];
      }

      const patrol = OCEAN_PATROL[patrolPoint];
      let target: { x: number; z: number } = patrol;
      let nearest = Infinity;
      for (const player of players) {
        if (!inWater(player)) continue;
        const distance = Math.hypot(player.x - pose.x, player.z - pose.z);
        if (distance < nearest) {
          target = player;
          nearest = distance;
        }
      }

      const dx = target.x - pose.x;
      const dz = target.z - pose.z;
      const distance = Math.hypot(dx, dz);
      const stride = Math.min(distance, LAND_SHARK_SPEED * seconds);
      const yaw = distance > 0.01 ? Math.atan2(dx, -dz) : pose.yaw;
      const { x, z, yaw: heading } = swimStep(pose, yaw, stride);
      pose = {
        x,
        z,
        yaw: heading,
        y: SWIM_HEIGHT,
        walking: false,
        inWater: true,
        dying: false,
      };
      if (target === patrol && distance <= stride)
        patrolPoint = (patrolPoint + 1) % OCEAN_PATROL.length;
      return players
        .filter(
          (player) =>
            inWater(player) &&
            Math.hypot(player.x - pose.x, player.z - pose.z) <= CONTACT_RADIUS,
        )
        .map((player) => player.id);
    },
  };
}

export function landSharkMesh() {
  const mesh = new Mesh();
  const legs = new Mesh();
  const slate: Color = [0.265, 0.43, 0.49];
  const fin: Color = [0.19, 0.33, 0.4];
  const belly: Color = [0.74, 0.79, 0.72];
  const ink: Color = [0.08, 0.13, 0.16];
  for (const [index, x] of [-0.37, 0.1].entries()) {
    const limb = 4 + index;
    legs.box(x, 0.1, -0.04, 0.27, 0.53, 0.28, slate, limb);
    legs.box(x - 0.025, 0, -0.24, 0.32, 0.16, 0.55, fin, limb);
  }

  mesh.box(-0.47, 0.56, -0.62, 0.94, 0.33, 1.25, belly);
  mesh.box(-0.52, 0.8, -0.71, 1.04, 0.64, 1.45, slate);
  mesh.box(-0.44, 1.16, -1.1, 0.88, 0.39, 0.68, slate);
  mesh.box(-0.33, 1.25, -1.37, 0.66, 0.25, 0.34, slate);
  mesh.box(-0.39, 0.96, -1.17, 0.78, 0.17, 0.59, belly);
  mesh.box(-0.38, 1.08, -1.18, 0.76, 0.09, 0.6, ink);
  for (const x of [-0.41, 0.33]) {
    mesh.box(x, 1.1, -1.16, 0.08, 0.1, 0.07, belly);
    mesh.box(x, 1.1, -0.99, 0.08, 0.1, 0.07, belly);
  }
  for (const x of [-0.454, 0.438]) {
    mesh.box(x, 1.33, -0.95, 0.016, 0.115, 0.16, ink);
    mesh.box(
      x + (x < 0 ? -0.006 : 0.014),
      1.38,
      -0.937,
      0.008,
      0.047,
      0.048,
      belly,
    );
  }

  mesh.box(-0.15, 1.39, -0.05, 0.3, 0.24, 0.61, fin);
  mesh.box(-0.12, 1.63, 0.11, 0.24, 0.23, 0.39, fin);
  mesh.box(-0.085, 1.86, 0.25, 0.17, 0.25, 0.22, fin);
  mesh.box(-0.105, 2.11, 0.34, 0.21, 0.11, 0.11, fin);
  for (const x of [-0.85, 0.39]) {
    mesh.box(x, 0.82, 0.08, 0.46, 0.16, 0.43, fin);
  }
  mesh.box(-0.25, 0.79, 0.63, 0.5, 0.44, 0.53, slate);
  mesh.box(-0.14, 0.91, 1.12, 0.28, 0.22, 0.43, slate);
  mesh.box(-0.09, 0.72, 1.43, 0.18, 0.83, 0.23, fin);
  mesh.box(-0.085, 1.38, 1.56, 0.17, 0.32, 0.19, fin);
  return {
    body: new Float32Array(mesh.vertices),
    legs: new Float32Array(legs.vertices),
  };
}
