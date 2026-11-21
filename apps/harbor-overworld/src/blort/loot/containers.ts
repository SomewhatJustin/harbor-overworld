// Every shared inventory placed in the world. Add an entry to place one.
// "chest" takes and gives; "loot" only gives, and fills itself from its loot
// table the first time anyone opens it.

import { ground } from '../../world/terrain.ts';
import type { LootTableId } from './tables.ts';

export const CONTAINER_SLOTS = 12;
/** How close a player's feet must be to a container to use it, in metres. */
export const CONTAINER_REACH = 3;

export type ContainerKind = 'chest' | 'loot';

export function isContainerKind(value: unknown): value is ContainerKind {
  return value === 'chest' || value === 'loot';
}

export type ContainerDefinition = {
  /** Stable key in the save file. Never reuse one for a different spot. */
  id: string;
  kind: ContainerKind;
  x: number;
  z: number;
  /** Which way the front faces. 0 faces north (-z), like the spawn view. */
  yaw: number;
  /** Required for loot containers. */
  lootTable?: LootTableId;
  /** Only placed in the local playground. */
  playgroundOnly?: true;
};

export const CONTAINERS: readonly ContainerDefinition[] = [
  {
    id: 'playground-loot-1',
    kind: 'loot',
    x: 2.6,
    z: 15.8,
    yaw: -Math.PI / 2,
    lootTable: 'basic',
    playgroundOnly: true,
  },
];

/** Where a container sits: on the ground at its spot. */
export function containerPosition({ x, z }: { x: number; z: number }) {
  return { x, y: ground(x, z), z };
}

/** Whether a player's feet are close enough to use the container. */
export function withinReach(
  container: { x: number; z: number },
  feet: { x: number; y: number; z: number },
) {
  const { y } = containerPosition(container);
  return (
    Math.hypot(feet.x - container.x, feet.z - container.z) <= CONTAINER_REACH &&
    Math.abs(feet.y - y) <= CONTAINER_REACH
  );
}
