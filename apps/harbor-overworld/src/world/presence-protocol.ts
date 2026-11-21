import type { PlanePose } from './flight.ts';
import type { SharkPose } from './land-shark.ts';
import type { PostMark } from './post-marks.ts';
import type { RoomVehicles, VehicleReport } from './vehicles.ts';
import { MAX_PITCH } from './movement.ts';
import { inWorld, WATER } from './terrain.ts';

export const PRESENCE_PATH = '/presence';
export const PRESENCE_INTERVAL = 100;
export const ROOM_CAPACITY = 32;
export const OVERWORLD_APPLICATION = 'how.justin.harbor-overworld';
export const POST_LIFETIME_MS = 60_000;
export const CROWN_DURATION = 60_000;
export const SHOT_INTERVAL = 450;
export const HIT_LINES = [
  'Ouch that hurt',
  'my leg!',
  'ouch.',
  'oof',
  'you have shot me, my guy',
  'Wilhelm scream',
] as const;

export type Pose = {
  x: number;
  y: number;
  z: number;
  yaw: number;
};

export const KING_SCALES = [1, 2, 5, 10] as const;
export type KingScale = (typeof KING_SCALES)[number];
export const DEFAULT_KING_SCALE = 2;

export function readKingScale(value: unknown): KingScale {
  return KING_SCALES.find((scale) => scale === value) ?? DEFAULT_KING_SCALE;
}

export type Shoot = {
  type: 'shoot';
  yaw: number;
  pitch: number;
  kingScale: KingScale;
};
export type Respawn = {
  id: number;
  slot: number;
  spawnRevision: number;
  cause?: 'shark';
};
export type ShotPoint = readonly [number, number, number];
export type ShotPath = {
  start: ShotPoint;
  end: ShotPoint;
  impact: boolean;
  postMark?: PostMark;
};
export type Gunshot = {
  type: 'gunshot';
  shooter: number;
  sharkHit?: true;
  path: ShotPath;
  hit?: { id: number; line: number; respawn?: Respawn };
};

function isShotPoint(value: unknown): value is ShotPoint {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (coordinate) =>
        typeof coordinate === 'number' && Number.isFinite(coordinate),
    )
  );
}

export function isShotPath(value: unknown): value is ShotPath {
  if (!value || typeof value !== 'object') return false;
  const { start, end, impact } = value as Partial<ShotPath>;
  return isShotPoint(start) && isShotPoint(end) && typeof impact === 'boolean';
}

export function isShoot(value: unknown): value is Shoot {
  if (!value || typeof value !== 'object') return false;
  const { type, yaw, pitch, kingScale } = value as Partial<Shoot>;
  return (
    type === 'shoot' &&
    typeof yaw === 'number' &&
    Math.abs(yaw) <= Math.PI &&
    typeof pitch === 'number' &&
    Math.abs(pitch) <= MAX_PITCH &&
    KING_SCALES.some((scale) => scale === kingScale)
  );
}

export type ChatPost = { id: string; text: string };
export type NamedPose = Pose & {
  name?: string;
  chat?: ChatPost;
  kingScale?: KingScale;
};

export function readChat(value: unknown): ChatPost | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('id' in value) ||
    !('text' in value)
  )
    return undefined;
  const { id, text } = value;
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{2,400}$/.test(id) ||
    typeof text !== 'string'
  )
    return undefined;
  const preview = Array.from(text.replace(/\s+/gu, ' ').trim());
  return {
    id,
    text:
      preview.length > 140
        ? `${preview.slice(0, 139).join('')}…`
        : preview.join(''),
  };
}
export type Player = NamedPose & {
  id: number;
  king?: true;
  /** Holding a gun from the inventory. */
  armed?: true;
  practice?: true;
};
export type CrownLocation = { x: number; z: number };
export type RoomCrown =
  | CrownLocation
  | { holder: number; remainingMs: number; name?: string };

export function displayName(value: unknown) {
  if (typeof value !== 'string') return undefined;
  return (
    Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, 50).join('') ||
    undefined
  );
}

export type PlotSnapshot = { type: 'plots'; day: string; papers: string[] };
export type PostLocation = { x: number; z: number };
export type PlacedPost = PostLocation & {
  id: string;
  paper?: string;
  landedAt: number;
  floor?: number;
};
export type Placement = PostLocation & {
  type: 'place';
  id: string;
  proof: string;
  publishedAt: number;
  signedEvent: string;
};
export type PlacementUpdate = {
  type: 'placements';
  day: string;
  posts: PlacedPost[];
  live?: boolean;
};

