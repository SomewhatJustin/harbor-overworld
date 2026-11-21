import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { HttpServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { BUILD_COMMIT } from '../src/world/build.ts';
import { createCrown } from '../src/world/crown.ts';
import { createLandShark } from '../src/world/land-shark.ts';
import { EYE_HEIGHT, spawnView } from '../src/world/movement.ts';
import { POST_MARK_LIMIT, type PostMark } from '../src/world/post-marks.ts';
import {
  displayName,
  HIT_LINES,
  isPlacement,
  isPose,
  isShoot,
  parseMessage,
  PRESENCE_INTERVAL,
  PRESENCE_PATH,
  type NamedPose,
  type Player,
  type PresenceMessage,
  readChat,
  readKingScale,
  readVehicleReport,
  type Respawn,
  ROOM_CAPACITY,
  SHOT_INTERVAL,
  type Shoot,
} from '../src/world/presence-protocol.ts';
import {
  ground,
  makeTerrain,
  type Obstacle,
  WATER,
} from '../src/world/terrain.ts';
import {
  type RoomVehicles,
  VEHICLE_BERTHS,
  VEHICLE_KINDS,
} from '../src/world/vehicles.ts';
import { inventoryRoomForPresence } from '../src/blort/server/inventory-room.ts';
import { createPlots, type PlotFeed } from './plots.ts';
import { traceShot } from '../src/world/shot-trace.ts';

const IDLE_MS = 20_000;
const MAX_QUEUED_BYTES = 64 * 1024;
const PRACTICE_ID = Number.MAX_SAFE_INTEGER;
const PRACTICE_CROWN_SITES = [
  { x: 0.5, z: 15.5 },
  { x: -3.5, z: 14.5 },
  { x: 4.5, z: 18.5 },
];
const PRACTICE_TARGET_SITES = [
  { x: 0.5, z: 9.9 },
  { x: -2.5, z: 11.5 },
  { x: 3.5, z: 11.5 },
];

type Client = {
  ws: WebSocket;
  id: number;
  slot: number;
  pose?: NamedPose;
  updatedAt: number;
  nextPlacement: number;
  nextShot: number;
  spawnRevision: number;
  respawnPending?: Respawn;
};

function sameHost(request: IncomingMessage) {
  try {
    const origin = new URL(request.headers.origin ?? '');
    return (
      (origin.protocol === 'https:' || origin.protocol === 'http:') &&
      origin.host === request.headers.host
    );
  } catch {
    return false;
  }
}

export function attachPresence(
  http: HttpServer,
  plotsFile?: string,
  feed?: PlotFeed,
  practice = false,
) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const clients = new Map<string, Client>();
  const vehicles: RoomVehicles = {
    boat: { pose: VEHICLE_BERTHS.boat },
    plane: { pose: VEHICLE_BERTHS.plane },
  };

  function releaseVehicles(driver: number) {
    for (const kind of VEHICLE_KINDS) {
      const vehicle = vehicles[kind];
      if (vehicle.driver === driver) {
        vehicles[kind] = {
          pose: vehicle.pose.y > WATER ? VEHICLE_BERTHS[kind] : vehicle.pose,
        };
      }
    }
  }

  let detachedKing: { session: string; id: number; name?: string } | undefined;
  let nextId = 1;
  const marks: PostMark[] = [];
  const shark = createLandShark();
  const crown = createCrown(practice ? PRACTICE_CROWN_SITES : undefined);
  let shotObstacles: readonly Obstacle[] | undefined;
  let practiceTargetIndex = 0;
  const inventory = inventoryRoomForPresence(plotsFile, practice, (socket) => {
    for (const { ws, pose } of clients.values()) if (ws === socket) return pose;
    return undefined;
  });

  function practiceTarget(): Player {
    const { x, z } = PRACTICE_TARGET_SITES[practiceTargetIndex];
    return {
      id: PRACTICE_ID,
      x,
      y: ground(x, z),
      z,
      yaw: Math.PI,
      name: 'Practice target',
      practice: true,
    };
  }

  function broadcast(snapshot: PresenceMessage) {
    const message = JSON.stringify(snapshot);
    for (const { ws } of clients.values())
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
  }
  const plots = createPlots(
    plotsFile,
    broadcast,
    (day, post) => {
      broadcast({ type: 'placements', day, posts: [post], live: true });
    },
    feed ? [feed] : undefined,
  );

  function playersWithPoses(): Player[] {
    return [...clients.values()].flatMap(({ id, pose, ws }) =>
      pose
        ? [
            {
              id,
              ...pose,
              ...(inventory.isArmed(ws) && { armed: true as const }),
            },
          ]
        : [],
    );
  }

  function retainReign(session: string, client: Client) {
    const state = crown.state;
    if ('holder' in state && state.holder === client.id) {
      detachedKing = { session, id: client.id, name: client.pose?.name };
    }
  }

  function shoot(client: Client, aim: Shoot, now: number) {
    const state = crown.state;
    const king =
      'holder' in state && state.holder === client.id && now < state.expiresAt;
    if (
      !client.pose ||
      !(king || inventory.isArmed(client.ws)) ||
      now < client.nextShot
    )
      return;
    // Only the King shoots from a giant's height.
    if (!king) aim = { ...aim, kingScale: 1 };
    client.nextShot = now + SHOT_INTERVAL;
    shotObstacles ??= makeTerrain().obstacles;
    const players = playersWithPoses();
    if (practice) players.push(practiceTarget());
    const { posts } = plots.placements();
    const plot = plots.snapshot();
    const { path, target, sharkHit } = traceShot(
      { ...client.pose, id: client.id },
      aim,
      players,
      shotObstacles,
      {
        day: plot?.day,
        stationCount: plot?.papers.length ?? 0,
        drops: posts,
        shark: shark.pose,
      },
    );
    if (path.postMark) {
      marks.push(path.postMark);
      if (marks.length > POST_MARK_LIMIT) marks.shift();
    }
    const shot = {
      type: 'gunshot' as const,
      shooter: client.id,
      path,
      sharkHit,
    };
    if (sharkHit) {
      shark.shoot();
      broadcast(shot);
      return;
    }
    const line = Math.floor(Math.random() * HIT_LINES.length);
    if (practice && target === PRACTICE_ID) {
      practiceTargetIndex =
        (practiceTargetIndex + 1) % PRACTICE_TARGET_SITES.length;
      broadcast({ ...shot, hit: { id: PRACTICE_ID, line } });
      return;
    }
    const victim = [...clients.values()].find((peer) => peer.id === target);
    if (!victim?.pose) {
      broadcast(shot);
      return;
    }
    broadcast({
      ...shot,
      hit: { id: victim.id, line, respawn: respawn(victim, victim.pose) },
    });
  }

  function respawn(client: Client, pose: NamedPose, cause?: Respawn['cause']) {
    const { x, y, z, yaw } = spawnView(client.slot);
    client.pose = { ...pose, x, y: y - EYE_HEIGHT, z, yaw };
    releaseVehicles(client.id);
    const respawn = {
      id: client.id,
      slot: client.slot,
      spawnRevision: ++client.spawnRevision,
      cause,
    };
    client.respawnPending = respawn;
    return respawn;
  }

  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const [path, query] = (request.url ?? '').split('?');
    if (path !== PRESENCE_PATH) return;
    const session = new URLSearchParams(query).get('session');
    if (!session || !/^[a-f0-9]{32}$/.test(session)) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!sameHost(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const previous = clients.get(session);
    if (!previous && clients.size >= ROOM_CAPACITY) {
      socket.end(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    server.handleUpgrade(request, socket, head, (ws) => {
      const occupied = new Set(
        [...clients.values()].map((client) => client.slot),
      );
      let slot = 0;
      while (occupied.has(slot)) slot++;
      const now = performance.now();
      const reign = crown.state;
      const returningKing =
        detachedKing?.session === session &&
        'holder' in reign &&
        reign.holder === detachedKing.id &&
        now < reign.expiresAt
          ? detachedKing
          : undefined;
      if (returningKing) detachedKing = undefined;
      const client: Client = {
        ws,
        id: previous?.id ?? returningKing?.id ?? nextId++,
        slot: previous?.slot ?? slot,
        pose: previous?.pose,
        updatedAt: now,
        nextPlacement: 0,
        nextShot: 0,
        spawnRevision: previous?.respawnPending ? previous.spawnRevision : 0,
        respawnPending: previous?.respawnPending,
      };
      clients.set(session, client);
      if (previous) previous.ws.close(4001, 'Connection replaced');
      ws.on('error', () => ws.terminate());
      ws.on('close', (code) => {
        inventory.disconnect(ws);
        if (clients.get(session) !== client) return;
        clients.delete(session);
        releaseVehicles(client.id);
        if (code === 1000 || code === 1005)
          crown.release(client.id, playersWithPoses());
        else retainReign(session, client);
      });
      ws.on('message', (data, binary) => {
        if (binary || clients.get(session) !== client) return;
        const now = performance.now();
        const message = parseMessage(data.toString());
        if (inventory.receive(ws, message)) return;
        if (isShoot(message)) {
          shoot(client, message, now);
          return;
        }
        if (isPlacement(message)) {
          if (now < client.nextPlacement) return;
          client.nextPlacement = now + 1000;
          const post = plots.place(message);
          if (post) {
            const { day } = plots.placements();
            ws.send(
              JSON.stringify({
                type: 'placements',
                day,
                posts: [post],
                live: false,
              }),
            );
          }
          return;
        }
        if (client.pose && now - client.updatedAt < PRESENCE_INTERVAL / 2)
          return;
        if (!isPose(message)) return;
        if (
          client.spawnRevision &&
          (!('spawnRevision' in message) ||
            message.spawnRevision !== client.spawnRevision)
        )
          return;
        client.respawnPending = undefined;
        const { x, y, z, yaw } = message;
        client.pose = {
          x,
          y,
          z,
          yaw,
          name: 'name' in message ? displayName(message.name) : undefined,
          chat: 'chat' in message ? readChat(message.chat) : undefined,
          kingScale:
            'kingScale' in message
              ? readKingScale(message.kingScale)
              : undefined,
        };
        client.updatedAt = now;
        const report =
          'vehicle' in message ? readVehicleReport(message.vehicle) : undefined;
        if (report?.driving && vehicles[report.kind].driver === client.id) {
          vehicles[report.kind] = { pose: report.pose, driver: client.id };
          return;
        }
        if (
          report &&
          !report.driving &&
          vehicles[report.kind].driver === client.id
        )
          vehicles[report.kind] = { pose: report.pose };
        releaseVehicles(client.id);
        if (report?.driving && vehicles[report.kind].driver === undefined)
          vehicles[report.kind] = { pose: report.pose, driver: client.id };
      });
      const welcome: PresenceMessage = {
        type: 'welcome',
        commit: BUILD_COMMIT || undefined,
        id: client.id,
        slot: client.slot,
        respawn: client.respawnPending,
      };
      ws.send(JSON.stringify(welcome));
      const { day, posts } = plots.placements();
      const plotState = plots.snapshot();
      if (plotState) ws.send(JSON.stringify(plotState));
      const activeDrops = new Set<string>();
      for (const post of posts) {
        activeDrops.add(post.id);
        ws.send(
          JSON.stringify({
            type: 'placements',
            day,
            posts: [post],
            live: false,
          }),
        );
      }
      ws.send(
        JSON.stringify({
          type: 'post-marks',
          marks: marks.filter((mark) =>
            mark.kind === 'board' ? mark.day === day : activeDrops.has(mark.id),
          ),
        } satisfies PresenceMessage),
      );
    });
  }

  http.on('upgrade', upgrade);
  let lastTick = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const seconds = Math.min(0.2, (now - lastTick) / 1000);
    lastTick = now;
    for (const [session, client] of clients) {
      const { ws } = client;
      if (
        now - client.updatedAt > IDLE_MS ||
        ws.bufferedAmount > MAX_QUEUED_BYTES
      ) {
        clients.delete(session);
        releaseVehicles(client.id);
        retainReign(session, client);
        ws.terminate();
      }
    }

    if (!clients.size) return;
    const potentialVictims = playersWithPoses().filter(
      ({ id }) => !VEHICLE_KINDS.some((kind) => vehicles[kind].driver === id),
    );
    const victims = shark.step(seconds, potentialVictims);
    for (const client of clients.values()) {
      if (client.pose && victims.includes(client.id)) {
        broadcast({
          type: 'shark-hit',
          respawn: respawn(client, client.pose, 'shark'),
        });
      }
    }
    const players = playersWithPoses();
    crown.update(now, players);
    const state = crown.state;
    if (
      detachedKing &&
      (!('holder' in state) || state.holder !== detachedKing.id)
    )
      detachedKing = undefined;
    for (const player of players) {
      if ('holder' in state && player.id === state.holder) {
        player.king = true;
        player.kingScale = readKingScale(player.kingScale);
      } else {
        delete player.kingScale;
      }
    }
    if (practice) players.push(practiceTarget());
    broadcast({
      type: 'players',
      players,
      vehicles,
      shark: shark.pose,
      crown:
        'location' in state
          ? state.location
          : {
              holder: state.holder,
              remainingMs: state.expiresAt - now,
              name:
                players.find((player) => player.id === state.holder)?.name ??
                detachedKing?.name,
            },
    });
  }, PRESENCE_INTERVAL);
  timer.unref();

  http.once('close', () => {
    clearInterval(timer);
    plots.close();
    void inventory.close();
    http.off('upgrade', upgrade);
    for (const { ws } of clients.values()) ws.terminate();
    clients.clear();
    server.close();
  });
}
