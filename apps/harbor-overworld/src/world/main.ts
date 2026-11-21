import {
  bytesToHex,
  COLLECTION,
  v2,
  SyncStrategy,
  type PolycentricClient,
  type ServerPushResult,
} from '@polycentric/js-core';
import { Query } from '@polycentric/rs-core-wasm/web';
import { getClient, HARBOR_PRODUCTION_SERVERS } from '../client/client';
import { createPost, MAX_POST_LENGTH } from '../data/compose';
import { loadExplorePage } from '../data/feed';
import { createIdentity, latestLocalProfile } from '../data/identity';
import { findLike, setLike } from '../data/likes';
import { decodePostBundle, eventKeyFromId, type PostData } from '../data/posts';
import { coatIndex, COATS } from './avatar';
import { bindBoat } from './boat';
import { shouldRejoinWorld, watchWorldUpdates } from './build';
import { bindIdentityDialog } from './connect';
import { createControls, POINTER_DEGREES } from './controls';
import { createCrown } from './crown';
import { currentProps, isArmed, setPlayerPose } from './bridge';
import { createWorldAudio } from './world-audio';
import { createLandShark, type SharkPose } from './land-shark';
import { bindMobileControls } from './mobile';
import { createPlayerMovement, EYE_HEIGHT, spawnView } from './movement';
import { PostNotice } from './notice';
import {
  DROP_BASE,
  DROP_DURATION,
  DROP_HALF_WIDTH,
  DROP_HEIGHT,
  isPostMark,
  nextDropFloor,
  POST_MARK_LIMIT,
  type PostMark,
} from './post-marks';
import { type Avatar, createPresence, type LocalCrown } from './presence';
import {
  DEFAULT_KING_SCALE,
  displayName,
  isPlacedPost,
  isPlacement,
  KING_SCALES,
  type KingScale,
  OVERWORLD_APPLICATION,
  type PlacedPost,
  type Placement,
  type PlacementUpdate,
  placementChallenge,
  type PostLocation,
  type Respawn,
  plotDay,
  postExpired,
  SHOT_INTERVAL,
  type ShotPath,
} from './presence-protocol';
import { loadProfile } from '../data/profile';
import { fetchOnce } from '../data/query';
import { createRenderer, type FallingPost, facingNotice } from './renderer';
import { bindSeaplane } from './seaplane';
import { SHOT_EFFECT_DURATION, type ShotEffect } from './shot-effects';
import { traceShot } from './shot-trace';
import {
  DOCK,
  ground,
  inWorld,
  ISLAND_BOUNDS,
  LANDMARKS,
  MAX_X,
  MAX_Z,
  MIN_X,
  MIN_Z,
  noise,
  SPAWN,
  STATIONS,
  trailDistance,
  WATER,
} from './terrain';
import type { VehicleKind, VehicleReport } from './vehicles';
import './world.css';

