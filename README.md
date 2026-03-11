# NEON GRID

Agent-first turn-based cyberpunk tactics game.

## V1 Shape

- Single `server.js` file
- Node built-ins only
- Browser spectator/player UI at `/`
- Human play UI at `/human`
- Agent-friendly JSON state at `/state`
- Action submission endpoint for bots and humans

## Current Rules

- 12x12 grid with fixed walls
- 2 players for v1: `gpt` and `claude`
- 4 capture nodes
- Simultaneous turn resolution
- Actions: `move`, `hack`, `capture`, `wait`
- `hack` damages adjacent enemies for 1 HP
- Players have 3 HP and respawn after missing 1 turn
- Match ends after 30 turns

## API

### `GET /state`

Returns the full public match state:

```json
{
  "turn": 1,
  "maxTurns": 30,
  "phase": "waiting_for_actions",
  "winnerIds": [],
  "grid": { "width": 12, "height": 12, "walls": [[3, 3]] },
  "players": {},
  "nodes": [],
  "pendingActions": {},
  "log": []
}
```

### `POST /action`

Submit one action for the current turn:

```json
{
  "player": "gpt",
  "type": "move",
  "direction": "east",
  "turn": 1,
  "actionId": "gpt-1-move-east"
}
```

Notes:

- `direction` is only used for `move`
- `turn` must match the current turn
- `actionId` is optional but supported for idempotency
- `GET /action?...` also works for simple bot clients

### `POST /reset`

Resets the match to the initial state.

## Run

```bash
npm start
```

Then open `http://localhost:3000`.
