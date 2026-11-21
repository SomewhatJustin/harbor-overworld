// The game's only hooks for Blort's additions (src/blort), which load
// separately and set these, so the game never imports them.

/** Holding a gun from the inventory: draw and fire it without the crown. */
let armed = false;

export function isArmed() {
  return armed;
}

export function setArmed(next: boolean) {
  armed = next;
}

/**
 * A mesh to draw in the world with the avatar shader: rotated by pitch about
 * its local x axis, then by yaw, then moved to x, y, z. Build vertices with
 * terrain's Mesh. Keep reusing the same array: the renderer uploads each one
 * once.
 */
export type Prop = {
  vertices: Float32Array;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch?: number;
};

let propSource: () => readonly Prop[] = () => [];

export function setPropSource(source: () => readonly Prop[]) {
  propSource = source;
}

export function currentProps() {
  return propSource();
}

/** Where the local player stands (feet) and faces, set every frame. */
export type PlayerPose = { x: number; y: number; z: number; yaw: number };

let playerPose: PlayerPose | undefined;

export function setPlayerPose(pose: PlayerPose | undefined) {
  playerPose = pose;
}

export function currentPlayerPose() {
  return playerPose;
}