function element<T extends HTMLElement>(id: string) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing Overworld element ${id}`);
  return node as T;
}

const world = element<HTMLCanvasElement>('world');
const game = element('overworld');
const welcome = element('welcome');
const connectIdentity = element('connect-identity');
const interaction = element('interaction');
const pageButton = element<HTMLButtonElement>('turn-page');
const likeButton = element<HTMLButtonElement>('like-post');
const thread = element<HTMLAnchorElement>('thread');
const noticeDescription = element('notice-description');
const crosshair = element('crosshair');
const fallingPosts = element('falling-posts');
const refresh = element<HTMLButtonElement>('refresh');
const chatPanel = element<HTMLDialogElement>('chat-panel');
const connectPanel = element<HTMLDialogElement>('connect-panel');
const chatForm = element<HTMLFormElement>('chat-form');
const identityForm = element<HTMLFormElement>('identity-form');
const identityName = element<HTMLInputElement>('identity-name');
const draft = element<HTMLTextAreaElement>('draft');
const send = element<HTMLButtonElement>('send');
const create = element<HTMLButtonElement>('create-identity');
const chatStatus = element('chat-status');
const toast = element('toast');
const keys = new Set<string>();
const movement = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
];
const player = createPlayerMovement();
const { view } = player;
const isPlayground =
  import.meta.env.DEV && import.meta.env.MODE === 'playground';
let playground:
  | ReturnType<typeof import('./playground').setupPlayground>
  | undefined;
const playgroundLikes = new Set<string>();
const roomStatus = element('room-status');
const kingStatus = element('king-status');
const kingSizeButton = element<HTMLButtonElement>('king-size');
const kingControls = element('king-controls');
const touchShoot = element('touch-shoot');
const touchJump = element('touch-jump');
const jumpHint = element('jump-hint');
const welcomeIdentity = element<HTMLFormElement>('welcome-identity');
const welcomeName = element<HTMLInputElement>('welcome-name');
const welcomeError = element('welcome-error');
const enterButton = element<HTMLButtonElement>('enter-world');
let sharedCrown: LocalCrown | undefined;
let soloCrown: ReturnType<typeof createCrown> | undefined;
let soloShark: ReturnType<typeof createLandShark> | undefined;
let kingMode = false;
let kingScale: KingScale = DEFAULT_KING_SCALE;
let nextShot = 0;
let avatarName: string | undefined;
const enableSound = element<HTMLButtonElement>('enable-sound');
const worldAudio = createWorldAudio((blocked) => {
  enableSound.hidden = !entered || !blocked;
});
enableSound.addEventListener('click', () => worldAudio.unlock());
let shotEffects: ShotEffect[] = [];
let postMarks: PostMark[] = [];
let lastDriven: VehicleKind | undefined;

function vehicleReport(): VehicleReport | undefined {
  const kind = boat.aboard ? 'boat' : plane.aboard ? 'plane' : lastDriven;
  if (!kind) return undefined;
  lastDriven = kind;
  const pose =
    kind === 'boat' ? { ...boat.pose, y: WATER, pitch: 0 } : plane.pose;
  return {
    kind,
    pose: {
      ...pose,
      yaw: Math.atan2(Math.sin(pose.yaw), Math.cos(pose.yaw)),
      pitch: Math.atan2(Math.sin(pose.pitch), Math.cos(pose.pitch)),
    },
    driving: kind === 'boat' ? boat.aboard : plane.aboard,
  };
}

const presence = createPresence(
  () => ({
    ...view,
    y: view.y - EYE_HEIGHT,
    name: avatarName,
    vehicle: vehicleReport(),
    kingScale: kingMode ? kingScale : undefined,
  }),
  (slot) => {
    if (playground?.scene) return;
    if (Math.hypot(view.x - SPAWN.x, view.z - SPAWN.z) > 0.25) return;
    player.reset({ ...spawnView(slot), yaw: view.yaw, pitch: view.pitch });
  },
  (label, solo) => {
    roomStatus.hidden = false;
    roomStatus.textContent = label;
    soloCrown = solo ? createCrown() : undefined;
    soloShark = solo ? createLandShark() : undefined;
  },
  updatePlots,
  updatePlacements,
  updatePostMarks,
  (crown) => {
    sharedCrown = crown;
  },
  showGunshot,
  respawnPlayer,
);

function respawnPlayer(slot: number, cause?: Respawn['cause']) {
  boat.reset();
  plane.reset();
  player.reset(spawnView(slot));
  announce(
    cause === 'shark'
      ? 'The land shark got you. You respawned at the harbor.'
      : 'You respawned at the harbor.',
  );
}
let renderer: ReturnType<typeof createRenderer> | undefined;
let entered = false;
let dragging = false;
let dragDistance = 0;
let busy = false;
let notices: PostNotice[] = [];
let focusedNotice: PostNotice | undefined;
let replyTo: PostData | undefined;
let pending:
  | { post: PostData; paper: string; location: PostLocation }
  | undefined;
let client: PolycentricClient | undefined;
let toastTimer = 0;
let resumePointer = false;
let resumeChat = false;
let openingReply = false;
let plotsDay: string | undefined;

const controls = createControls({
  status() {
    const crown = soloCrown?.state ?? sharedCrown;
    return {
      entered,
      position: { x: view.x, y: view.y - EYE_HEIGHT, z: view.z },
      aim: {
        yaw:
          (Math.atan2(Math.sin(view.yaw), Math.cos(view.yaw)) * 180) / Math.PI,
        pitch: (view.pitch * 180) / Math.PI,
      },
      room: roomStatus.textContent,
      king: kingMode ? { size: kingScale, time: kingStatus.textContent } : null,
      crown: crown && 'location' in crown ? crown.location : null,
      shark: soloShark?.pose ?? presence.shark(performance.now()),
      boat: { available: boat.available, aboard: boat.aboard, ...boat.pose },
      plane: {
        available: plane.available,
        aboard: plane.aboard,
        ...plane.status,
      },
      players: presence
        .avatars(performance.now())
        .map(({ id, name, x, y, z, king }) => ({
          id,
          name,
          x,
          y,
          z,
          king: king === true,
        })),
      notice: focusedNotice
        ? {
            description: focusedNotice.description,
            liked: likeButton.getAttribute('aria-pressed') === 'true',
          }
        : null,
      dialog: connectPanel.open ? 'identity' : chatPanel.open ? 'chat' : null,
      scenes: playground?.sceneNames,
    };
  },
  enter(capturePointer, useDisplayName) {
    if (busy) return false;
    if (useDisplayName && !isPlayground)
      return enterFromWelcome(capturePointer);
    return enter(capturePointer);
  },
  beginMovement() {
    if (!renderer || chatPanel.open || connectPanel.open) return false;
    return entered || enter(false);
  },
  look(yaw, pitch) {
    if (
      entered &&
      !chatPanel.open &&
      !connectPanel.open &&
      !plane.aboard &&
      !playground?.replaying
    )
      player.look((yaw * Math.PI) / 180, (pitch * Math.PI) / 180);
  },
  jump: jumpOnce,
  shoot: shootOnce,
  size: cycleKingScale,
  boat: () => boat.toggle(),
  plane: () => plane.toggle(),
  'plane-pitch': (amount) => plane.pitch(amount),
  page: (direction) => turnPage(direction === 'previous'),
  like: toggleLike,
  reply: replyToNotice,
  thread() {
    if (!focusedNotice || thread.hidden) return false;
    window.open(thread.href, '_blank', 'noopener');
    return true;
  },
  chat: () => openChat(),
  close() {
    const dialog = connectPanel.open
      ? connectPanel
      : chatPanel.open
        ? chatPanel
        : undefined;
    if (!dialog) return false;
    closePanel(dialog);
    return true;
  },
  draft(text) {
    if (!chatPanel.open || chatForm.hidden || draft.readOnly) return false;
    draft.value = text.slice(0, draft.maxLength);
    return true;
  },
  publish: submitDraft,
  identity: openIdentity,
  'create-name': createDisplayName,
  refresh: loadPosts,
  fullscreen: () => mobile.toggleFullscreen(),
  scene: (name, replay) => playground?.loadScene(name, replay) ?? false,
  'join-tab': () => playground?.joinTab() ?? false,
});
const touchControls = controls.from('touch');
const mobile = bindMobileControls(game, world, {
  hasStarted: () => entered && !chatPanel.open && !connectPanel.open,
  run: touchControls,
});

type WorldPost = {
  notice: PostNotice;
  drop: FallingPost;
  landedAt: number;
  request?: Placement;
  preview?: HTMLElement;
  retryAt: number;
};
const worldPosts = new Map<string, WorldPost>();
const placementStorage = 'overworld:placement:';
const readingPlacements = new Set<string>();

function setNotices(posts: readonly PostData[]) {
  const byId = new Map(notices.map((notice) => [notice.post.id, notice]));
  notices = posts.map(
    (post) => byId.get(post.id) ?? new PostNotice(post, updateNotice),
  );
  renderer?.setStations(notices.map((notice) => notice.canvas));
}

function decodePaper(paper: string) {
  try {
    const bundle = v2.EventBundle.fromBinary(
      Uint8Array.from(atob(paper), (char) => char.charCodeAt(0)),
    );
    return decodePostBundle(bundle);
  } catch {
    return null;
  }
}

function updatePostMarks(marks: PostMark[]) {
  postMarks = marks;
  renderer?.setPostMarks(marks, plotDay(Date.now()));
}

function updatePlots({ day, papers }: { day: string; papers: string[] }) {
  if (day !== plotDay(Date.now())) return;
  renderer?.setPostMarks(postMarks, day);
  const posts = papers.slice(0, STATIONS.length).flatMap((paper) => {
    const post = decodePaper(paper);
    return post ? [post] : [];
  });
  if (!posts.length) return;
  plotsDay = day;
  setNotices(posts);
  markNetwork(
    'live',
    isPlayground ? 'PLAYGROUND' : 'PRODUCTION',
    `${posts.length} live ${posts.length === 1 ? 'post' : 'posts'}`,
  );
}

function isOverworldPost(post: PostData) {
  return (
    v2.Event.fromBinary(post.signedEvent.eventBytes).application?.id ===
    OVERWORLD_APPLICATION
  );
}

function showPlacement(
  { id, x, z, landedAt, floor }: PlacedPost,
  post: PostData,
  {
    live,
    request,
    author,
  }: { live?: boolean; request?: Placement; author?: string } = {},
) {
  if (postExpired(landedAt) || post.id !== id) return;
  const existing = worldPosts.get(id);
  if (existing && (!existing.request || request)) return;
  if (
    existing?.drop.x === x &&
    existing.drop.z === z &&
    (floor === undefined || existing.drop.y === floor)
  ) {
    existing.request = undefined;
    return;
  }
  existing?.preview?.remove();
  const notice = new PostNotice(post, updateNotice, { card: true, author });
  const y =
    floor ??
    nextDropFloor(
      x,
      z,
      [...worldPosts.values()]
        .map(({ drop }) => drop)
        .filter((drop) => drop.id !== id)
        .map((drop) => ({ x: drop.x, z: drop.z, floor: drop.y })),
    );
  const entry: WorldPost = {
    notice,
    drop: {
      id,
      x,
      y,
      z,
      paper: notice.canvas,
      start: performance.now() / 1000 - (live ? 0 : DROP_DURATION),
    },
    landedAt,
    request,
    retryAt: 0,
  };
  worldPosts.set(id, entry);
  renderer?.setDrop(id, notice.canvas);
  if (live && !document.hidden) {
    const card = document.createElement('div');
    const coords = document.createElement('span');
    coords.className = 'plate';
    coords.textContent = `${Math.floor(x)} / ${Math.floor(z)}`;
    card.append(notice.canvas, coords);
    fallingPosts.append(card);
    entry.preview = card;
    if (client) notice.loadAssets(client);
    window.setTimeout(() => {
      card.remove();
      entry.preview = undefined;
    }, 3450);
  }
}

function restorePlacements() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(placementStorage)) continue;
      try {
        const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
        if (
          isPlacement(saved?.request) &&
          isPlacedPost(saved?.placement) &&
          saved.placement.paper &&
          !postExpired(saved.placement.landedAt)
        ) {
          const post = decodePaper(saved.placement.paper);
          if (post) {
            showPlacement(saved.placement, post, { request: saved.request });
            continue;
          }
        }
      } catch {
        // Discard invalid saved placements.
      }
      localStorage.removeItem(key);
    }
  } catch (error) {
    console.warn('Could not restore local Overworld posts:', error);
  }
}

async function resolvePlacement(placement: PlacedPost, live: boolean) {
  const { id, landedAt, paper } = placement;
  if (postExpired(landedAt)) return;
  const existing = worldPosts.get(id);
  if (existing) {
    showPlacement(placement, existing.notice.post, { live: false });
    return;
  }
  if (paper) {
    const post = decodePaper(paper);
    if (post && isOverworldPost(post)) showPlacement(placement, post, { live });
    return;
  }
  if (readingPlacements.has(id)) return;
  readingPlacements.add(id);
  try {
    const activeClient = await getClient();
    const key = eventKeyFromId(id);
    if (key.collection !== COLLECTION.FEED || !key.signedBy) return;
    const query = new Query.GetPost({
      identity: key.identity,
      sequence: key.sequence,
      signerKeyPrefix: bytesToHex(key.signedBy.key).slice(0, 16),
    });
    for (let attempt = 0; attempt < 3 && !postExpired(landedAt); attempt++) {
      const bytes = await fetchOnce(
        activeClient,
        ['world-post', id, String(attempt)],
        query,
        { servers: HARBOR_PRODUCTION_SERVERS, serverTimeoutMs: 2500 },
      ).catch(() => undefined);
      if (bytes) {
        const { candidates } = v2.GetPostResponse.fromBinary(
          new Uint8Array(bytes),
        );
        for (const bundle of candidates) {
          const post = decodePostBundle(bundle);
          if (post?.id === id && isOverworldPost(post)) {
            showPlacement(placement, post, { live });
            return;
          }
        }
      }
      if (attempt < 2)
        await new Promise((resolve) =>
          window.setTimeout(resolve, 500 * (attempt + 1)),
        );
    }
  } catch (error) {
    console.warn('Could not load a shared Overworld post:', error);
  } finally {
    readingPlacements.delete(id);
  }
}

function updatePlacements({ posts, live }: PlacementUpdate) {
  for (const post of posts) {
    const age = Date.now() - post.landedAt;
    void resolvePlacement(post, live ?? (age >= 0 && age < 1000));
  }
}

function prunePlacements(now: number) {
  for (const [id, entry] of worldPosts) {
    if (!postExpired(entry.landedAt, now)) continue;
    entry.preview?.remove();
    worldPosts.delete(id);
    try {
      localStorage.removeItem(placementStorage + id);
    } catch {
      // Storage can be unavailable in private browsing.
    }
  }
}

function retryPlacements() {
  const now = Date.now();
  if (plotsDay && plotsDay !== plotDay(now)) {
    plotsDay = undefined;
    setNotices([]);
  }
  prunePlacements(now);
  for (const entry of worldPosts.values()) {
    if (!entry.request || entry.retryAt > now) continue;
    if (presence.place(entry.request)) entry.retryAt = now + 8000;
    break;
  }
}

function publishPlacement(
  placement: PlacedPost & { paper: string },
  post: PostData,
  request: Placement,
  author?: string,
) {
  showPlacement(placement, post, { live: true, request, author });
  try {
    localStorage.setItem(
      placementStorage + placement.id,
      JSON.stringify({ placement, request }),
    );
  } catch (error) {
    console.warn('Could not save the local Overworld post:', error);
  }
  retryPlacements();
}

function facingPlacement(camera: typeof view, time: number) {
  const vx = Math.sin(camera.yaw);
  const vz = -Math.cos(camera.yaw);
  const slope = Math.tan(camera.pitch);
  let nearest: PostNotice | undefined;
  let range = 5;
  for (const { drop, notice } of worldPosts.values()) {
    if (time - drop.start < DROP_DURATION) continue;
    const dx = drop.x - camera.x;
    const dz = drop.z - camera.z;
    const depth = dx * vx + dz * vz;
    const along = dx * -vz + dz * vx;
    const height = camera.y + slope * depth - drop.y - DROP_BASE;
    if (
      depth < 0.15 ||
      depth >= range ||
      Math.abs(along) > DROP_HALF_WIDTH ||
      height < 0 ||
      height > DROP_HEIGHT
    )
      continue;
    nearest = notice;
    range = depth;
  }
  return nearest;
}

draft.maxLength = MAX_POST_LENGTH;

function updateAvatarName(activeClient: PolycentricClient) {
  const identity = activeClient.activeIdentityKey;
  welcomeIdentity.hidden = !!identity;
  connectIdentity.textContent = identity
    ? 'Switch Harbor identity'
    : 'Connect Harbor identity';
  updateLikeButton();
  avatarName = identity
    ? displayName(latestLocalProfile(activeClient, identity)?.name)
    : undefined;
  if (!identity || avatarName) return;
  void loadProfile(activeClient, identity)
    .then(({ name }) => {
      if (
        client === activeClient &&
        activeClient.activeIdentityKey === identity &&
        !avatarName
      ) {
        avatarName = displayName(name);
      }
    })
    .catch(() => undefined);
}

function announce(message: string) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 5500);
}

function report(message = '') {
  chatStatus.textContent = message;
  chatStatus.hidden = !message;
}

function markNetwork(state: string, name: string, detail: string) {
  element('network-lamp').dataset.state = state;
  element('network-name').textContent = name;
  element('network-detail').textContent = detail;
}

async function loadPosts() {
  if (isPlayground || refresh.disabled) return;
  refresh.disabled = true;
  markNetwork('loading', 'CONNECTING', 'Harbor feed');
  try {
    const activeClient = await getClient();
    client = activeClient;
    updateAvatarName(activeClient);
    const posts = new Map<string, PostData>();
    let cursor: string | undefined;
    for (let i = 0; !plotsDay && i < 5 && posts.size < STATIONS.length; i++) {
      const page = await loadExplorePage(activeClient, 'latest', cursor, {
        servers: HARBOR_PRODUCTION_SERVERS,
        includeLocal: false,
      });
      for (const post of page.items) {
        if (!isOverworldPost(post)) posts.set(post.id, post);
      }
      if (!page.hasMore || !page.cursor || page.cursor === cursor) break;
      cursor = page.cursor;
    }
    if (!plotsDay) setNotices([...posts.values()].slice(0, STATIONS.length));
    const count = notices.length;
    markNetwork(
      'live',
      'PRODUCTION',
      `${count} live ${count === 1 ? 'post' : 'posts'}`,
    );
  } catch (error) {
    console.error('Could not load the Harbor feed:', error);
    markNetwork(
      'error',
      'FEED UNAVAILABLE',
      notices.length ? 'Showing last load' : 'Click to retry',
    );
  } finally {
    refresh.disabled = false;
  }
}

function capture() {
  if (
    !renderer ||
    document.pointerLockElement === world ||
    chatPanel.open ||
    connectPanel.open
  )
    return;
  try {
    void world.requestPointerLock?.()?.catch(() => undefined);
  } catch {
    // Dragging the canvas also works when the browser blocks pointer lock.
  }
}

function enter(captureMouse: boolean) {
  if (!renderer) return false;
  if (!entered) presence.join();
  entered = true;
  worldAudio.unlock();
  welcome.hidden = true;
  game.classList.add('entered');
  if (document.activeElement instanceof HTMLButtonElement)
    document.activeElement.blur();
  if (captureMouse) capture();
  return true;
}

function pause(dialog: HTMLDialogElement) {
  if (document.pointerLockElement === world) {
    resumePointer = true;
    document.exitPointerLock();
  }
  dragging = false;
  keys.clear();
  controls.release();
  mobile.reset();
  dialog.showModal();
}

function closePanel(dialog: HTMLDialogElement, resume = true) {
  dialog.close();
  if (resume && resumePointer) {
    resumePointer = false;
    capture();
  }
}

function updateNotice(notice: PostNotice) {
  const index = notices.indexOf(notice);
  if (index >= 0) renderer?.setNotice(index, notice.canvas);
  if (worldPosts.get(notice.post.id)?.notice === notice)
    renderer?.setDrop(notice.post.id, notice.canvas);
  if (focusedNotice === notice)
    noticeDescription.textContent = notice.description;
}

function focusNotice(notice: PostNotice | undefined) {
  if (focusedNotice === notice) return;
  focusedNotice = notice;
  interaction.hidden = !notice;
  crosshair.classList.toggle('active', !!notice);
  noticeDescription.textContent = notice?.description ?? '';
  updateLikeButton();
  if (!notice) return;
  pageButton.hidden = notice.pageCount < 2;
  const { identity, signedBy, sequence } = notice.post;
  const fingerprint = bytesToHex(signedBy.key).slice(0, 16);
  thread.href = `https://harbor.social/${encodeURIComponent(identity)}/post/${fingerprint}/${encodeURIComponent(sequence)}`;
  if (client) notice.loadAssets(client);
}

