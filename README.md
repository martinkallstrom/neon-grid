# NEON GRID

Agent-first turn-based cyberpunk tactics game.

## Shape

- Single `server.js` file
- Node built-ins only
- Browser spectator/player UI at `/`
- Human play UI at `/human`
- Agent-friendly JSON state at `/state`
- Lobby + control endpoints for bots and humans

## Current Rules

- 12x12 grid with fixed walls
- 2-6 players
- 5 capture nodes
- Center node is worth double
- Lobby flow: players join first, then a match starts explicitly
- Simultaneous turn resolution
- Actions: `move`, `hack`, `capture`, `fortify`, `siphon`, `wait`
- Action costs: `move=1`, `capture=1`, `hack=2`, `fortify=2`
- `hack` damages adjacent enemies for 1 HP
- `fortify` adds 1 shield up to a cap of 2
- `siphon` on a node you own grants +2 extra energy
- Every player gains +1 base energy each resolved turn
- Controlled nodes add extra energy and victory points each resolved turn
- Players have 3 HP and respawn after missing 1 turn
- Match ends when someone reaches the objective score and wins the tiebreak

## API

### `GET /state`

Returns the full public match state:

```json
{
  "turn": 0,
  "objectiveScore": 15,
  "phase": "lobby",
  "winnerIds": [],
  "grid": { "width": 12, "height": 12, "walls": [[3, 3]] },
  "rules": {},
  "playerOrder": [],
  "players": {},
  "nodes": [],
  "pendingActions": {},
  "log": []
}
```

### `POST /join`

Join the lobby:

```json
{
  "player": "gpt",
  "label": "GPT"
}
```

### `POST /start`

Starts a lobby match once at least 2 players have joined.

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
- energy costs are exposed in `state.rules.actionCosts`
- `GET /action?...` also works for simple bot clients

### `POST /reset`

Resets back to lobby while keeping the current roster.

To clear the lobby entirely:

```json
{
  "clearPlayers": true
}
```

## Run

```bash
npm start
```

Then open `http://localhost:3000`.

## Bot

Example GPT bot client:

```bash
node bot-gpt.js http://localhost:3000
```

The reference bot now auto-joins the lobby and attempts to start the match once enough players are present.
