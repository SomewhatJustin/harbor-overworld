import {
  ground,
  inWorld,
  SPAWN,
  stationPenetration,
  STATION_TOP,
  STATIONS,
  WATER,
  type Obstacle,
} from './terrain.ts';

export type View = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
};
export const EYE_HEIGHT = 1.64;
export const WALK_SPEED = 4.7;
export const MAX_PITCH = 1.31;
const GRAVITY = 33;
const JUMP_SPEED = 8.2;
const ASCENT_SPEED = 11;

type MovementInput = {
  forward: number;
  sideways: number;
  turn?: number;
  look?: number;
  ascend?: boolean;
  sprint?: boolean;
  king?: boolean;
};
export type CollisionScene = {
  obstacles: readonly Obstacle[];
  stationCount: number;
};

export function createPlayerMovement(initialView = spawnView()) {
  const view = { ...initialView };
  let floor = view.y - EYE_HEIGHT;
  let airborne:
    | { height: number; startedAt: number; speed: number }
    | undefined;

  function jumpHeight(time: number) {
    if (!airborne) return floor;
    const { height, startedAt, speed } = airborne;
    const seconds = Math.max(0, (time - startedAt) / 1000);
    return Math.min(
      80 - EYE_HEIGHT,
      height + speed * seconds - (GRAVITY * seconds ** 2) / 2,
    );
  }

  function look(yaw: number, pitch: number) {
    view.yaw += yaw;
    view.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, view.pitch + pitch));
  }

  return {
    view: view as Readonly<View>,
    reset(spawn: View) {
      Object.assign(view, spawn);
      floor = spawn.y - EYE_HEIGHT;
      airborne = undefined;
    },
    look,
    jump(time: number, king: boolean) {
      if (!king && airborne) return;
      airborne = {
        height: Math.max(floor, jumpHeight(time)),
        startedAt: time,
        speed: king ? JUMP_SPEED * Math.SQRT2 : JUMP_SPEED,
      };
    },
    step(
      time: number,
      dt: number,
      input: MovementInput | undefined,
      scene: CollisionScene,
    ) {
      const previousFeet = view.y - EYE_HEIGHT;
      const rising = input?.ascend === true;
      const jumpFeet = rising
        ? Math.min(80 - EYE_HEIGHT, previousFeet + ASCENT_SPEED * dt)
        : airborne
          ? jumpHeight(time)
          : undefined;
      let feet = jumpFeet;
      if (input) {
        look((input.turn ?? 0) * dt * 1.6, (input.look ?? 0) * dt);
        const contact = walk(
          view,
          input,
          dt,
          scene.obstacles,
          scene.stationCount,
          jumpFeet,
          airborne || rising ? previousFeet : floor,
        );
        feet = contact.feet;
        if (!airborne && !rising && floor - contact.floor > 1) {
          feet = view.y - EYE_HEIGHT;
          airborne = { height: feet, startedAt: time, speed: 0 };
        }
        floor = contact.floor;
      }
      if (rising && feet !== undefined) {
        const height = Math.max(floor, feet);
        view.y = height + EYE_HEIGHT;
        airborne = { height, startedAt: time, speed: 0 };
      } else if (airborne && feet !== undefined) {
        view.y = Math.max(floor, feet) + EYE_HEIGHT;
        if (time > airborne.startedAt && feet <= floor) airborne = undefined;
        else if (jumpFeet !== undefined && feet < jumpFeet)
          airborne = { height: feet, startedAt: time, speed: 0 };
      } else {
        view.y += (floor + EYE_HEIGHT - view.y) * Math.min(1, dt * 11);
      }
    },
  };
}

export function spawnView(slot = 0): View {
  const rows = [SPAWN.z, 14.2, 20.7, 11.5, 23.7, 26.7, 29.1, 32.3];
  const x = SPAWN.x + [0, -1.8, 1.8, -3.6][Math.floor(slot / rows.length)];
  const z = rows[slot % rows.length];
  return { x, y: ground(x, z) + EYE_HEIGHT, z, yaw: 0.075, pitch: -0.075 };
}

export const RESPAWN_RADIUS = 3.5;