function updateLikeButton() {
  const post = focusedNotice?.post;
  likeButton.setAttribute(
    'aria-pressed',
    String(
      !!(
        post &&
        (isPlayground
          ? playgroundLikes.has(post.id)
          : client && findLike(client, post.id))
      ),
    ),
  );
}

function showLikeHeart() {
  const heart = document.createElement('span');
  heart.className = 'like-heart';
  heart.setAttribute('aria-hidden', 'true');
  heart.textContent = '♥';
  game.append(heart);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animation = heart.animate(
    reduced
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [
          { transform: 'scale(.55)', opacity: 1, offset: 0 },
          {
            transform: 'translate(5px, -26px) scale(1.2)',
            opacity: 1,
            offset: 0.28,
          },
          {
            transform: 'translate(23px, -112px) rotate(14deg) scale(.85)',
            opacity: 0,
          },
        ],
    { duration: reduced ? 350 : 800, easing: 'ease-out' },
  );
  const remove = () => heart.remove();
  animation.onfinish = remove;
  animation.oncancel = remove;
}

async function toggleLike() {
  const post = focusedNotice?.post;
  if (!post || busy) return;
  if (isPlayground) {
    if (!playgroundLikes.delete(post.id)) {
      playgroundLikes.add(post.id);
      showLikeHeart();
    }
    updateLikeButton();
    return;
  }
  const activeClient = client;
  if (!activeClient?.activeIdentityKey || !activeClient.currentKeyPair) {
    openIdentity();
    return;
  }
  busy = true;
  likeButton.disabled = true;
  try {
    const existing = findLike(activeClient, post.id);
    const { eventKey } = await setLike(activeClient, post.id, existing);
    if (!existing) showLikeHeart();
    updateLikeButton();
    const sent = await publish(activeClient, eventKey, false);
    if (sent) announce(existing ? 'Like removed.' : 'Post liked.');
    else announce('Reaction saved locally. Harbor sync is pending.');
  } catch (error) {
    console.error('Could not update the Harbor reaction:', error);
    announce('Could not finish syncing your reaction.');
  } finally {
    busy = false;
    likeButton.disabled = false;
    updateLikeButton();
  }
}