export type PresenceMessage =
  | PlotSnapshot
  | PlacementUpdate
  | {
      type: 'welcome';
      id: number;
      slot: number;
      commit?: string;
      respawn?: Respawn;
    }
  | { type: 'post-marks'; marks: PostMark[] }
  | Gunshot
  | { type: 'shark-hit'; respawn: Respawn }
  | {
      type: 'players';
      players: Player[];
      crown: RoomCrown;
      vehicles: RoomVehicles;
      shark: SharkPose;
    };

const resetClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  hourCycle: 'h23',
});

export function plotDay(time: number) {
  const parts = resetClock.formatToParts(time);
  const value = (key: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find(({ type }) => type === key)?.value);
  return new Date(
    Date.UTC(
      value('year'),
      value('month') - 1,
      value('day') - Number(value('hour') < 3),
    ),
  )
    .toISOString()
    .slice(0, 10);
}

export function placementChallenge(
  id: string,
  x: number,
  z: number,
  publishedAt: number,
) {
  return new TextEncoder().encode(
    `Harbor Overworld post location\n${JSON.stringify([id, x, z, publishedAt])}`,
  );
}

export function isProof(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{128}$/.test(value);
}

function isPostLocation(
  value: unknown,
): value is PostLocation & { id: string } {
  if (!value || typeof value !== 'object') return false;
  const { id, x, z } = value as Partial<Placement>;
  return (
    typeof id === 'string' &&
    /^(?:[a-f0-9]{2}){1,200}$/.test(id) &&
    typeof x === 'number' &&
    typeof z === 'number' &&
    inWorld(x, z)
  );
}

export function isPlacement(value: unknown): value is Placement {
  return (
    isPostLocation(value) &&
    'type' in value &&
    value.type === 'place' &&
    'proof' in value &&
    isProof(value.proof) &&
    'publishedAt' in value &&
    typeof value.publishedAt === 'number' &&
    Number.isSafeInteger(value.publishedAt) &&
    'signedEvent' in value &&
    typeof value.signedEvent === 'string' &&
    value.signedEvent.length > 0 &&
    value.signedEvent.length <= 2048
  );
}

export function isPlacedPost(value: unknown): value is PlacedPost {
  if (!isPostLocation(value)) return false;
  const { paper, landedAt, floor } = value as Partial<PlacedPost>;
  return (
    (paper === undefined ||
      (typeof paper === 'string' &&
        paper.length > 0 &&
        paper.length <= 16 * 1024)) &&
    typeof landedAt === 'number' &&
    Number.isFinite(landedAt) &&
    (floor === undefined ||
      (typeof floor === 'number' && floor >= WATER && Number.isFinite(floor)))
  );
}

export function postExpired(landedAt: number, now = Date.now()) {
  return now - landedAt >= POST_LIFETIME_MS;
}

export function parseMessage(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function isPose(value: unknown): value is Pose {
  if (!value || typeof value !== 'object') return false;
  const { x, y, z, yaw } = value as Partial<Pose>;
  return (
    typeof x === 'number' &&
    typeof y === 'number' &&
    y >= 0 &&
    y <= 80 &&
    typeof z === 'number' &&
    inWorld(x, z) &&
    typeof yaw === 'number' &&
    Math.abs(yaw) <= Math.PI
  );
}

export function isVehiclePose(value: unknown): value is PlanePose {
  return (
    isPose(value) &&
    value.y >= WATER &&
    value.y <= 67 &&
    'pitch' in value &&
    typeof value.pitch === 'number' &&
    Math.abs(value.pitch) <= Math.PI
  );
}

export function readVehicleReport(value: unknown): VehicleReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { kind, pose, driving } = value as Partial<VehicleReport>;
  if (
    (kind !== 'boat' && kind !== 'plane') ||
    !isVehiclePose(pose) ||
    typeof driving !== 'boolean' ||
    ((kind === 'boat' || !driving) && (pose.y !== WATER || pose.pitch !== 0))
  )
    return undefined;
  const { x, y, z, yaw, pitch } = pose;
  return { kind, pose: { x, y, z, yaw, pitch }, driving };
}
