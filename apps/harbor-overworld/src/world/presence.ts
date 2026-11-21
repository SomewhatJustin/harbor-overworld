import {
  CROWN_DURATION,
  type CrownLocation,
  displayName,
  HIT_LINES,
  isPose,
  isVehiclePose,
  isShotPath,
  isPlacedPost,
  parseMessage,
  PRESENCE_INTERVAL,
  PRESENCE_PATH,
  type NamedPose,
  type PlotSnapshot,
  type Placement,
  type PlacementUpdate,
  type Pose,
  type Respawn,
  type ChatPost,
  readChat,
  readKingScale,
  type KingScale,
  ROOM_CAPACITY,
  type Shoot,
  type ShotPath,
} from './presence-protocol';
import type { PlanePose } from './flight';
import type { SharkPose } from './land-shark';
import { isPostMark, POST_MARK_LIMIT, type PostMark } from './post-marks';
import {
  VEHICLE_KINDS,
  type Vehicle,
  type VehicleKind,
  type VehicleReport,
} from './vehicles';
import { inventoryLink } from '../blort/inventory/link';

export type Avatar = NamedPose & {
  id: number;
  walking: boolean;
  king?: true;
  armed?: true;
};
export type LocalCrown =
  | { location: CrownLocation }
  | { expiresAt: number; holderName?: string };

type VehicleTrack = {
  from: PlanePose;
  to: Vehicle;
  receivedAt: number;
};

type Track = {
  from: Pose;
  name?: string;
  chat?: ChatPost;
  to: Pose;
  receivedAt: number;
  walking: boolean;
  king?: true;
  armed?: true;
  kingScale?: KingScale;
};

function interpolationProgress(receivedAt: number, now: number) {
  return Math.min(1, Math.max(0, (now - receivedAt) / PRESENCE_INTERVAL));
}

function interpolateAngle(first: number, last: number, t: number) {
  return first + Math.atan2(Math.sin(last - first), Math.cos(last - first)) * t;
}

function interpolate<T extends Pose>(
  { from, to, receivedAt }: { from: T; to: T; receivedAt: number },
  now: number,
) {
  const t = interpolationProgress(receivedAt, now);
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: from.z + (to.z - from.z) * t,
    yaw: interpolateAngle(from.yaw, to.yaw, t),
  };
}

function interpolateVehicle(
  { from, to, receivedAt }: VehicleTrack,
  now: number,
) {
  return {
    ...interpolate({ from, to: to.pose, receivedAt }, now),
    pitch: interpolateAngle(
      from.pitch,
      to.pose.pitch,
      interpolationProgress(receivedAt, now),
    ),
  };
}

function isPlayerId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSlot(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < ROOM_CAPACITY
  );
}

const SESSION_KEY = 'harbor-overworld.presence-session';

function tabSession() {
  const fresh = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (value) => value.toString(16).padStart(2, '0'),
  ).join('');
  try {
    const navigation = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    // A reload can replace its old socket, while another tab joins separately.
    const previous =
      navigation?.type === 'reload'
        ? sessionStorage.getItem(SESSION_KEY)
        : null;
    const session =
      previous && /^[a-f0-9]{32}$/.test(previous) ? previous : fresh;
    sessionStorage.setItem(SESSION_KEY, session);
    return session;
  } catch {
    return fresh;
  }
}