function turnPage(backwards = false) {
  if (client && !chatPanel.open) focusedNotice?.turn(client, backwards);
}

function replyToNotice() {
  if (focusedNotice) void openChat(focusedNotice.post);
}

function showComposer() {
  const ready = !!client?.activeIdentityKey;
  const label = pending ? 'Retry publish' : 'Publish';
  element('send-label').textContent = label;
  send.disabled = busy;
  create.disabled = busy;
  draft.readOnly = busy || !!pending;
  chatForm.hidden = !ready;
  identityForm.hidden = ready || !client;
  if (!client) return;
  if (ready) draft.focus();
  else identityName.focus();
}

async function openChat(target?: PostData) {
  if (isPlayground) {
    announce('Playground uses a sample feed.');
    return;
  }
  if (chatPanel.open || connectPanel.open) return;
  if (!pending && replyTo?.id !== target?.id) draft.value = '';
  if (!pending) replyTo = target;
  element('chat-heading').textContent = replyTo
    ? 'Reply to post'
    : 'Write a post';
  element('chat-context').textContent = replyTo
    ? 'Publishes as a public reply on Harbor.'
    : 'Publishes to Harbor as a public post.';
  report(pending ? 'Saved on this browser. Retry to publish to Harbor.' : '');
  pause(chatPanel);
  showComposer();
  try {
    client = await getClient();
    updateAvatarName(client);
    if (!chatPanel.open) return;
    showComposer();
    if (!client.activeIdentityKey)
      report('Create a Harbor identity to start posting.');
    else if (!pending) {
      const profile = latestLocalProfile(client, client.activeIdentityKey);
      if (profile?.name) report(`Posting as ${profile.name}`);
    }
  } catch (error) {
    console.error('Could not open the Harbor client:', error);
    report('Could not connect to Harbor. Close and reopen chat to retry.');
  }
}