/** A random spot on open ground within RESPAWN_RADIUS of harbor spawn. */
export function respawnView(random = Math.random): View {
  const angle = random() * 2 * Math.PI;
  const distance = RESPAWN_RADIUS * Math.sqrt(random());
  const x = SPAWN.x + Math.sin(angle) * distance;
  const z = SPAWN.z + Math.cos(angle) * distance;
  return { x, y: ground(x, z) + EYE_HEIGHT, z, yaw: 0.075, pitch: -0.075 };
}

const FOOTPRINT = [
  [0.18, 0],
  [-0.18, 0],
  [0, 0.18],
  [0, -0.18],
] as const;

function obstaclePenetration(obstacle: Obstacle, x: number, z: number) {
  const dx = Math.abs(x - obstacle.x);
  const dz = Math.abs(z - obstacle.z);
  return 'radius' in obstacle
    ? obstacle.radius + 0.17 - Math.hypot(dx, dz)
    : Math.min(obstacle.halfWidth + 0.17 - dx, obstacle.halfDepth + 0.17 - dz);
}

function walk(
  view: View,
  { forward, sideways, sprint, king }: MovementInput,
  dt: number,
  obstacles: readonly Obstacle[],
  stations: number,
  airborneFeet: number | undefined,
  previousFeet: number,
) {
  function* obstaclesAt(x: number, z: number) {
    for (const obstacle of obstacles) {
      const depth = obstaclePenetration(obstacle, x, z);
      if (depth > 0) {
        yield {
          bottom: obstacle.bottom,
          top: obstacle.top,
          depth,
          currentDepth: obstaclePenetration(obstacle, view.x, view.z),
        };
      }
    }
    for (let i = 0; i < stations; i++) {
      const station = STATIONS[i];
      const depth = stationPenetration(station, x, z);
      if (depth > 0) {
        const bottom = ground(station[0], station[1]);
        yield {
          bottom,
          top: bottom + STATION_TOP,
          depth,
          currentDepth: stationPenetration(station, view.x, view.z),
        };
      }
    }
  }

  const bodyHeight = EYE_HEIGHT;
  const previousHead = previousFeet + bodyHeight;
  let feet = airborneFeet ?? previousFeet;
  if (feet > previousFeet) {
    for (const { bottom } of obstaclesAt(view.x, view.z)) {
      if (bottom >= previousHead - 1e-6)
        feet = Math.min(feet, Math.max(previousFeet, bottom - bodyHeight));
    }
  }

  function clear(x: number, z: number) {
    if (!inWorld(x, z)) return false;
    const current = ground(view.x, view.z);
    const next = ground(x, z);
    const terrainLimit =
      airborneFeet === undefined ? Math.max(current, feet, WATER) + 1 : feet;
    if (next > terrainLimit) return false;
    for (const [ox, oz] of FOOTPRINT) {
      const edge = ground(x + ox, z + oz);
      if (edge > terrainLimit && edge > ground(view.x + ox, view.z + oz))
        return false;
    }
    const nextFeet = airborneFeet === undefined ? Math.max(feet, next) : feet;
    for (const { bottom, top, depth, currentDepth } of obstaclesAt(x, z)) {
      const overlaps =
        nextFeet < top - 1e-6 && nextFeet + bodyHeight > bottom + 1e-6;
      const canEscape =
        currentDepth >= depth - 1e-6 &&
        currentDepth > 0 &&
        feet < top - 1e-6 &&
        feet + bodyHeight > bottom + 1e-6;
      if (overlaps && !canEscape) return false;
    }
    return true;
  }

  if (forward || sideways) {
    const speed =
      (WALK_SPEED * dt) / Math.max(1, Math.hypot(forward, sideways));
    const dx =
      (Math.sin(view.yaw) * forward + Math.cos(view.yaw) * sideways) * speed;
    const dz =
      (-Math.cos(view.yaw) * forward + Math.sin(view.yaw) * sideways) * speed;
    // Check each sprint increment at walking speed to avoid skipping obstacles.
    const steps = sprint ? (king ? 8 : 2) : 1;
    for (let step = 0; step < steps; step++) {
      if (dx && clear(view.x + dx, view.z)) view.x += dx;
      if (dz && clear(view.x, view.z + dz)) view.z += dz;
    }
  }
  let floor = Math.max(WATER - 0.5, ground(view.x, view.z));
  for (const { top } of obstaclesAt(view.x, view.z)) {
    if (top <= Math.max(previousFeet, feet) + 1e-6)
      floor = Math.max(floor, top);
  }
  return { floor, feet };
}
