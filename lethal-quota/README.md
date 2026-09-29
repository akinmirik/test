# Lethal Quota

A browser-based, multiplayer co-op horror scrap-salvage game with **proximity voice chat**, inspired by *Lethal Company*. You don't install anything: open the page, host a crew, and send your friends the invite link.

This is a fan-made homage. All code, models (procedural low-poly), textures (canvas-generated) and sounds (Web Audio synthesis) are original. It ships no assets from the original game.

## Quick start

```bash
cd lethal-quota
npm install
npm start            # http://localhost:3000
```

Open `http://localhost:3000`, enter a name, press **Host new crew**, then press **Esc → Copy invite link** and send it to friends. Up to 8 players per crew.

> **Microphones need HTTPS.** Browsers only allow mic access on `https://` or `localhost`. To play with friends over the internet, put the server behind HTTPS. You can use a reverse proxy, a tunnel such as `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`, or serve TLS directly:
>
> ```bash
> SSL_KEY=key.pem SSL_CERT=cert.pem npm start
> ```

## The game loop

1. **In orbit**, use the ship **terminal** (`MOONS`, `ROUTE <moon>`, `STORE`, `BUY <item> [n]`, `SCAN`, `QUOTA`, `TRANSMIT <msg>`, `CREW`). Then pull the **lever** to land.
2. **On the moon**, walk to the facility's main entrance (or find the fire exit) and head into the dark procedurally generated interior.
3. **Collect scrap.** You have 4 inventory slots, and weight slows you down. Some items are two-handed. Right-click scans for scrap values and nearby creatures.
4. **Bring it back** and drop it inside the ship. Leave with the lever before **midnight**, when the autopilot takes off without you. Anyone who isn't on board is left behind. If the whole crew dies, the day's scrap is lost.
5. Every **3 days** is a deadline. Route to **00-Company** and sell scrap at the desk. The buying rate rises as the deadline gets closer (100% on the day itself). Meet the quota to get an overtime bonus and a bigger quota. Miss it and you're **fired**, which resets the run.

### Creatures

| Creature | Behaviour |
|---|---|
| **Springhead** | Only moves when nobody is looking at it. Very fast. Keep eyes on it. |
| **Lurker** | Stalks you from behind. Look at it and it retreats, but stare too often and it gets angry. |
| **Crawler** | Charges when it sees you and speeds up the longer it chases. |
| **Hoarder bug** | Collects scrap into a nest. Take from its nest (or hit it) and it attacks. |
| **Blind dog** | Roams outside at night. It's blind but hears footsteps, sprinting, walkie chatter **and your real voice**. |

Equipment: flashlight, pro-flashlight, walkie-talkie, shovel (melee), stun grenade.

## Proximity voice chat

- Every player has a WebRTC audio connection to every other player (a mesh), signalled through the game's WebSocket server.
- Each remote voice goes through a Web Audio `PannerNode` (HRTF) placed on that player's head. Voices come from where the player is and fade out after about 20–32 m. You can't hear people on the other side of the facility's walls: inside and outside are separate areas.
- **Walkie-talkies**: hold LMB with a powered walkie to transmit. Anyone carrying a powered walkie hears you through a band-limited, distorted "radio" filter, wherever they are.
- **The dead** hear the living around the player they spectate, and can talk freely with other dead players. The living can't hear the dead. Text chat follows the same rule.
- Your mic level is sent to the server as "noise", which is what blind dogs listen for. Stay quiet outside at night.
- Settings (Esc): push-to-talk (hold **V**), mute (**M**), mic selection, voice volume. **Use headphones** to avoid echo.
- Voice uses public STUN servers by default. For players behind strict NATs, configure a TURN server:

  ```bash
  ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]' npm start
  ```

## Controls

| Key | Action |
|---|---|
| WASD + mouse | Move / look |
| Shift / C / Space | Sprint / crouch (toggle) / jump |
| E | Interact / pick up |
| G | Drop held item |
| 1–4, mouse wheel | Switch slot |
| LMB | Use item (toggle light, swing shovel, hold to talk on walkie, throw grenade) |
| RMB | Scan |
| V / M | Push-to-talk / mute |
| T or Enter | Text chat |
| Tab | Crew list (voice connection status, ping) |
| Esc | Menu & settings |

## Architecture

```
server/index.js   HTTP static server + WebSocket (rooms, joining, voice signalling relay)
server/game.js    Authoritative room simulation @20 Hz: day/quota loop, items, monster AI, terminal
shared/config.js  Constants: moons, store, scrap, monsters
shared/world.js   Deterministic world generation (facility grid, terrain, obstacles), collision,
                  line of sight, A* pathfinding. Used by BOTH server and client.
public/js/        Three.js client: main.js (game loop, input, HUD), scene.js (world meshes & lighting),
                  models.js (procedural models), voice.js (WebRTC + spatial audio), sfx.js (synth SFX)
test/smoke.js     Headless tests of world gen and the full game loop
```

- The server sends only the moon index and a seed. Both sides run `buildWorld()` to get identical facilities and terrain, so level data never goes over the network.
- Player movement is client-predicted and sent at 20 Hz. The server owns health, inventories, items, monsters, the clock and the economy, and broadcasts snapshots at 20 Hz (about 15 KB/s per client).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `SSL_KEY`, `SSL_CERT` | none | Serve HTTPS directly |
| `ICE_SERVERS` | Google STUN | JSON array of WebRTC ICE servers (add TURN here) |
| `LQ_MINUTE_SECONDS` | `0.75` | Real seconds per in-game minute (a day lasts 12 min) |
| `LQ_DEBUG` | off | `1` enables terminal cheats: `SPAWN <monster>`, `TIME <hour>` |

## Tests

```bash
npm test
```