async function publish(
  activeClient: PolycentricClient,
  key: v2.EventKey,
  retry: boolean,
) {
  const results = new Map<string, ServerPushResult>();
  const collect = (outcomes: ServerPushResult[]) => {
    for (const outcome of outcomes) {
      if (outcome.identity === key.identity)
        results.set(outcome.server, outcome);
    }
  };
  // The world publishes to production even when the regular client uses a
  // different configured seed list. Restore the identity's server list after.
  const previousServers = activeClient.servers;
  activeClient.servers = [...HARBOR_PRODUCTION_SERVERS];
  activeClient.events.onPushResults(collect);
  try {
    await activeClient.sync(
      retry ? SyncStrategy.FULL_PUSH : SyncStrategy.PARTIAL_PUSH,
    );
  } finally {
    activeClient.events.offPushResults(collect);
    activeClient.servers = previousServers;
  }
  const signer = key.signedBy && bytesToHex(key.signedBy.key);
  return HARBOR_PRODUCTION_SERVERS.some((server) => {
    const result = results.get(server);
    return (
      result &&
      !result.error &&
      !result.eventIssues.some(
        (issue) =>
          issue.key.collection === key.collection &&
          issue.key.sequence === key.sequence &&
          bytesToHex(new Uint8Array(issue.key.signedBy.key)) === signer,
      )
    );
  });
}

async function submitDraft() {
  if (isPlayground || !chatPanel.open) return;
  const activeClient = client;
  const text = draft.value.trim();
  if (!activeClient?.activeIdentityKey || busy || (!pending && !text)) return;
  busy = true;
  showComposer();
  report('Publishing…');
  try {
    const retry = !!pending;
    if (!pending) {
      const { x, z } = view;
      const result = await createPost(activeClient, {
        text,
        images: [],
        replyTo,
      });
      pending = { ...result, location: { x, z } };
    }
    const { post, paper, location } = pending;
    const pair = activeClient.currentKeyPair;
    if (
      !pair ||
      bytesToHex(pair.publicKey.key) !== bytesToHex(post.signedBy.key)
    )
      throw new Error('The publishing identity changed.');
    if (!(await publish(activeClient, eventKeyFromId(post.id), retry)))
      throw new Error('No production server confirmed the post.');
    const publishedAt = Date.now();
    const proof = bytesToHex(
      await activeClient.cryptoManager.sign(
        pair.privateKey.key,
        placementChallenge(post.id, location.x, location.z, publishedAt),
        pair.keyType,
      ),
    );
    const signedEvent = btoa(
      String.fromCharCode(...v2.SignedEvent.toBinary(post.signedEvent)),
    );
    publishPlacement(
      { id: post.id, paper, ...location, landedAt: publishedAt },
      post,
      {
        type: 'place',
        id: post.id,
        ...location,
        proof,
        publishedAt,
        signedEvent,
      },
      latestLocalProfile(activeClient, post.identity)?.name,
    );
    pending = undefined;
    replyTo = undefined;
    draft.value = '';
    if (chatPanel.open) closePanel(chatPanel, false);
    announce(
      post.reply
        ? 'Reply dropped here. Step back to read it.'
        : 'Post dropped here. Step back to read it.',
    );
    void loadPosts();
  } catch (error) {
    console.error('Harbor publish failed:', error);
    report(
      pending
        ? 'Saved on this browser. Retry to publish to Harbor.'
        : 'Could not save the post. Your draft is still here.',
    );
  } finally {
    busy = false;
    if (chatPanel.open) showComposer();
  }
}

async function createDisplayName(text: string) {
  const name = text.trim();
  if (isPlayground || !chatPanel.open || !client || busy || !name) return;
  busy = true;
  showComposer();
  report('Creating your Harbor identity…');
  try {
    await createIdentity(client, name);
    updateAvatarName(client);
    report(`Posting as ${name}`);
  } catch (error) {
    console.error('Could not create a Harbor identity:', error);
    report(
      'Could not finish identity setup. Try again or use an existing identity.',
    );
  } finally {
    busy = false;
    if (chatPanel.open) showComposer();
  }
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void controls.run('publish');
});
identityForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void controls.run('create-name', identityName.value);
});
draft.addEventListener('input', () => controls.run('draft', draft.value));
draft.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (!event.repeat) void controls.run('publish');
});

chatPanel.addEventListener('close', () => {
  const active = document.activeElement;
  if (
    !chatPanel.open &&
    active instanceof HTMLElement &&
    chatPanel.contains(active)
  )
    active.blur();
});

for (const button of document.querySelectorAll<HTMLButtonElement>(
  '[data-close]',
)) {
  button.addEventListener('click', () => controls.run('close'));
}
for (const dialog of [chatPanel, connectPanel]) {
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    controls.run('close');
  });
}
function openIdentity() {
  if (isPlayground || connectPanel.open) return;
  resumeChat = chatPanel.open;
  if (resumeChat) closePanel(chatPanel, false);
  pause(connectPanel);
  element('pair-code').focus();
}

bindIdentityDialog(connectPanel, (connectedClient) => {
  client = connectedClient;
  updateAvatarName(connectedClient);
  closePanel(connectPanel, false);
  if (resumeChat) void openChat(replyTo);
  else announce('Harbor identity connected.');
});
connectIdentity.addEventListener('click', () => controls.run('identity'));
element('existing-identity').addEventListener('click', () =>
  controls.run('identity'),
);
refresh.addEventListener('click', () => void controls.run('refresh'));
kingSizeButton.addEventListener('click', (event) => {
  controls.run('size');
  if (event.detail > 0) kingSizeButton.blur();
});
pageButton.addEventListener('click', () => controls.run('page', 'next'));
likeButton.addEventListener('click', () => void controls.run('like'));
thread.addEventListener('click', (event) => {
  event.preventDefault();
  controls.run('thread');
});
async function enterFromWelcome(capturePointer: boolean) {
  if (busy) return;
  const name = welcomeName.value.trim();
  if (!name || client?.activeIdentityKey) {
    return enter(capturePointer);
  }
  busy = true;
  enterButton.disabled = true;
  welcomeName.disabled = true;
  welcomeError.textContent = 'Creating your Harbor identity…';
  welcomeError.hidden = false;
  try {
    client = await getClient();
    if (!client.activeIdentityKey) await createIdentity(client, name);
    updateAvatarName(client);
    return enter(false);
  } catch (error) {
    console.error('Could not create a Harbor identity:', error);
    welcomeError.textContent =
      'Could not create your identity. Try again or clear the name to play as a guest.';
  } finally {
    busy = false;
    enterButton.disabled = false;
    welcomeName.disabled = false;
  }
}

