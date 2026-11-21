# Harbor Overworld

Live Harbor posts appear on wooden noticeboards. Posts and replies published
from Overworld also drop as Harbor post cards at your position. Step back to
read the card, reply, or open the thread. Everyone in the room sees the fall
and its landing coordinates on screen. The card disappears after one minute.

Walk with WASD, look with the mouse, jump with Space, turn pages with E, reply
with R, and open chat with Enter. On a touchscreen, use the joystick to move,
drag the scene to look, and tap Jump or Chat. The fullscreen button appears
when your browser supports fullscreen.

Follow the coast east of the spawn point to find the dock. Press **F** or tap
**Board boat** to get aboard. Hold **W** to accelerate, use **S** to brake
and reverse, and steer with **A/D**. The touch joystick does the same.
Press **F** or tap **Leave boat** to get out. Everyone in the room sees
where the boat and seaplane move and where they are parked. You can travel
all the way around the island. The map zooms out offshore to show the full
ocean and its navigable limits.

Follow the trail south from the harbor to loop through the stone arch or
take the coastal fork to the lookout beacon. Both routes have noticeboard
sites, and pale crosses on the minimap mark the landmarks.

The seaplane is moored on the other side of the dock. Press **G** or tap
**Board seaplane**. Hold **W** and **↑** to take off, use **A/D** to turn,
and use **↓** to pitch down. Release the yoke to hold your angle, or keep
pulling up to loop once you have altitude. Keep holding **W** to accelerate.
Use **S** to brake, or keep holding it on water to reverse. Press **G** to
leave once stopped. On touchscreens, use the joystick for throttle and
steering, and hold **Climb** or **Descend** for pitch.

Hold **Shift** or the touch **Sprint** button while moving. Players sprint at
twice walking speed, and the King sprints at eight times walking speed.

The land shark stays in the sea and chases swimmers at 1.5× walking speed.
Its orange marker shows on the map, and its splashing is audible anywhere in
the room while it swims. Contact sends you back to harbor spawn. The King can
shoot it and the shark screams before respawning offshore.

Every respawn, from the shark or a King's shot, lands at a random spot within
3.5 blocks of harbor spawn.

Follow the gold beacon and walk into the crown to become King for one
minute. The room shows who is King and how much time remains. The crown
appears at a random spot along an island trail and respawns when the minute
ends or the King leaves the room. A temporary disconnect keeps the original
countdown. While crowned,
press **K** or tap **Size** to cycle your size. Hold **Space** or **Rise**
to ascend and release it to fall. Aim with the crosshair and left-click or
tap **Shoot**. A hit sends the other player back to their harbor spawn.
Everyone in the room hears shots and hit reactions from anywhere on the map.
Shooting a noticeboard or a landed post leaves a mark that other players
can see.
The [sound effects credits](public/sounds/CREDITS.txt) include the original
Wilhelm scream.

## Run locally

