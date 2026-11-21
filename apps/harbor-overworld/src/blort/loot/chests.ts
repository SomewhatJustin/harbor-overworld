// Chests in the browser: draws every container the server lists, swings lids
// open while someone is looking inside, and lists each chest as something E
// can use. The server decides what's inside; this only asks.

import {
  currentPlayerPose,
  type Prop,
  setPropSource,
} from '../../world/bridge.ts';
import type { ContainerPlacement } from '../inventory/protocol.ts';
import {
  CHEST_HINGE,
  CHEST_OPEN_ANGLE,
  chestBodyMesh,
  chestLidMesh,
} from './chest-mesh.ts';
import { addInteractable } from '../interact.ts';
import { withinReach } from './containers.ts';

/** Radians per second the lid swings. */
const LID_SPEED = 7;

type ChestOptions = {
  /** The chest this tab has open, if any. */
  openHere: () => string | null;
  /** The player pressed E at this chest. */
  onOpen: (id: string) => void;
  /** The open chest is out of reach now. */
  onLeave: () => void;
};

export function mountChests({ openHere, onOpen, onLeave }: ChestOptions) {
  const body = chestBodyMesh();
  const lid = chestLidMesh();
  let placements: ContainerPlacement[] = [];
  const lidAngles = new Map<string, number>();
  /** Each chest's interactable, with the placement it reads. */
  const usable = new Map<
    string,
    { placement: ContainerPlacement; remove: () => void }
  >();
  let last = performance.now();

  /** Closes the panel if we end up out of reach, e.g. respawned elsewhere. */
  function checkReach() {
    const open = openHere();
    if (!open) return;
    const chest = usable.get(open)?.placement;
    const feet = currentPlayerPose();
    if (!chest || !feet || !withinReach(chest, feet)) onLeave();
  }

  // The renderer reads this once a frame; it also does the frame's reach
  // check, so chests need no loop of their own.
  function props(): Prop[] {
    checkReach();
    const now = performance.now();
    const step = Math.min(0.1, (now - last) / 1000) * LID_SPEED;
    last = now;
    return placements.flatMap((chest) => {
      const target =
        chest.open || openHere() === chest.id ? CHEST_OPEN_ANGLE : 0;
      const current = lidAngles.get(chest.id) ?? 0;
      const angle =
        current < target
          ? Math.min(target, current + step)
          : Math.max(target, current - step);
      lidAngles.set(chest.id, angle);
      const sin = Math.sin(chest.yaw);
      const cos = Math.cos(chest.yaw);
      return [
        { vertices: body, x: chest.x, y: chest.y, z: chest.z, yaw: chest.yaw },
        {
          vertices: lid,
          x: chest.x - sin * CHEST_HINGE.z,
          y: chest.y + CHEST_HINGE.y,
          z: chest.z + cos * CHEST_HINGE.z,
          yaw: chest.yaw,
          pitch: angle,
        },
      ];
    });
  }
  setPropSource(props);

  /** Registers a chest as usable with E the first time the server lists it. */
  function makeUsable(placement: ContainerPlacement) {
    const entry = { placement, remove: () => {} };
    const { id } = placement;
    entry.remove = addInteractable({
      id,
      get x() {
        return entry.placement.x;
      },
      get z() {
        return entry.placement.z;
      },
      inReach: (feet) => withinReach(entry.placement, feet),
      interact: () => onOpen(id),
    });
    usable.set(id, entry);
  }

  return {
    setPlacements(next: ContainerPlacement[]) {
      placements = next;
      const ids = new Set(next.map(({ id }) => id));
      for (const [id, entry] of usable) {
        if (ids.has(id)) continue;
        entry.remove();
        usable.delete(id);
        lidAngles.delete(id);
      }
      for (const placement of next) {
        const entry = usable.get(placement.id);
        if (entry) entry.placement = placement;
        else makeUsable(placement);
      }
    },
  };
}