function joinFromWelcome() {
  worldAudio.unlock();
  void controls.run('enter', !game.classList.contains('touch-input'), true);
}
game.addEventListener(
  'click',
  () => {
    if (entered) worldAudio.unlock();
  },
  { capture: true },
);
enterButton.addEventListener('click', joinFromWelcome);
welcomeIdentity.addEventListener('submit', (event) => {
  event.preventDefault();
  joinFromWelcome();
});
element('open-chat').addEventListener('click', () => void controls.run('chat'));
element('reply').addEventListener('click', () => controls.run('reply'));
world.addEventListener('click', (event) => {
  if (busy) return;
  const mouse = event.pointerType
    ? event.pointerType === 'mouse'
    : !game.classList.contains('touch-input');
  if (mouse && entered) {
    const locked = document.pointerLockElement === world;
    if (locked || (gunOut() && dragDistance < 5)) controls.run('shoot');
    if (locked || dragDistance >= 5) return;
  }
  if (!entered || mouse) controls.run('enter', mouse, false);
});
world.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'mouse' || event.button !== 0) return;
  dragDistance = 0;
  dragging = entered && document.pointerLockElement !== world;
});
window.addEventListener('pointerup', () => {
  dragging = false;
});
window.addEventListener('blur', () => {
  keys.clear();
  controls.release();
  dragging = false;
  openingReply = false;
  mobile.reset();
});
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === world) {
    resumePointer = false;
    return;
  }
  keys.clear();
  controls.run('stop');
  controls.run('ascend', false);
  controls.run('sprint', false);
});

function setKingScale(scale: KingScale) {
  kingScale = scale;
  kingSizeButton.textContent = `Size ${scale}×`;
}

function updateCrown(time: number) {
  if (!entered) return undefined;
  soloCrown?.update(time, [
    { id: 1, x: view.x, y: view.y - EYE_HEIGHT, z: view.z },
  ]);
  const crown = soloCrown?.state ?? sharedCrown;
  const seconds =
    crown && 'expiresAt' in crown
      ? Math.ceil((crown.expiresAt - time) / 1000)
      : 0;
  const holderName =
    crown && 'holderName' in crown ? crown.holderName : undefined;
  const crowned = seconds > 0 && !holderName;
  if (crowned !== kingMode) {
    kingMode = crowned;
    kingSizeButton.hidden = !crowned;
    kingControls.hidden = !crowned;
    touchJump.textContent = crowned ? 'Rise' : 'Jump';
    jumpHint.textContent = crowned ? 'Hold to ascend' : 'Jump';
    setKingScale(DEFAULT_KING_SCALE);
    announce(crowned ? 'You found the crown!' : 'Your reign has ended.');
  }
  kingStatus.hidden = seconds <= 0;
  if (seconds > 0) {
    const countdown =
      seconds === 60 ? '1:00' : `0:${String(seconds).padStart(2, '0')}`;
    const label = `${holderName ? `King: ${holderName}` : 'King Mode'} · ${countdown}`;
    if (kingStatus.textContent !== label) kingStatus.textContent = label;
  }
  return crown && 'location' in crown ? crown.location : undefined;
}

function cycleKingScale() {
  if (kingMode)
    setKingScale(
      KING_SCALES[(KING_SCALES.indexOf(kingScale) + 1) % KING_SCALES.length],
    );
}

/** The crown's gun, or one drawn from the inventory. */
function gunOut() {
  return kingMode || isArmed();
}

function shootOnce() {
  const now = performance.now();
  if (
    !entered ||
    !gunOut() ||
    chatPanel.open ||
    connectPanel.open ||
    playground?.replaying ||
    plane.aboard ||
    now < nextShot
  )
    return;
  nextShot = now + SHOT_INTERVAL;
  worldAudio.unlock();
  if (
    !presence.shoot({
      yaw: view.yaw,
      pitch: view.pitch,
      kingScale: kingMode ? kingScale : 1,
    }) &&
    soloCrown
  ) {
    const { path, sharkHit } = traceShot(
      { ...view, y: view.y - EYE_HEIGHT, id: 1 },
      { type: 'shoot', yaw: view.yaw, pitch: view.pitch, kingScale },
      [],
      renderer?.obstacles ?? [],
      {
        day: plotDay(Date.now()),
        stationCount: notices.length,
        drops: [...worldPosts.values()].map(({ drop, landedAt }) => ({
          id: drop.id,
          x: drop.x,
          z: drop.z,
          floor: drop.y,
          landedAt,
        })),
        shark: soloShark?.pose,
      },
    );
    if (sharkHit) soloShark?.shoot();
    showGunshot(path, true, undefined, sharkHit);
  }
}

function showGunshot(
  path: ShotPath | undefined,
  ownShot: boolean,
  line?: number,
  sharkHit = false,
) {
  shotEffects.push({ at: performance.now() / 1000, path, ownShot });
  worldAudio.playShot(line, sharkHit);
  if (isPostMark(path?.postMark)) {
    updatePostMarks([...postMarks.slice(1 - POST_MARK_LIMIT), path.postMark]);
  }
}

function jumpOnce() {
  if (
    !playground?.replaying &&
    !plane.aboard &&
    entered &&
    !chatPanel.open &&
    !connectPanel.open
  ) {
    player.jump(performance.now(), kingMode);
  }
}