Download the [release archive](https://github.com/SomewhatJustin/harbor-overworld/releases/latest/download/harbor-overworld.tar.gz)
into your current directory. Extract it and start a loopback-only server with
Python 3.

```sh
mkdir -p harbor-overworld-local
tar -xzf harbor-overworld.tar.gz -C harbor-overworld-local
python3 -m http.server 4173 --bind 127.0.0.1 --directory harbor-overworld-local
```

Open [http://127.0.0.1:4173/](http://127.0.0.1:4173/) in a browser.
Live posts and identity pairing still use the Harbor production network.
Press Ctrl+C in the terminal to stop the server.

## Playground

Run the [source setup](#build-from-source) once, then start Vite and the local
room from the checkout root.

```sh
pnpm --filter harbor-overworld playground --open '/?scene=noticeboard'
```

Enter the world to read a sample post from the second feed page. Use the
scene menu to spawn at the shoreline, a tree, or a ledge. Use **Replay** to run
the same recorded inputs as the movement tests. For a King jump replay,
enter and find the crown to start the recorded jumps. Open **Join in
another tab** and enter in both tabs to check movement and crown pickup. The sample Like
button stores its state in the current tab.

Open `/?scene=shooting` to practice. The playground puts the crown just
ahead of spawn and a practice target farther down the trail.

Open `/?scene=seaplane` to start beside the parked seaplane.

```sh
pnpm --filter harbor-overworld test:movement
pnpm --filter harbor-overworld test:presence
node --test --test-name-pattern=shoreline apps/harbor-overworld/src/world/movement.test.mjs
node apps/harbor-overworld/scripts/check-live.mjs http://127.0.0.1:5173 --room-only
```

### Control the playground from a CLI

Open a playground tab at [http://127.0.0.1:5173/?control=player](http://127.0.0.1:5173/?control=player).
The `control` query value names the tab. Use a distinct name for each tab
you want to control, and include `--tab NAME` when several are connected.
Keep the tab selected while moving so the browser continues running frames.

```sh
pnpm --filter harbor-overworld control help
pnpm --filter harbor-overworld control tabs
pnpm --filter harbor-overworld control enter
pnpm --filter harbor-overworld control move 1 0 0 0 1000
pnpm --filter harbor-overworld control look 90 0
pnpm --filter harbor-overworld control status
```

In the seaplane scene, use `control plane` to board or leave. The fourth
axis of `control move` controls pitch while flying.

`move` sets forward, sideways, turn, and look axes in the range −1 to 1.
Its final argument is a duration in milliseconds. A zero duration holds
the axes until another `move` or `stop`. Commands such as `boat`, `size`,
and `shoot` follow the same availability as the on-screen controls. To
target a different port, put `--url http://127.0.0.1:PORT` before the
command. Fullscreen and audio may need an initial click in the tab.

While crowned, use `ascend true` to rise and `ascend false` to release.

## Test multiplayer locally

Build the workspace dependencies and Overworld using the source commands
below, then start the local preview.

```sh
pnpm --filter harbor-overworld preview --host 127.0.0.1 --port 4173 --strictPort
```

Open `http://127.0.0.1:4173/` in two desktop browser windows and select
**Enter world** in both. Both windows should show **2 players online**.
Walk in one window to see its avatar move in the other. Everyone who enters
the same preview joins one room of up to 32 players.

The presence server keeps up to 16 production posts on shared noticeboards,
which clear at 3 a.m. Central. Posts made in Overworld stay at their landing
coordinates for one minute. The public Harbor posts stay in their threads.
The standalone presence server saves the room state to a temporary file by default. Set
`OVERWORLD_PLOTS_FILE` to a writable path on a persistent volume to keep
them across container replacements.

## Deploy the release on your hardware

1. Download [harbor-overworld.tar.gz](https://github.com/SomewhatJustin/harbor-overworld/releases/latest/download/harbor-overworld.tar.gz).
   Extract it into a dedicated web root. The archive has `index.html`,
   `assets/`, and `licenses.txt` at its root.

   ```sh
   curl -fL https://github.com/SomewhatJustin/harbor-overworld/releases/latest/download/harbor-overworld.tar.gz -o /tmp/harbor-overworld.tar.gz
   mkdir -p /srv/harbor-overworld
   tar -xzf /tmp/harbor-overworld.tar.gz -C /srv/harbor-overworld
   ```

2. Serve that directory at the root of an HTTPS hostname. Point the hostname at
   the host and use the existing HTTPS server if available. A minimal Caddy
   configuration looks like this. Replace the hostname with your own.

   ```caddyfile
   play.example.com {
       root * /srv/harbor-overworld
       encode zstd gzip
       file_server
   }
   ```

3. Open the HTTPS URL in a desktop browser. The indicator in the top right
   should show **PRODUCTION** and a live post count. Check that **Connect Harbor
   identity** opens the pairing dialog. Close it, select **Enter world**, and
   walk toward a lantern to read its noticeboard. Share the root URL.

Visitors can explore as guests, pick a display name to create an identity,
or connect using a pairing link or code from their Harbor app. They approve the browser in Harbor. A backup file also works.
The browser saves the connected identity for this hostname. All Harbor traffic
goes directly from the browser to the production network. The host serves only
static files.

## Production multiplayer

Use the site archive and presence ZIP from the **same** GitHub release or
`overworld-release` Actions artifact. Serve the site as above. Extract the
presence ZIP outside the web root and run `node server.mjs` under a service
supervisor with Node 22. No package install is needed. Each process hosts
one in-memory room; run one instance and keep TCP 8080 private.

To route shared noticeboard feeds through private proxies, set
`OVERWORLD_FEED_BASE_URLS` on the presence process to a comma-separated list of
base URLs, one origin per proxy with no path prefix. Each proxy must accept
`POST /polycentric.v2.FeedsService/GetExploreFeed`. If unset or blank, the
presence server uses the public Harbor and Polycentric origins. This setting
does not change browser traffic.

The server listens on `0.0.0.0:8080`. Check it locally with
`curl -fsS http://127.0.0.1:8080/healthz`. Add this directive inside the
site's Caddy block (or use the equivalent WebSocket proxy on your server):

```caddyfile
reverse_proxy /presence 127.0.0.1:8080
```

Forward the query string, upgrade headers, original Host and Origin. Clients
connect through the site's HTTPS hostname, not directly to port 8080. Open
two windows and confirm movement as in the local multiplayer check above.

## Release workflow

A push to the public fork's `overworld` branch builds and tests once, then
publishes the packaged artifacts. A manually dispatched build produces the
same archives for inspection. The host can continue fetching the latest
published release.

For immediate rollout, set the Actions repository variable
`OVERWORLD_DEPLOY_URL` to your deploy receiver's HTTPS URL and store its
bearer token in `OVERWORLD_DEPLOY_TOKEN`. The receiver gets a POST with the
release tag in `X-Overworld-Release` and the contents of `build.json`. Handle
retries by commit SHA. Download both archives by tag and switch the static
directory only after extraction succeeds. Retain the prior directory and
server bundle for rollback. Compare the new manifest's `presenceSha256` to
the installed bundle's SHA-256 and restart presence only when it changes.

Each release gives the room server a new build hash, so the deployment
restarts it even when the only changes are in the browser. Open game tabs
check `/build.json` and reload when the commit changes. Players who already
entered rejoin at spawn.

The verification job checks the live `/build.json` commit and then joins two
clients to confirm they see the same room and receive populated noticeboards.
Set `OVERWORLD_SITE` if the live hostname changes.

## Build from source

Use the repository's Node and pnpm versions and the
[Rust/WASM toolchain](../../docs/content/developer/setup.md). From the fork root:

```sh
pnpm install --filter harbor-overworld... --frozen-lockfile
pnpm --filter @polycentric/rs-core-wasm build --profile wasm-release
pnpm --filter @polycentric/js-core generate
pnpm --filter @polycentric/js-core build
pnpm --filter @polycentric/js-browser build
pnpm --filter harbor-overworld typecheck
pnpm --filter harbor-overworld build
```

The static output is `apps/harbor-overworld/dist/`. Use
`pnpm --filter harbor-overworld preview` to preview that build locally.

Harbor Overworld modifies the Harbor web client for a noncommercial game.
The release includes the [app license](../LICENSE.md) and
[repository and SDK license](../../LICENSE) in `licenses.txt`.