export function createPresence(
  readPose: () => NamedPose & { vehicle?: VehicleReport },
  onJoin: (slot: number) => void,
  onStatus: (label: string, solo: boolean) => void,
  onPlots: (snapshot: PlotSnapshot) => void,
  onPlacements: (update: PlacementUpdate) => void,
  onPostMarks: (marks: PostMark[]) => void,
  onCrown: (crown: LocalCrown | undefined) => void,
  onGunshot: (
    path: ShotPath,
    ownShot: boolean,
    line?: number,
    sharkHit?: boolean,
  ) => void,
  onRespawn: (slot: number, cause?: Respawn['cause']) => void,
) {
  const session = tabSession();
  const tracks = new Map<number, Track>();
  const vehicleTracks = new Map<VehicleKind, VehicleTrack>();
  let sharkTrack: { from: Pose; to: SharkPose; receivedAt: number } | undefined;
  let socket: WebSocket | undefined;
  let sendTimer = 0;
  let reconnectTimer = 0;
  let attempts = 0;
  let started = false;
  let available = false;
  let id: number | undefined;
  let spawnRevision = 0;
  let lastStatus = '';

  function status(value: string, solo = false) {
    if (lastStatus === value) return;
    lastStatus = value;
    onStatus(value, solo);
  }

  function sendPose(connection: WebSocket) {
    if (
      connection.readyState !== WebSocket.OPEN ||
      connection.bufferedAmount > 1024
    )
      return;
    const { x, y, z, yaw, name, chat, kingScale, vehicle } = readPose();
    connection.send(
      JSON.stringify({
        x,
        y,
        z,
        name,
        chat,
        kingScale,
        vehicle,
        spawnRevision,
        yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)),
      }),
    );
  }

  function respawn(value: unknown) {
    if (
      !value ||
      typeof value !== 'object' ||
      !('id' in value) ||
      value.id !== id ||
      !('slot' in value) ||
      !isSlot(value.slot) ||
      !('spawnRevision' in value) ||
      typeof value.spawnRevision !== 'number' ||
      !Number.isSafeInteger(value.spawnRevision) ||
      value.spawnRevision <= spawnRevision
    )
      return false;
    spawnRevision = value.spawnRevision;
    onRespawn(
      value.slot,
      'cause' in value && value.cause === 'shark' ? 'shark' : undefined,
    );
    return true;
  }

  function open() {
    if (socket) return;
    const url = new URL(PRESENCE_PATH, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('session', session);
    const connection = new WebSocket(url);
    socket = connection;
    status(available ? 'Reconnecting…' : 'Joining room…');

    connection.addEventListener('message', ({ data }) => {
      if (socket !== connection || typeof data !== 'string') return;
      const message = parseMessage(data);
      if (inventoryLink.receive(message)) return;
      if (!message || typeof message !== 'object' || !('type' in message))
        return;

      if (
        message.type === 'welcome' &&
        id === undefined &&
        'id' in message &&
        isPlayerId(message.id) &&
        'slot' in message &&
        isSlot(message.slot)
      ) {
        id = message.id;
        attempts = 0;
        if (
          !respawn('respawn' in message ? message.respawn : undefined) &&
          !available
        )
          onJoin(message.slot);
        available = true;
        inventoryLink.attach(connection);
        status('1 player online');
        sendPose(connection);
        sendTimer = window.setInterval(
          () => sendPose(connection),
          PRESENCE_INTERVAL,
        );
        return;
      }

      if (
        id !== undefined &&
        message.type === 'shark-hit' &&
        'respawn' in message
      ) {
        const update = message.respawn;
        if (
          update &&
          typeof update === 'object' &&
          'id' in update &&
          isPlayerId(update.id)
        )
          tracks.delete(update.id);
        if (respawn(update)) sendPose(connection);
        return;
      }

      if (
        id !== undefined &&
        message.type === 'gunshot' &&
        'shooter' in message &&
        isPlayerId(message.shooter) &&
        'path' in message &&
        isShotPath(message.path)
      ) {
        const hit = 'hit' in message ? message.hit : undefined;
        let line: number | undefined;
        if (
          hit &&
          typeof hit === 'object' &&
          'id' in hit &&
          isPlayerId(hit.id)
        ) {
          tracks.delete(hit.id);
          if (
            'line' in hit &&
            typeof hit.line === 'number' &&
            Number.isInteger(hit.line) &&
            hit.line >= 0 &&
            hit.line < HIT_LINES.length
          )
            line = hit.line;
          if (hit.id === id && 'respawn' in hit && respawn(hit.respawn))
            sendPose(connection);
        }
        onGunshot(
          message.path,
          message.shooter === id,
          line,
          'sharkHit' in message && message.sharkHit === true,
        );
        return;
      }

      if (
        id !== undefined &&
        message.type === 'post-marks' &&
        'marks' in message &&
        Array.isArray(message.marks)
      ) {
        onPostMarks(message.marks.filter(isPostMark).slice(-POST_MARK_LIMIT));
        return;
      }

      if (
        message.type === 'placements' &&
        'day' in message &&
        typeof message.day === 'string' &&
        'posts' in message &&
        Array.isArray(message.posts)
      ) {
        onPlacements({
          type: 'placements',
          day: message.day,
          posts: message.posts.filter(isPlacedPost),
          live:
            'live' in message && typeof message.live === 'boolean'
              ? message.live
              : undefined,
        });
        return;
      }
      if (
        message.type === 'plots' &&
        'day' in message &&
        typeof message.day === 'string' &&
        'papers' in message &&
        Array.isArray(message.papers)
      ) {
        onPlots({
          type: 'plots',
          day: message.day,
          papers: message.papers.filter(
            (paper): paper is string => typeof paper === 'string',
          ),
        });
        return;
      }

      if (
        id === undefined ||
        message.type !== 'players' ||
        !('players' in message) ||
        !Array.isArray(message.players)
      )
        return;
      const now = performance.now();
      if (
        'shark' in message &&
        isPose(message.shark) &&
        'walking' in message.shark &&
        typeof message.shark.walking === 'boolean' &&
        'inWater' in message.shark &&
        typeof message.shark.inWater === 'boolean' &&
        'dying' in message.shark &&
        typeof message.shark.dying === 'boolean'
      ) {
        const to = {
          ...message.shark,
          walking: message.shark.walking,
          inWater: message.shark.inWater,
          dying: message.shark.dying,
        };
        sharkTrack = {
          from:
            sharkTrack &&
            Math.hypot(to.x - sharkTrack.to.x, to.z - sharkTrack.to.z) < 3
              ? interpolate(sharkTrack, now)
              : to,
          to,
          receivedAt: now,
        };
      }
      if (
        'vehicles' in message &&
        message.vehicles &&
        typeof message.vehicles === 'object'
      ) {
        const vehicles = message.vehicles as Partial<
          Record<VehicleKind, unknown>
        >;
        for (const kind of VEHICLE_KINDS) {
          const value = vehicles[kind];
          if (
            !value ||
            typeof value !== 'object' ||
            !('pose' in value) ||
            !isVehiclePose(value.pose)
          )
            continue;
          const driver =
            'driver' in value && isPlayerId(value.driver)
              ? value.driver
              : undefined;
          const previous = vehicleTracks.get(kind);
          vehicleTracks.set(kind, {
            from:
              previous && driver === previous.to.driver
                ? interpolateVehicle(previous, now)
                : value.pose,
            to: { pose: value.pose, driver },
            receivedAt: now,
          });
        }
      }
      const crown = 'crown' in message ? message.crown : undefined;
      if (
        crown &&
        typeof crown === 'object' &&
        'x' in crown &&
        typeof crown.x === 'number' &&
        Number.isFinite(crown.x) &&
        'z' in crown &&
        typeof crown.z === 'number' &&
        Number.isFinite(crown.z)
      ) {
        onCrown({ location: { x: crown.x, z: crown.z } });
      } else if (
        crown &&
        typeof crown === 'object' &&
        'holder' in crown &&
        isPlayerId(crown.holder) &&
        'remainingMs' in crown &&
        typeof crown.remainingMs === 'number' &&
        crown.remainingMs > 0 &&
        crown.remainingMs <= CROWN_DURATION
      ) {
        const holder = message.players.find(
          (player) =>
            player && typeof player === 'object' && player.id === crown.holder,
        );
        onCrown({
          expiresAt: now + crown.remainingMs,
          holderName:
            crown.holder === id
              ? undefined
              : (displayName('name' in crown ? crown.name : holder?.name) ??
                `Player ${crown.holder}`),
        });
      } else {
        onCrown(undefined);
      }
      const present = new Set<number>();
      let online = 1;
      for (const player of message.players) {
        if (
          !isPose(player) ||
          !('id' in player) ||
          !isPlayerId(player.id) ||
          player.id === id
        )
          continue;
        const previous = tracks.get(player.id);
        const distance = previous
          ? Math.hypot(player.x - previous.to.x, player.z - previous.to.z)
          : 0;
        const from =
          previous && distance < 6 ? interpolate(previous, now) : player;
        const king = 'king' in player && player.king === true;
        present.add(player.id);
        if (!('practice' in player && player.practice === true)) online++;
        tracks.set(player.id, {
          from,
          to: player,
          name: 'name' in player ? displayName(player.name) : undefined,
          chat: 'chat' in player ? readChat(player.chat) : undefined,
          king: king ? true : undefined,
          armed: 'armed' in player && player.armed === true ? true : undefined,
          kingScale:
            king && 'kingScale' in player
              ? readKingScale(player.kingScale)
              : undefined,
          receivedAt: now,
          walking: distance > 0.02 && distance < 6,
        });
      }
      for (const playerId of tracks.keys()) {
        if (!present.has(playerId)) tracks.delete(playerId);
      }
      status(online === 1 ? '1 player online' : `${online} players online`);
    });

    connection.addEventListener('close', ({ code }) => {
      if (socket !== connection) return;
      const reconnect = available && code !== 4001;
      reset(reconnect);
      if (!reconnect) {
        status('Solo play', true);
        return;
      }
      status('Reconnecting…');
      const delay = Math.min(15_000, 600 * 2 ** attempts++);
      reconnectTimer = window.setTimeout(open, delay);
    });
  }

  function reset(preserveCrown = false) {
    inventoryLink.detach();
    socket = undefined;
    id = undefined;
    spawnRevision = 0;
    if (!preserveCrown) onCrown(undefined);
    clearInterval(sendTimer);
    clearTimeout(reconnectTimer);
    tracks.clear();
    vehicleTracks.clear();
    sharkTrack = undefined;
  }

  window.addEventListener('pagehide', () => {
    const connection = socket;
    reset();
    connection?.close(1000);
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && started) open();
  });

  return {
    shoot(aim: Omit<Shoot, 'type'>) {
      if (id === undefined || socket?.readyState !== WebSocket.OPEN)
        return false;
      const yaw = Math.atan2(Math.sin(aim.yaw), Math.cos(aim.yaw));
      socket.send(JSON.stringify({ ...aim, type: 'shoot', yaw }));
      return true;
    },
    place(placement: Placement) {
      if (id === undefined || socket?.readyState !== WebSocket.OPEN)
        return false;
      socket.send(JSON.stringify(placement));
      return true;
    },
    join() {
      if (started) return;
      started = true;
      open();
    },
    shark(now: number): SharkPose | undefined {
      if (sharkTrack)
        return {
          ...interpolate(sharkTrack, now),
          walking: sharkTrack.to.walking,
          inWater: sharkTrack.to.inWater,
          dying: sharkTrack.to.dying,
        };
    },
    vehicle(kind: VehicleKind, now: number): Vehicle | undefined {
      const track = vehicleTracks.get(kind);
      if (track && (track.to.driver === undefined || track.to.driver !== id)) {
        return {
          pose: interpolateVehicle(track, now),
          driver: track.to.driver,
        };
      }
    },
    avatars(now: number): Avatar[] {
      return [...tracks.entries()].map(([id, track]) => ({
        id,
        walking: track.walking,
        name: track.name,
        chat: track.chat,
        king: track.king,
        armed: track.armed,
        kingScale: track.kingScale,
        ...interpolate(track, now),
      }));
    },
  };
}