document.addEventListener('mousemove', (event) => {
  if (document.pointerLockElement !== world && !dragging) return;
  if (dragging) dragDistance += Math.hypot(event.movementX, event.movementY);
  controls.run(
    'look',
    event.movementX * POINTER_DEGREES,
    -event.movementY * POINTER_DEGREES,
  );
});
window.addEventListener('keydown', (event) => {
  if (entered && event.isTrusted) worldAudio.unlock();
  if (openingReply && event.code === 'KeyR' && event.repeat) {
    event.preventDefault();
    return;
  }
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.target === welcomeName ||
    chatPanel.open ||
    connectPanel.open
  )
    return;
  if (
    event.target instanceof HTMLElement &&
    (event.target.closest('input, textarea, [contenteditable]') ||
      ((event.key === 'Enter' || event.code === 'Space') &&
        event.target.closest('button, a')))
  )
    return;
  if (event.key === 'Enter') {
    event.preventDefault();
    if (!event.repeat) void controls.run('chat');
    return;
  }
  if (entered && kingMode && event.code === 'KeyK') {
    event.preventDefault();
    if (!event.repeat) controls.run('size');
    return;
  }
  if (entered && event.code === 'Space') {
    event.preventDefault();
    if (!event.repeat) {
      controls.run('ascend', true);
      controls.run('jump');
    }
    return;
  }
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
    keys.add(event.code);
    controls.run('sprint', true);
    return;
  }
  if (boat.available && event.code === 'KeyF') {
    event.preventDefault();
    if (!event.repeat) controls.run('boat');
    return;
  }
  if (plane.available && event.code === 'KeyG') {
    event.preventDefault();
    if (!event.repeat) controls.run('plane');
    return;
  }
  if (focusedNotice && ['KeyE', 'KeyR', 'KeyT', 'KeyL'].includes(event.code)) {
    event.preventDefault();
    if (event.repeat) return;
    if (event.code === 'KeyE')
      controls.run('page', event.shiftKey ? 'previous' : 'next');
    if (event.code === 'KeyR') {
      openingReply = true;
      controls.run('reply');
    }
    if (event.code === 'KeyT') controls.run('thread');
    if (event.code === 'KeyL') void controls.run('like');
    return;
  }
  if (!renderer || !movement.includes(event.code)) return;
  event.preventDefault();
  if (!keys.has(event.code)) {
    keys.add(event.code);
    moveWithKeys();
  }
});
window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') controls.run('ascend', false);
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
    keys.delete(event.code);
    controls.run('sprint', keys.has('ShiftLeft') || keys.has('ShiftRight'));
    return;
  }
  if (event.code === 'KeyR') openingReply = false;
  if (keys.delete(event.code)) moveWithKeys();
});

function moveWithKeys() {
  controls.run(
    'move',
    Number(keys.has('KeyW')) - Number(keys.has('KeyS')),
    Number(keys.has('KeyD')) - Number(keys.has('KeyA')),
    Number(keys.has('ArrowRight')) - Number(keys.has('ArrowLeft')),
    Number(keys.has('ArrowUp')) - Number(keys.has('ArrowDown')),
    0,
  );
}

function canUseVehicles() {
  return (
    entered && !chatPanel.open && !connectPanel.open && !playground?.replaying
  );
}

const boat = bindBoat(
  player,
  game,
  () => !plane.aboard && canUseVehicles(),
  () => touchControls('boat'),
);
const plane = bindSeaplane(
  player,
  game,
  () => !boat.aboard && canUseVehicles(),
  () => touchControls('plane'),
  (amount) => touchControls('plane-pitch', amount),
  announce,
);
const map = element<HTMLCanvasElement>('minimap');
const mapContext = map.getContext('2d');
function makeChart(
  { minX, maxX, minZ, maxZ }: typeof ISLAND_BOUNDS,
  ocean: boolean,
) {
  const canvas = document.createElement('canvas');
  canvas.width = map.width;
  canvas.height = map.height;
  const base = canvas.getContext('2d');
  const scale = Math.min(
    (map.width - 14) / (maxX - minX),
    (map.height - 14) / (maxZ - minZ),
  );
  const x = (minX + maxX - map.width / scale) / 2;
  const z = (minZ + maxZ - map.height / scale) / 2;
  if (!base) return { canvas, scale, x, z };

  for (let py = 0; py < map.height; py++) {
    for (let px = 0; px < map.width; px++) {
      const wx = px / scale + x;
      const wz = py / scale + z;
      const land = ground(wx, wz);
      const n = noise(px, py);
      base.fillStyle =
        land < 2
          ? inWorld(wx, wz)
            ? n > 0.84
              ? '#2f514e'
              : '#284843'
            : '#1d3432'
          : !ocean && trailDistance(wx, wz) < 1.25
            ? '#9b8350'
            : land % 4 === 1
              ? '#586047'
              : `hsl(73 20% ${24 + land * 0.55 + n * 5}%)`;
      base.fillRect(px, py, 1, 1);
    }
  }

  for (const landmark of LANDMARKS) {
    const px = Math.round((landmark.x - x) * scale);
    const pz = Math.round((landmark.z - z) * scale);
    base.fillStyle = '#d9dac6';
    base.fillRect(px - 1, pz, 3, 1);
    base.fillRect(px, pz - 1, 1, 3);
  }
  if (!ocean) {
    base.fillStyle = '#ac8554';
    base.fillRect(
      (DOCK.start - x) * scale,
      (DOCK.z - DOCK.halfWidth - z) * scale,
      (DOCK.end - DOCK.start) * scale,
      DOCK.halfWidth * 2 * scale,
    );
  }
  return { canvas, scale, x, z };
}

const coastChart = makeChart(ISLAND_BOUNDS, false);
const oceanChart = makeChart(
  { minX: MIN_X, maxX: MAX_X, minZ: MIN_Z, maxZ: MAX_Z },
  true,
);
let chart = coastChart;
const chartName = element('chart-name');
const chartPostLegend = element('chart-post-legend');

const coordinates = element('coordinates');
const compassTrack = element('compass-track');
const ticks = Array.from({ length: 24 }, (_, index) => {
  const mark = document.createElement('span');
  mark.textContent = ['N', 'E', 'S', 'W'][index / 6] ?? '';
  mark.classList.toggle('cardinal', !!mark.textContent);
  compassTrack.append(mark);
  return mark;
});

