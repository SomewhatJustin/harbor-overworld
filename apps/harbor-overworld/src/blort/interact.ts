// Things the player can use with E. Each interactable object registers itself
// here once (chests today) and removes itself when it goes away. Only one
// prompt can show and E can only do one thing, so this module picks the one
// you're close to and looking at: it gets "Press E to interact", and E uses it.

import { currentPlayerPose, type PlayerPose } from '../world/bridge.ts';

export type Interactable = {
  id: string;
  x: number;
  z: number;
  /** Whether a player standing here can use it. */
  inReach: (feet: PlayerPose) => boolean;
  interact: () => void;
};

/** How far off the view direction something can be and still be "looked at". */
const FACING = (35 * Math.PI) / 180;
/** Closer than this, it counts whichever way you face. */
const POINT_BLANK = 0.7;

const interactables = new Set<Interactable>();

/**
 * Makes something usable with E. Its x, z and inReach are read every frame,
 * so it can move. Returns a remover.
 */
export function addInteractable(interactable: Interactable) {
  interactables.add(interactable);
  return () => interactables.delete(interactable);
}

/** How far, in radians, the player would turn to face x, z. */
function turnTo(pose: PlayerPose, x: number, z: number) {
  const dx = x - pose.x;
  const dz = z - pose.z;
  // The view looks along (sin yaw, -cos yaw).
  const forward = Math.atan2(Math.sin(pose.yaw), -Math.cos(pose.yaw));
  const toward = Math.atan2(dx, dz);
  return Math.abs(
    Math.atan2(Math.sin(toward - forward), Math.cos(toward - forward)),
  );
}

/** The interactable in reach that's closest to the middle of the view. */
export function targetFor(
  pose: PlayerPose,
  candidates: Iterable<Interactable>,
): Interactable | undefined {
  let best: Interactable | undefined;
  let bestTurn = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate.inReach(pose)) continue;
    const distance = Math.hypot(candidate.x - pose.x, candidate.z - pose.z);
    const turn =
      distance < POINT_BLANK ? 0 : turnTo(pose, candidate.x, candidate.z);
    if (turn > FACING || turn >= bestTurn) continue;
    best = candidate;
    bestTurn = turn;
  }
  return best;
}

type InteractionOptions = {
  /** False while E shouldn't do anything (offline, a panel or dialog up). */
  ready: () => boolean;
  setPrompt: (visible: boolean) => void;
};

export function mountInteraction({ ready, setPrompt }: InteractionOptions) {
  let target: Interactable | undefined;

  function tick() {
    requestAnimationFrame(tick);
    const pose = currentPlayerPose();
    const next = pose && ready() ? targetFor(pose, interactables) : undefined;
    if (!!next !== !!target) setPrompt(!!next);
    target = next;
  }
  requestAnimationFrame(tick);

  // Bubble phase, after the game's own handler: a noticeboard in focus uses
  // E to turn its page and marks the event handled, so it wins.
  window.addEventListener('keydown', (event) => {
    if (
      event.code !== 'KeyE' ||
      event.repeat ||
      event.defaultPrevented ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    )
      return;
    const element = event.target;
    if (
      element instanceof HTMLElement &&
      element.closest('input, textarea, [contenteditable], dialog')
    )
      return;
    if (!target || !ready()) return;
    event.preventDefault();
    target.interact();
  });
}