function drawHud(avatars: readonly Avatar[] = [], shark?: SharkPose) {
  const current = `${Math.floor(view.x)} / ${Math.floor(view.z)}`;
  if (coordinates.textContent !== current) coordinates.textContent = current;
  const bearing = ((((view.yaw * 180) / Math.PI) % 360) + 360) % 360;
  for (const [index, mark] of ticks.entries()) {
    const angle = ((index * 15 - bearing + 540) % 360) - 180;
    mark.style.left = `${119 + angle * 2.55}px`;
    mark.hidden = Math.abs(angle) > 53;
  }
  if (!mapContext) return;
  const coastX = (view.x - coastChart.x) * coastChart.scale;
  const coastZ = (view.z - coastChart.z) * coastChart.scale;
  const margin = chart === coastChart ? 8 : 14;
  const nearCoast =
    coastX >= margin &&
    coastX <= map.width - margin &&
    coastZ >= margin &&
    coastZ <= map.height - margin;
  const nextChart = nearCoast ? coastChart : oceanChart;
  if (nextChart !== chart) {
    chart = nextChart;
    chartName.textContent = nearCoast ? 'COAST MAP' : 'OCEAN MAP';
    chartPostLegend.hidden = !nearCoast;
  }
  const { canvas, scale: mapScale, x: mapX, z: mapZ } = chart;
  mapContext.drawImage(canvas, 0, 0);
  if (nearCoast) {
    mapContext.fillStyle = '#ffca78';
    const postLocations = STATIONS.slice(0, notices.length).map(([x, z]) => ({
      x,
      z,
    }));
    for (const { drop } of worldPosts.values()) postLocations.push(drop);
    for (const { x, z } of postLocations) {
      mapContext.fillRect(
        Math.round((x - mapX) * mapScale) - 1,
        Math.round((z - mapZ) * mapScale) - 1,
        3,
        3,
      );
    }
  }
  for (const avatar of avatars) {
    const tint = COATS[coatIndex(avatar.id)].map((channel) =>
      Math.round(channel * 255),
    );
    const x = Math.round((avatar.x - mapX) * mapScale);
    const y = Math.round((avatar.z - mapZ) * mapScale);
    mapContext.fillStyle = '#172820';
    mapContext.fillRect(x - 2, y - 2, 5, 5);
    mapContext.fillStyle = `rgb(${tint.join(',')})`;
    mapContext.fillRect(x - 1, y - 1, 3, 3);
  }
  mapContext.fillStyle = '#a7d8d0';
  for (const { x, z } of [boat.pose, plane.pose]) {
    mapContext.fillRect(
      Math.round((x - mapX) * mapScale) - 1,
      Math.round((z - mapZ) * mapScale) - 1,
      3,
      3,
    );
  }
  if (shark) {
    const x = Math.round((shark.x - mapX) * mapScale);
    const z = Math.round((shark.z - mapZ) * mapScale);
    mapContext.fillStyle = '#321d19';
    mapContext.fillRect(x - 2, z - 2, 5, 5);
    mapContext.fillStyle = '#ed855d';
    mapContext.fillRect(x - 1, z - 1, 3, 3);
  }
  mapContext.save();
  mapContext.translate(
    Math.round((view.x - mapX) * mapScale),
    Math.round((view.z - mapZ) * mapScale),
  );
  mapContext.rotate(view.yaw);
  mapContext.beginPath();
  mapContext.moveTo(0, -6);
  mapContext.lineTo(4, 4);
  mapContext.lineTo(0, 2);
  mapContext.lineTo(-4, 4);
  mapContext.closePath();
  mapContext.fillStyle = '#fff3d6';
  mapContext.strokeStyle = '#182017';
  mapContext.lineWidth = 2;
  mapContext.stroke();
  mapContext.fill();
  mapContext.restore();
}

function start() {
  try {
    renderer = createRenderer(world);
    renderer.setStations(notices.map((notice) => notice.canvas));
    renderer.setPostMarks(postMarks, plotDay(Date.now()));
  } catch (error) {
    console.error(error);
    element('welcome-copy').textContent = 'This browser could not start WebGL.';
    element<HTMLButtonElement>('enter-world').disabled = true;
    drawHud();
    return;
  }
  if (!isPlayground) restorePlacements();
  let previous = performance.now();
  function frame(time: number) {
    requestAnimationFrame(frame);
    if (!renderer) return;
    if (worldPosts.size) prunePlacements(Date.now());
    const dt = Math.min(0.05, (time - previous) / 1000);
    previous = time;
    const exploring = entered && !chatPanel.open && !connectPanel.open;
    const crown = updateCrown(time);
    if (touchShoot.hidden === gunOut()) touchShoot.hidden = !gunOut();
    const collisions = {
      obstacles: renderer.obstacles,
      stationCount: notices.length,
    };
    const movementInput = exploring
      ? {
          ...controls.movement(time),
          ascend: kingMode && controls.ascending,
          sprint: controls.sprinting,
          king: kingMode,
        }
      : undefined;
    boat.follow(presence.vehicle('boat', time));
    plane.follow(presence.vehicle('plane', time));
    const flying = plane.step(dt, movementInput, collisions.obstacles);
    const boating = boat.step(dt, movementInput);
    if (
      !flying &&
      !boating &&
      (!exploring || !playground?.step(time, collisions, kingMode))
    ) {
      player.step(time, dt, movementInput, collisions);
    }
    if (soloShark) {
      const walkers =
        boat.aboard || plane.aboard
          ? []
          : [{ id: 1, x: view.x, y: view.y - EYE_HEIGHT, z: view.z }];
      if (soloShark.step(dt, walkers).length) respawnPlayer(0, 'shark');
    }
    const shark = soloShark?.pose ?? presence.shark(time);
    worldAudio.setSharkInWater(
      entered && shark?.inWater === true && !shark.dying,
    );
    const extraEyeHeight = kingMode ? EYE_HEIGHT * (kingScale - 1) : 0;
    const camera = plane.aboard
      ? plane.camera()
      : { ...view, y: view.y + extraEyeHeight };
    const seconds = time / 1000;
    if (shotEffects.length)
      shotEffects = shotEffects.filter(
        ({ at }) => seconds - at < SHOT_EFFECT_DURATION,
      );
    const reading = exploring && !boat.aboard && !plane.aboard;
    const noticeIndex = reading ? facingNotice(camera, notices.length) : -1;
    focusNotice(
      reading
        ? (facingPlacement(camera, seconds) ?? notices[noticeIndex])
        : undefined,
    );
    const avatars = presence.avatars(time);
    for (const avatar of avatars) {
      if (avatar.name && avatar.name === avatarName)
        avatar.name = `${avatar.name} · #${avatar.id}`;
    }
    setPlayerPose(
      entered && !boat.aboard && !plane.aboard
        ? { x: view.x, y: view.y - EYE_HEIGHT, z: view.z, yaw: view.yaw }
        : undefined,
    );
    renderer.draw(
      camera,
      seconds,
      avatars,
      [...worldPosts.values()].map(({ drop }) => drop),
      crown,
      entered && gunOut() && !plane.aboard,
      boat.pose,
      plane.pose,
      shark,
      shotEffects,
      currentProps(),
    );
    drawHud(avatars, shark);
  }
  requestAnimationFrame(frame);
}

async function boot() {
  if (import.meta.env.DEV && import.meta.env.MODE === 'playground') {
    const { setupPlayground } = await import('./playground');
    playground = setupPlayground(player, game, controls.run);
    welcomeIdentity.hidden = true;
    connectIdentity.hidden = true;
    thread.hidden = true;
    refresh.disabled = true;
    element('welcome-copy').textContent =
      'Explore with a sample Harbor feed. Find the crown to become King for one minute.';
    markNetwork('loading', 'PLAYGROUND', 'Waiting for the sample feed');
  }
  start();
  if (shouldRejoinWorld()) enter(false);
  if (import.meta.env.DEV && import.meta.env.MODE === 'playground') {
    const { connectControlBridge } = await import('./control-bridge');
    connectControlBridge(controls);
  }
  void loadPosts();
}

watchWorldUpdates(() => entered);
void boot();

window.addEventListener('pagehide', () => {
  soloCrown = undefined;
  soloShark = undefined;
});
window.setInterval(retryPlacements, 1500);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) retryPlacements();
});
window.setInterval(() => {
  if (entered && !document.hidden) void loadPosts();
}, 12_000);
