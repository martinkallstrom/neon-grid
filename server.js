const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);
const OBJECTIVE_SCORE = 15;
const MAX_LOG_ENTRIES = 120;
const STARTING_ENERGY = 3;
const SIPHON_GAIN = 2;
const SHIELD_CAP = 2;
const DIRECTIONS = {
  north: { x: 0, y: -1, label: "North" },
  south: { x: 0, y: 1, label: "South" },
  west: { x: -1, y: 0, label: "West" },
  east: { x: 1, y: 0, label: "East" }
};
const ACTION_TYPES = new Set(["move", "hack", "capture", "fortify", "siphon", "wait"]);
const ACTION_COSTS = {
  move: 1,
  capture: 1,
  hack: 2,
  fortify: 2,
  siphon: 0,
  wait: 0
};
const PLAYER_ORDER = ["gpt", "claude"];
const PLAYER_TEMPLATES = {
  gpt: {
    id: "gpt",
    label: "GPT",
    color: "#00f5ff",
    accent: "#7df9ff",
    start: { x: 0, y: 0 }
  },
  claude: {
    id: "claude",
    label: "Claude",
    color: "#ff4fd8",
    accent: "#ff9bf0",
    start: { x: 11, y: 11 }
  }
};
const WALLS = [
  [3, 3], [3, 4], [4, 3],
  [8, 8], [8, 7], [7, 8],
  [5, 5], [6, 5], [5, 6], [6, 6],
  [1, 8], [10, 3]
];
const NODE_POSITIONS = [
  { id: "n1", x: 2, y: 2, value: 1 },
  { id: "n2", x: 9, y: 2, value: 1 },
  { id: "n3", x: 2, y: 9, value: 1 },
  { id: "n4", x: 9, y: 9, value: 1 },
  { id: "core", x: 6, y: 4, value: 2 }
];

let state = createInitialState();

function createInitialState() {
  const players = {};
  for (const id of PLAYER_ORDER) {
    const template = PLAYER_TEMPLATES[id];
    players[id] = {
      id: template.id,
      label: template.label,
      color: template.color,
      accent: template.accent,
      start: { ...template.start },
      pos: { ...template.start },
      hp: 3,
      maxHp: 3,
      respawnIn: 0,
      capturedNodes: 0,
      score: 0,
      victoryPoints: 0,
      energy: STARTING_ENERGY,
      income: 0,
      shields: 0,
      damageDealt: 0,
      alive: true,
      lastAction: null
    };
  }

  const nodes = NODE_POSITIONS.map((node) => ({ ...node, owner: null }));

  return {
    turn: 1,
    objectiveScore: OBJECTIVE_SCORE,
    phase: "waiting_for_actions",
    winnerIds: [],
    grid: {
      width: 12,
      height: 12,
      walls: WALLS.map(([x, y]) => [x, y])
    },
    rules: {
      actionCosts: { ...ACTION_COSTS },
      siphonGain: SIPHON_GAIN,
      shieldCap: SHIELD_CAP,
      objectiveScore: OBJECTIVE_SCORE,
      income: "Players gain energy and victory points equal to controlled node value after each resolved turn."
    },
    players,
    nodes,
    pendingActions: {},
    log: [
      {
        turn: 1,
        playerId: "system",
        type: "boot",
        summary: "NEON GRID initialized"
      }
    ]
  };
}

function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

  if (req.method === "OPTIONS") {
    return withCors(res, 204).end();
  }

  if (req.method === "GET" && url.pathname === "/") {
    return html(res, page());
  }

  if (req.method === "GET" && url.pathname === "/human") {
    return html(res, humanPage());
  }

  if (req.method === "GET" && url.pathname === "/state") {
    return json(res, 200, publicState());
  }

  if ((req.method === "POST" || req.method === "GET") && url.pathname === "/action") {
    return readBody(req).then((body) => {
      const input = collectInput(url, body);
      const result = submitAction(input);
      return json(res, result.ok ? 200 : result.statusCode, result.body);
    }).catch((error) => {
      return json(res, 400, { error: error.message || "Invalid request body" });
    });
  }

  if ((req.method === "POST" || req.method === "GET") && url.pathname === "/reset") {
    state = createInitialState();
    appendLog({
      turn: state.turn,
      playerId: "system",
      type: "reset",
      summary: "Match reset"
    });
    return json(res, 200, { ok: true, state: publicState() });
  }

  return json(res, 404, { error: "Not found" });
}

function publicState() {
  return {
    turn: state.turn,
    objectiveScore: state.objectiveScore,
    phase: state.phase,
    winnerIds: state.winnerIds,
    grid: state.grid,
    rules: state.rules,
    players: state.players,
    nodes: state.nodes,
    pendingActions: state.pendingActions,
    log: state.log
  };
}

function collectInput(url, body) {
  return {
    player: body.player || url.searchParams.get("player"),
    type: body.type || url.searchParams.get("type"),
    direction: body.direction || body.dir || url.searchParams.get("direction") || url.searchParams.get("dir"),
    turn: body.turn || url.searchParams.get("turn"),
    actionId: body.actionId || url.searchParams.get("actionId") || url.searchParams.get("action_id")
  };
}

function submitAction(input) {
  if (state.phase === "game_over") {
    return {
      ok: false,
      statusCode: 409,
      body: { error: "Game is over. Reset to start a new match." }
    };
  }

  const playerId = String(input.player || "");
  const type = String(input.type || "").toLowerCase();
  const player = state.players[playerId];

  if (!player) {
    return { ok: false, statusCode: 400, body: { error: "Unknown player" } };
  }
  if (!ACTION_TYPES.has(type)) {
    return { ok: false, statusCode: 400, body: { error: "Unsupported action type" } };
  }
  if (!isActionablePlayer(player)) {
    return { ok: false, statusCode: 409, body: { error: "Player cannot act this turn" } };
  }

  const turn = Number(input.turn || state.turn);
  if (!Number.isInteger(turn) || turn !== state.turn) {
    return {
      ok: false,
      statusCode: 409,
      body: { error: `Action is for turn ${turn}; current turn is ${state.turn}` }
    };
  }

  let direction = null;
  if (type === "move") {
    direction = String(input.direction || "").toLowerCase();
    if (!DIRECTIONS[direction]) {
      return { ok: false, statusCode: 400, body: { error: "Invalid move direction" } };
    }
  }

  const cost = actionCost(type);
  if (player.energy < cost) {
    return {
      ok: false,
      statusCode: 409,
      body: { error: `${player.label} needs ${cost} energy for ${type} but only has ${player.energy}` }
    };
  }

  const existing = state.pendingActions[playerId];
  const nextAction = {
    turn,
    type,
    direction,
    actionId: String(input.actionId || `${playerId}-${turn}-${type}-${direction || "none"}`),
    submittedAt: new Date().toISOString()
  };

  if (existing && existing.actionId === nextAction.actionId) {
    return { ok: true, statusCode: 200, body: { ok: true, deduped: true, state: publicState() } };
  }

  state.pendingActions[playerId] = nextAction;
  player.lastAction = nextAction;
  appendLog({
    turn: state.turn,
    playerId,
    type: "submit_action",
    summary: `${player.label} locked in ${describeAction(nextAction)}`
  });

  if (readyToResolve()) {
    resolveTurn();
  }

  return { ok: true, statusCode: 200, body: { ok: true, state: publicState() } };
}

function readyToResolve() {
  const actionableIds = getActionablePlayerIds();
  return actionableIds.length > 0 && actionableIds.every((id) => Boolean(state.pendingActions[id]));
}

function getActionablePlayerIds() {
  return PLAYER_ORDER.filter((id) => isActionablePlayer(state.players[id]));
}

function isActionablePlayer(player) {
  return player && player.alive && player.respawnIn === 0;
}

function resolveTurn() {
  state.phase = "resolving";
  const turn = state.turn;
  const actions = {};
  const actionableIds = getActionablePlayerIds();
  const deadAtStart = new Set(
    PLAYER_ORDER.filter((id) => !state.players[id].alive && state.players[id].respawnIn > 0)
  );

  for (const id of actionableIds) {
    actions[id] = state.pendingActions[id] || defaultAction(id);
  }

  spendActionCosts(turn, actions, actionableIds);
  resolveMoves(turn, actions, actionableIds);
  resolveCaptures(turn, actions, actionableIds);
  resolveFortifies(turn, actions, actionableIds);
  resolveSiphons(turn, actions, actionableIds);
  resolveHacks(turn, actions, actionableIds);
  tickRespawns(turn, deadAtStart);
  updateCapturedNodeCounts();
  distributeEconomy(turn);

  state.pendingActions = {};

  if (finishGame(turn)) {
    return;
  }

  state.turn += 1;
  state.phase = "waiting_for_actions";
  advanceRespawnOnlyTurns();
}

function resolveMoves(turn, actions, actionableIds) {
  const attempted = {};
  const current = {};
  const blocked = new Set();
  const destinationCounts = new Map();

  for (const id of actionableIds) {
    current[id] = { ...state.players[id].pos };
    const action = actions[id];
    if (action.type !== "move") continue;
    const vector = DIRECTIONS[action.direction];
    const target = {
      x: current[id].x + vector.x,
      y: current[id].y + vector.y
    };
    if (!isWalkable(target)) {
      blocked.add(id);
      appendLog({
        turn,
        playerId: id,
        type: "blocked_move",
        summary: `${state.players[id].label} tried to move ${vector.label} into a wall`
      });
      continue;
    }
    attempted[id] = target;
    const key = posKey(target);
    destinationCounts.set(key, (destinationCounts.get(key) || 0) + 1);
  }

  for (const [id, target] of Object.entries(attempted)) {
    if (destinationCounts.get(posKey(target)) > 1) {
      blocked.add(id);
    }
  }

  for (let i = 0; i < actionableIds.length; i++) {
    for (let j = i + 1; j < actionableIds.length; j++) {
      const a = actionableIds[i];
      const b = actionableIds[j];
      if (!attempted[a] || !attempted[b]) continue;
      if (samePos(attempted[a], current[b]) && samePos(attempted[b], current[a])) {
        blocked.add(a);
        blocked.add(b);
      }
    }
  }

  for (const [id, target] of Object.entries(attempted)) {
    if (blocked.has(id)) {
      appendLog({
        turn,
        playerId: id,
        type: "move_cancelled",
        summary: `${state.players[id].label}'s move was cancelled by a collision`
      });
      continue;
    }
    state.players[id].pos = target;
    appendLog({
      turn,
      playerId: id,
      type: "move",
      summary: `${state.players[id].label} moved ${DIRECTIONS[actions[id].direction].label}`
    });
  }

  for (const id of actionableIds) {
    if (actions[id].type === "wait") {
      appendLog({
        turn,
        playerId: id,
        type: "wait",
        summary: `${state.players[id].label} held position`
      });
    }
  }
}

function resolveCaptures(turn, actions, actionableIds) {
  for (const id of actionableIds) {
    const action = actions[id];
    if (action.type !== "capture") continue;
    const player = state.players[id];
    const node = state.nodes.find((entry) => samePos(entry, player.pos));
    if (!node) {
      appendLog({
        turn,
        playerId: id,
        type: "capture_failed",
        summary: `${player.label} tried to capture empty ground`
      });
      continue;
    }
    if (node.owner === id) {
      appendLog({
        turn,
        playerId: id,
        type: "capture_hold",
        summary: `${player.label} reinforced node ${node.id}`
      });
      continue;
    }
    node.owner = id;
    appendLog({
      turn,
      playerId: id,
      type: "capture",
      summary: `${player.label} captured node ${node.id}${node.value > 1 ? ` (+${node.value})` : ""}`
    });
  }
}

function resolveFortifies(turn, actions, actionableIds) {
  for (const id of actionableIds) {
    const action = actions[id];
    if (action.type !== "fortify") continue;
    const player = state.players[id];
    const nextShields = Math.min(SHIELD_CAP, player.shields + 1);
    if (nextShields === player.shields) {
      appendLog({
        turn,
        playerId: id,
        type: "fortify_cap",
        summary: `${player.label} tried to fortify beyond the shield cap`
      });
      continue;
    }
    player.shields = nextShields;
    appendLog({
      turn,
      playerId: id,
      type: "fortify",
      summary: `${player.label} fortified to ${player.shields} shield`
    });
  }
}

function resolveSiphons(turn, actions, actionableIds) {
  for (const id of actionableIds) {
    const action = actions[id];
    if (action.type !== "siphon") continue;
    const player = state.players[id];
    const node = state.nodes.find((entry) => samePos(entry, player.pos));
    if (!node || node.owner !== id) {
      appendLog({
        turn,
        playerId: id,
        type: "siphon_failed",
        summary: `${player.label} tried to siphon without owning the node`
      });
      continue;
    }
    player.energy += SIPHON_GAIN;
    appendLog({
      turn,
      playerId: id,
      type: "siphon",
      summary: `${player.label} siphoned +${SIPHON_GAIN} energy from node ${node.id}`
    });
  }
}

function resolveHacks(turn, actions, actionableIds) {
  const damage = {};

  for (const id of actionableIds) {
    const action = actions[id];
    if (action.type !== "hack") continue;
    const player = state.players[id];
    const targets = actionableIds.filter((otherId) => {
      if (otherId === id) return false;
      const other = state.players[otherId];
      return other.alive && manhattan(player.pos, other.pos) === 1;
    });

    if (targets.length === 0) {
      appendLog({
        turn,
        playerId: id,
        type: "hack_whiff",
        summary: `${player.label} hacked empty air`
      });
      continue;
    }

    for (const targetId of targets) {
      damage[targetId] = (damage[targetId] || 0) + 1;
      state.players[id].damageDealt += 1;
      appendLog({
        turn,
        playerId: id,
        type: "hack",
        summary: `${player.label} hacked ${state.players[targetId].label}`
      });
    }
  }

  for (const [targetId, amount] of Object.entries(damage)) {
    const player = state.players[targetId];
    const absorbed = Math.min(player.shields, amount);
    const dealt = amount - absorbed;
    if (absorbed > 0) {
      player.shields -= absorbed;
      appendLog({
        turn,
        playerId: targetId,
        type: "shield_absorb",
        summary: `${player.label}'s shields absorbed ${absorbed} damage`
      });
    }
    if (dealt === 0) {
      continue;
    }
    player.hp -= dealt;
    appendLog({
      turn,
      playerId: targetId,
      type: "damage",
      summary: `${player.label} took ${dealt} damage`
    });
    if (player.hp <= 0) {
      player.hp = 0;
      player.alive = false;
      player.respawnIn = 1;
      player.shields = 0;
      appendLog({
        turn,
        playerId: targetId,
        type: "flatline",
        summary: `${player.label} flatlined and will respawn in 1 turn`
      });
    }
  }
}

function tickRespawns(turn, deadAtStart) {
  for (const id of deadAtStart) {
    const player = state.players[id];
    player.respawnIn = Math.max(0, player.respawnIn - 1);
    if (player.respawnIn === 0) {
      respawnPlayer(turn, player);
    }
  }
}

function advanceRespawnOnlyTurns() {
  while (state.phase !== "game_over" && getActionablePlayerIds().length === 0) {
    const waiting = PLAYER_ORDER.filter((id) => !state.players[id].alive && state.players[id].respawnIn > 0);
    if (waiting.length === 0) break;

    appendLog({
      turn: state.turn,
      playerId: "system",
      type: "cooldown_turn",
      summary: `Turn ${state.turn} skipped while operators were respawning`
    });

    for (const id of waiting) {
      const player = state.players[id];
      player.respawnIn = Math.max(0, player.respawnIn - 1);
      if (player.respawnIn === 0) {
        respawnPlayer(state.turn, player);
      }
    }

    state.turn += 1;
  }
}

function respawnPlayer(turn, player) {
  player.alive = true;
  player.hp = player.maxHp;
  player.shields = 0;
  player.pos = findSpawn(player.start);
  appendLog({
    turn,
    playerId: player.id,
    type: "respawn",
    summary: `${player.label} respawned`
  });
}

function findSpawn(preferred) {
  if (isWalkable(preferred) && !isOccupied(preferred)) {
    return { ...preferred };
  }

  for (let radius = 1; radius <= 12; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const candidate = { x: preferred.x + dx, y: preferred.y + dy };
        if (!isWalkable(candidate) || isOccupied(candidate)) continue;
        return candidate;
      }
    }
  }

  return { ...preferred };
}

function updateCapturedNodeCounts() {
  for (const id of PLAYER_ORDER) {
    state.players[id].capturedNodes = state.nodes.filter((node) => node.owner === id).length;
    state.players[id].score = state.nodes
      .filter((node) => node.owner === id)
      .reduce((sum, node) => sum + (node.value || 1), 0);
    state.players[id].income = state.players[id].score;
  }
}

function distributeEconomy(turn) {
  for (const id of PLAYER_ORDER) {
    const player = state.players[id];
    if (player.income > 0) {
      player.energy += player.income;
      player.victoryPoints += player.income;
      appendLog({
        turn,
        playerId: id,
        type: "income",
        summary: `${player.label} banked +${player.income} energy and +${player.income} VP`
      });
    }
  }
}

function finishGame(turn) {
  updateCapturedNodeCounts();
  const bestVp = Math.max(...PLAYER_ORDER.map((id) => state.players[id].victoryPoints));
  if (bestVp < state.objectiveScore) {
    return false;
  }

  let contenders = PLAYER_ORDER.filter((id) => state.players[id].victoryPoints === bestVp);
  if (contenders.length > 1) {
    const bestDamage = Math.max(...contenders.map((id) => state.players[id].damageDealt));
    contenders = contenders.filter((id) => state.players[id].damageDealt === bestDamage);
  }
  if (contenders.length !== 1) {
    return false;
  }

  state.winnerIds = contenders;
  state.phase = "game_over";
  appendLog({
    turn,
    playerId: "system",
    type: "game_over",
    summary: `${state.players[state.winnerIds[0]].label} wins the grid at ${bestVp} VP`
  });
  return true;
}

function defaultAction(playerId) {
  return {
    turn: state.turn,
    type: "wait",
    direction: null,
    actionId: `${playerId}-${state.turn}-wait`,
    submittedAt: new Date().toISOString()
  };
}

function appendLog(entry) {
  state.log.push(entry);
  if (state.log.length > MAX_LOG_ENTRIES) {
    state.log.splice(0, state.log.length - MAX_LOG_ENTRIES);
  }
}

function describeAction(action) {
  if (action.type === "move") {
    return `MOVE ${action.direction}`;
  }
  if (action.type === "fortify") {
    return "FORTIFY";
  }
  if (action.type === "siphon") {
    return "SIPHON";
  }
  return action.type.toUpperCase();
}

function actionCost(type) {
  return ACTION_COSTS[type] || 0;
}

function spendActionCosts(turn, actions, actionableIds) {
  for (const id of actionableIds) {
    const action = actions[id];
    const cost = actionCost(action.type);
    if (cost === 0) continue;
    state.players[id].energy = Math.max(0, state.players[id].energy - cost);
    appendLog({
      turn,
      playerId: id,
      type: "energy_spend",
      summary: `${state.players[id].label} spent ${cost} energy on ${action.type}`
    });
  }
}

function isWalkable(pos) {
  return inBounds(pos) && !isWall(pos);
}

function inBounds(pos) {
  return pos.x >= 0 && pos.y >= 0 && pos.x < state.grid.width && pos.y < state.grid.height;
}

function isWall(pos) {
  return state.grid.walls.some(([x, y]) => x === pos.x && y === pos.y);
}

function isOccupied(pos) {
  return PLAYER_ORDER.some((id) => {
    const player = state.players[id];
    return player.alive && samePos(player.pos, pos);
  });
}

function samePos(a, b) {
  return a.x === b.x && a.y === b.y;
}

function posKey(pos) {
  return `${pos.x},${pos.y}`;
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function withCors(res, statusCode) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  return res;
}

function json(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

function html(res, body) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  if (req.method !== "POST") return Promise.resolve({});
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Expected JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function page() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NEON GRID</title>
    <style>
      :root {
        --bg: #060812;
        --panel: rgba(12, 18, 34, 0.92);
        --panel-border: rgba(130, 154, 219, 0.16);
        --grid: #10192d;
        --line: rgba(64, 88, 142, 0.65);
        --cyan: #00f5ff;
        --cyan-soft: rgba(0, 245, 255, 0.18);
        --magenta: #ff4fd8;
        --magenta-soft: rgba(255, 79, 216, 0.18);
        --green: #5cff87;
        --amber: #ffd166;
        --red: #ff5c7a;
        --text: #d7e4ff;
        --muted: #91a0c7;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top, rgba(255,79,216,0.15), transparent 30%),
          radial-gradient(circle at right, rgba(0,245,255,0.12), transparent 28%),
          linear-gradient(180deg, #060812 0%, #080d18 100%);
      }
      main {
        max-width: 1240px;
        margin: 0 auto;
        padding: 28px 18px 48px;
      }
      .hero {
        display: flex;
        justify-content: space-between;
        gap: 18px;
        align-items: end;
        margin-bottom: 22px;
      }
      .hero h1 {
        margin: 0;
        font-size: clamp(2.4rem, 7vw, 4.8rem);
        line-height: 0.92;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .hero p {
        margin: 10px 0 0;
        max-width: 720px;
        color: var(--muted);
        font-size: 1rem;
      }
      .chipbar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .chip {
        border: 1px solid var(--panel-border);
        background: rgba(10, 15, 26, 0.85);
        border-radius: 999px;
        padding: 8px 12px;
        font-size: 0.86rem;
        color: var(--muted);
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(340px, 1.1fr) minmax(320px, 0.9fr);
        gap: 18px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 20px;
        overflow: hidden;
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.25);
      }
      .panel-head {
        padding: 16px 18px 0;
        font-size: 0.78rem;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .panel-body {
        padding: 18px;
      }
      canvas {
        width: 100%;
        aspect-ratio: 1;
        display: block;
        border-radius: 16px;
        background: linear-gradient(180deg, #0d1527 0%, #0a1221 100%);
      }
      .stack {
        display: grid;
        gap: 14px;
      }
      .stats {
        display: grid;
        gap: 10px;
      }
      .player-card {
        border: 1px solid var(--panel-border);
        border-radius: 14px;
        padding: 12px;
        background: rgba(10, 15, 26, 0.8);
      }
      .player-card strong {
        display: inline-block;
        margin-bottom: 4px;
      }
      .actions {
        display: grid;
        gap: 14px;
      }
      .action-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }
      button {
        border: 0;
        border-radius: 12px;
        padding: 11px 10px;
        font: inherit;
        cursor: pointer;
        color: #08111f;
        background: linear-gradient(135deg, #82f9ff, var(--cyan));
      }
      button.alt {
        background: linear-gradient(135deg, #ffd6fa, var(--magenta));
      }
      button.secondary {
        background: linear-gradient(135deg, #d4ffe0, var(--green));
      }
      button.ghost {
        background: rgba(17, 27, 47, 0.9);
        border: 1px solid var(--panel-border);
        color: var(--text);
      }
      button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
        filter: saturate(0.4);
      }
      .log {
        display: grid;
        gap: 8px;
        max-height: 320px;
        overflow: auto;
      }
      .log-entry {
        border-left: 3px solid rgba(130, 154, 219, 0.24);
        padding-left: 10px;
        color: var(--muted);
        font-size: 0.94rem;
      }
      .status {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 12px;
      }
      .status span {
        background: rgba(10, 15, 26, 0.84);
        border: 1px solid var(--panel-border);
        border-radius: 999px;
        padding: 7px 11px;
        color: var(--muted);
        font-size: 0.84rem;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        font-size: 0.76rem;
        line-height: 1.45;
        color: var(--muted);
      }
      @media (max-width: 980px) {
        .hero { flex-direction: column; align-items: start; }
        .layout { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div>
          <h1>Neon Grid</h1>
          <p>Agent-first cyberpunk tactics. Bots can read <code>/state</code>, submit to <code>/action</code>, and battle on a deterministic turn barrier.</p>
        </div>
        <div class="chipbar">
          <span class="chip">Node built-ins only</span>
          <span class="chip">Simultaneous turns</span>
          <span class="chip">HTTP-native control</span>
        </div>
      </section>

      <section class="layout">
        <article class="panel">
          <div class="panel-head">Arena</div>
          <div class="panel-body">
            <div class="status" id="status"></div>
            <canvas id="board" width="720" height="720"></canvas>
          </div>
        </article>

        <article class="panel">
          <div class="panel-head">Operations</div>
          <div class="panel-body stack">
            <div class="stats" id="players"></div>
            <div class="actions" id="controls"></div>
            <button class="ghost" id="reset">Reset Match</button>
            <div class="log" id="log"></div>
            <details>
              <summary>Raw state</summary>
              <pre id="dump"></pre>
            </details>
          </div>
        </article>
      </section>
    </main>
    <script>
      const canvas = document.getElementById("board");
      const ctx = canvas.getContext("2d");
      const statusEl = document.getElementById("status");
      const playersEl = document.getElementById("players");
      const controlsEl = document.getElementById("controls");
      const logEl = document.getElementById("log");
      const dumpEl = document.getElementById("dump");
      const resetEl = document.getElementById("reset");
      let lastState = null;

      async function api(path, options) {
        const response = await fetch(path, options);
        return response.json();
      }

      function cell(state) {
        return canvas.width / state.grid.width;
      }

      function draw(state) {
        const size = cell(state);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#0c1526";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.strokeStyle = "rgba(80,102,151,0.38)";
        ctx.lineWidth = 1;
        for (let x = 0; x <= state.grid.width; x++) {
          ctx.beginPath();
          ctx.moveTo(x * size, 0);
          ctx.lineTo(x * size, canvas.height);
          ctx.stroke();
        }
        for (let y = 0; y <= state.grid.height; y++) {
          ctx.beginPath();
          ctx.moveTo(0, y * size);
          ctx.lineTo(canvas.width, y * size);
          ctx.stroke();
        }

        ctx.fillStyle = "#253455";
        for (const [x, y] of state.grid.walls) {
          ctx.fillRect(x * size + 4, y * size + 4, size - 8, size - 8);
        }

        for (const node of state.nodes) {
          const owner = node.owner ? state.players[node.owner] : null;
          ctx.fillStyle = owner ? owner.color : "#ffd166";
          ctx.beginPath();
          ctx.arc(node.x * size + size / 2, node.y * size + size / 2, size * (node.value > 1 ? 0.28 : 0.22), 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = owner ? owner.accent : "rgba(255,209,102,0.45)";
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.fillStyle = "#08111f";
          ctx.font = "bold 14px Avenir Next, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(String(node.value), node.x * size + size / 2, node.y * size + size / 2 + 5);
        }

        for (const player of Object.values(state.players)) {
          ctx.globalAlpha = player.alive ? 1 : 0.35;
          ctx.fillStyle = player.color;
          ctx.fillRect(player.pos.x * size + 10, player.pos.y * size + 10, size - 20, size - 20);
          ctx.strokeStyle = player.accent;
          ctx.lineWidth = 2;
          ctx.strokeRect(player.pos.x * size + 10, player.pos.y * size + 10, size - 20, size - 20);
          ctx.fillStyle = "#f4f8ff";
          ctx.font = "bold 14px Avenir Next, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(player.label[0], player.pos.x * size + size / 2, player.pos.y * size + size / 2 + 5);
          if (player.shields > 0) {
            ctx.fillStyle = "#ffd166";
            ctx.font = "12px Avenir Next, sans-serif";
            ctx.fillText("S" + player.shields, player.pos.x * size + size / 2, player.pos.y * size + size - 8);
          }
        }
        ctx.globalAlpha = 1;
      }

      function actionCost(state, type) {
        return state.rules.actionCosts[type] || 0;
      }

      function canQueue(state, player, type) {
        return state.phase === "waiting_for_actions" &&
          player.alive &&
          player.respawnIn === 0 &&
          player.energy >= actionCost(state, type);
      }

      function renderStatus(state) {
        const pendingCount = Object.keys(state.pendingActions).length;
        const winners = state.winnerIds.length ? "Winner: " + state.winnerIds.map((id) => state.players[id].label).join(", ") : "Winner: pending";
        statusEl.innerHTML = [
          "<span>Turn " + state.turn + "</span>",
          "<span>Objective: " + state.objectiveScore + " VP</span>",
          "<span>Phase: " + state.phase + "</span>",
          "<span>Pending actions: " + pendingCount + "</span>",
          "<span>" + winners + "</span>"
        ].join("");
      }

      function renderPlayers(state) {
        playersEl.innerHTML = Object.values(state.players).map((player) => {
          const pending = state.pendingActions[player.id];
          return "<div class=\\"player-card\\">" +
            "<strong style=\\"color:" + player.color + "\\">" + player.label + "</strong><br>" +
            "Pos: (" + player.pos.x + ", " + player.pos.y + ")<br>" +
            "HP: " + player.hp + " / " + player.maxHp + "<br>" +
            "Energy: " + player.energy + " (+" + player.income + "/turn)<br>" +
            "Shields: " + player.shields + "<br>" +
            "Nodes: " + player.capturedNodes + "<br>" +
            "Board score: " + player.score + "<br>" +
            "Victory: " + player.victoryPoints + " / " + state.objectiveScore + "<br>" +
            "Damage: " + player.damageDealt + "<br>" +
            "Respawn: " + player.respawnIn + "<br>" +
            "Status: " + (player.alive ? "Online" : "Offline") + "<br>" +
            "Queued: " + (pending ? pending.type + (pending.direction ? " " + pending.direction : "") : "none") +
          "</div>";
        }).join("");
      }

      function actionButton(state, player, label, payload, className) {
        const cost = actionCost(state, payload.type);
        const disabled = canQueue(state, player, payload.type) ? "" : " disabled";
        const suffix = cost > 0 ? " [" + cost + "E]" : "";
        return "<button class=\\"" + className + "\\" data-player=\\"" + player.id + "\\" data-payload='" + JSON.stringify(payload) + "'" + disabled + ">" + label + suffix + "</button>";
      }

      function renderControls(state) {
        controlsEl.innerHTML = Object.values(state.players).map((player) => {
          return "<section>" +
            "<strong style=\\"color:" + player.color + "\\">" + player.label + "</strong>" +
            "<div class=\\"action-grid\\">" +
              actionButton(state, player, "North", { type: "move", direction: "north" }, player.id === "claude" ? "alt" : "") +
              actionButton(state, player, "Hack", { type: "hack" }, "secondary") +
              actionButton(state, player, "Siphon", { type: "siphon" }, "ghost") +
              actionButton(state, player, "West", { type: "move", direction: "west" }, player.id === "claude" ? "alt" : "") +
              actionButton(state, player, "Capture", { type: "capture" }, "secondary") +
              actionButton(state, player, "East", { type: "move", direction: "east" }, player.id === "claude" ? "alt" : "") +
              actionButton(state, player, "Fortify", { type: "fortify" }, "secondary") +
              actionButton(state, player, "South", { type: "move", direction: "south" }, player.id === "claude" ? "alt" : "") +
              actionButton(state, player, "Wait", { type: "wait" }, "ghost") +
            "</div>" +
          "</section>";
        }).join("");

        controlsEl.querySelectorAll("button").forEach((button) => {
          button.addEventListener("click", async () => {
            const payload = JSON.parse(button.dataset.payload);
            payload.player = button.dataset.player;
            payload.turn = lastState.turn;
            await api("/action", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
            await refresh();
          });
        });
      }

      function renderLog(state) {
        logEl.innerHTML = state.log.slice().reverse().map((entry) => {
          return "<div class=\\"log-entry\\"><strong>T" + entry.turn + "</strong> " + entry.summary + "</div>";
        }).join("");
      }

      async function refresh() {
        const state = await api("/state");
        lastState = state;
        renderStatus(state);
        renderPlayers(state);
        renderControls(state);
        renderLog(state);
        dumpEl.textContent = JSON.stringify(state, null, 2);
        draw(state);
      }

      resetEl.addEventListener("click", async () => {
        await api("/reset", { method: "POST" });
        await refresh();
      });

      refresh();
      setInterval(refresh, 1500);
    </script>
  </body>
</html>`;
}

function humanPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NEON GRID Human Console</title>
    <style>
      :root {
        --bg: #050711;
        --panel: rgba(10, 16, 30, 0.94);
        --border: rgba(111, 134, 196, 0.18);
        --text: #e4eeff;
        --muted: #96a7cf;
        --cyan: #00f5ff;
        --magenta: #ff4fd8;
        --green: #5cff87;
        --amber: #ffd166;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(0,245,255,0.12), transparent 28%),
          radial-gradient(circle at bottom right, rgba(255,79,216,0.14), transparent 30%),
          linear-gradient(180deg, #050711 0%, #090f1d 100%);
      }
      main {
        max-width: 920px;
        margin: 0 auto;
        padding: 20px 14px 40px;
      }
      h1 {
        margin: 0;
        font-size: clamp(2rem, 7vw, 3.4rem);
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .lede {
        margin: 8px 0 18px;
        color: var(--muted);
      }
      .layout {
        display: grid;
        gap: 16px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 14px;
      }
      .statusbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 12px;
      }
      .pill {
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 7px 10px;
        font-size: 0.82rem;
        color: var(--muted);
        background: rgba(12, 18, 34, 0.9);
      }
      canvas {
        width: 100%;
        aspect-ratio: 1;
        display: block;
        border-radius: 14px;
        background: linear-gradient(180deg, #0d1527 0%, #0a1221 100%);
      }
      .controls {
        display: grid;
        gap: 12px;
      }
      .picker {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .picker button {
        padding: 14px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: rgba(17, 27, 47, 0.92);
        color: var(--text);
        font: inherit;
        cursor: pointer;
      }
      .picker button.active[data-player="gpt"] {
        background: linear-gradient(135deg, rgba(0,245,255,0.25), rgba(0,245,255,0.12));
        border-color: rgba(0,245,255,0.4);
      }
      .picker button.active[data-player="claude"] {
        background: linear-gradient(135deg, rgba(255,79,216,0.26), rgba(255,79,216,0.12));
        border-color: rgba(255,79,216,0.42);
      }
      .dpad {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
        align-items: stretch;
      }
      .dpad button,
      .row button,
      #reset {
        border: 0;
        border-radius: 14px;
        padding: 16px 12px;
        font: inherit;
        cursor: pointer;
      }
      .move {
        background: linear-gradient(135deg, #91fbff, var(--cyan));
        color: #07121c;
      }
      .act {
        background: linear-gradient(135deg, #d5ffe0, var(--green));
        color: #08150e;
      }
      .warn {
        background: linear-gradient(135deg, #ffe6a6, var(--amber));
        color: #1c1307;
      }
      .ghost {
        background: rgba(17, 27, 47, 0.92);
        color: var(--text);
        border: 1px solid var(--border);
      }
      button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
        filter: saturate(0.4);
      }
      .row {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 10px;
      }
      .row.two {
        grid-template-columns: 1fr 1fr;
      }
      .player-cards {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .card {
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 12px;
        background: rgba(12, 18, 34, 0.86);
      }
      .card strong {
        display: inline-block;
        margin-bottom: 6px;
      }
      .log {
        display: grid;
        gap: 8px;
        max-height: 240px;
        overflow: auto;
      }
      .entry {
        border-left: 3px solid rgba(111, 134, 196, 0.22);
        padding-left: 10px;
        color: var(--muted);
        font-size: 0.92rem;
      }
      .hint {
        color: var(--muted);
        font-size: 0.9rem;
      }
      @media (max-width: 720px) {
        .player-cards,
        .picker {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Neon Grid</h1>
      <p class="lede">Human mode. Pick a side, tap an action, and the engine resolves the turn when both operators lock in.</p>

      <section class="layout">
        <article class="panel">
          <div class="statusbar" id="status"></div>
          <canvas id="board" width="720" height="720"></canvas>
        </article>

        <article class="panel controls">
          <div class="picker" id="picker">
            <button data-player="gpt">Play As GPT</button>
            <button data-player="claude">Play As Claude</button>
          </div>
          <div class="hint" id="selectionHint">Selected player: GPT</div>
          <div class="dpad">
            <div></div>
            <button class="move" data-label="North" data-type="move" data-direction="north">North</button>
            <div></div>
            <button class="move" data-label="West" data-type="move" data-direction="west">West</button>
            <button class="act" data-label="Capture" data-type="capture">Capture</button>
            <button class="move" data-label="East" data-type="move" data-direction="east">East</button>
            <div></div>
            <button class="move" data-label="South" data-type="move" data-direction="south">South</button>
            <div></div>
          </div>
          <div class="row">
            <button class="warn" data-label="Hack" data-type="hack">Hack</button>
            <button class="act" data-label="Fortify" data-type="fortify">Fortify</button>
            <button class="ghost" data-label="Siphon" data-type="siphon">Siphon</button>
          </div>
          <div class="row two">
            <button class="ghost" data-label="Wait" data-type="wait">Wait</button>
            <button class="ghost" id="reset">Reset</button>
          </div>
        </article>

        <article class="panel">
          <div class="player-cards" id="players"></div>
        </article>

        <article class="panel">
          <div class="log" id="log"></div>
        </article>
      </section>
    </main>
    <script>
      const canvas = document.getElementById("board");
      const ctx = canvas.getContext("2d");
      const statusEl = document.getElementById("status");
      const pickerEl = document.getElementById("picker");
      const hintEl = document.getElementById("selectionHint");
      const playersEl = document.getElementById("players");
      const logEl = document.getElementById("log");
      const resetEl = document.getElementById("reset");
      let selectedPlayer = "gpt";
      let latestState = null;

      async function api(path, options) {
        const response = await fetch(path, options);
        return response.json();
      }

      function cell(state) {
        return canvas.width / state.grid.width;
      }

      function draw(state) {
        const size = cell(state);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#0c1526";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.strokeStyle = "rgba(80,102,151,0.38)";
        ctx.lineWidth = 1;
        for (let x = 0; x <= state.grid.width; x++) {
          ctx.beginPath();
          ctx.moveTo(x * size, 0);
          ctx.lineTo(x * size, canvas.height);
          ctx.stroke();
        }
        for (let y = 0; y <= state.grid.height; y++) {
          ctx.beginPath();
          ctx.moveTo(0, y * size);
          ctx.lineTo(canvas.width, y * size);
          ctx.stroke();
        }

        ctx.fillStyle = "#253455";
        for (const [x, y] of state.grid.walls) {
          ctx.fillRect(x * size + 4, y * size + 4, size - 8, size - 8);
        }

        for (const node of state.nodes) {
          const owner = node.owner ? state.players[node.owner] : null;
          ctx.fillStyle = owner ? owner.color : "#ffd166";
          ctx.beginPath();
          ctx.arc(node.x * size + size / 2, node.y * size + size / 2, size * (node.value > 1 ? 0.28 : 0.22), 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = owner ? owner.accent : "rgba(255,209,102,0.45)";
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.fillStyle = "#08111f";
          ctx.font = "bold 14px Avenir Next, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(String(node.value), node.x * size + size / 2, node.y * size + size / 2 + 5);
        }

        for (const player of Object.values(state.players)) {
          ctx.globalAlpha = player.alive ? 1 : 0.3;
          ctx.fillStyle = player.color;
          ctx.fillRect(player.pos.x * size + 10, player.pos.y * size + 10, size - 20, size - 20);
          ctx.strokeStyle = player.id === selectedPlayer ? "#ffffff" : player.accent;
          ctx.lineWidth = player.id === selectedPlayer ? 4 : 2;
          ctx.strokeRect(player.pos.x * size + 10, player.pos.y * size + 10, size - 20, size - 20);
          ctx.fillStyle = "#f4f8ff";
          ctx.font = "bold 14px Avenir Next, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(player.label[0], player.pos.x * size + size / 2, player.pos.y * size + size / 2 + 5);
          if (player.shields > 0) {
            ctx.fillStyle = "#ffd166";
            ctx.font = "12px Avenir Next, sans-serif";
            ctx.fillText("S" + player.shields, player.pos.x * size + size / 2, player.pos.y * size + size - 8);
          }
        }
        ctx.globalAlpha = 1;
      }

      function actionCost(state, type) {
        return state.rules.actionCosts[type] || 0;
      }

      function isAvailable(state, playerId, type) {
        const player = state.players[playerId];
        return state.phase === "waiting_for_actions" &&
          player.alive &&
          player.respawnIn === 0 &&
          player.energy >= actionCost(state, type);
      }

      function renderStatus(state) {
        const winner = state.winnerIds.length
          ? "Winner: " + state.winnerIds.map((id) => state.players[id].label).join(", ")
          : "Winner: pending";
        statusEl.innerHTML = [
          "<span class=\\"pill\\">Turn " + state.turn + "</span>",
          "<span class=\\"pill\\">Objective " + state.objectiveScore + " VP</span>",
          "<span class=\\"pill\\">Phase: " + state.phase + "</span>",
          "<span class=\\"pill\\">Queued: " + Object.keys(state.pendingActions).length + "</span>",
          "<span class=\\"pill\\">" + winner + "</span>"
        ].join("");
      }

      function renderPlayers(state) {
        playersEl.innerHTML = Object.values(state.players).map((player) => {
          const pending = state.pendingActions[player.id];
          return "<div class=\\"card\\">" +
            "<strong style=\\"color:" + player.color + "\\">" + player.label + "</strong><br>" +
            "Position: (" + player.pos.x + ", " + player.pos.y + ")<br>" +
            "HP: " + player.hp + " / " + player.maxHp + "<br>" +
            "Energy: " + player.energy + " (+" + player.income + "/turn)<br>" +
            "Shields: " + player.shields + "<br>" +
            "Nodes: " + player.capturedNodes + "<br>" +
            "Board score: " + player.score + "<br>" +
            "Victory: " + player.victoryPoints + " / " + state.objectiveScore + "<br>" +
            "Damage: " + player.damageDealt + "<br>" +
            "Respawn: " + player.respawnIn + "<br>" +
            "Queued: " + (pending ? pending.type + (pending.direction ? " " + pending.direction : "") : "none") +
          "</div>";
        }).join("");
      }

      function renderLog(state) {
        logEl.innerHTML = state.log.slice().reverse().map((entry) => {
          return "<div class=\\"entry\\"><strong>T" + entry.turn + "</strong> " + entry.summary + "</div>";
        }).join("");
      }

      function updateSelection() {
        pickerEl.querySelectorAll("button").forEach((button) => {
          button.classList.toggle("active", button.dataset.player === selectedPlayer);
        });
        hintEl.textContent = "Selected player: " + selectedPlayer.toUpperCase();
      }

      function updateActionAvailability() {
        document.querySelectorAll("[data-type]").forEach((button) => {
          if (!latestState) {
            button.disabled = true;
            return;
          }
          button.disabled = !isAvailable(latestState, selectedPlayer, button.dataset.type);
          const cost = actionCost(latestState, button.dataset.type);
          button.textContent = button.dataset.label + (cost > 0 ? " [" + cost + "E]" : "");
        });
      }

      async function refresh() {
        latestState = await api("/state");
        renderStatus(latestState);
        renderPlayers(latestState);
        renderLog(latestState);
        draw(latestState);
        updateSelection();
        updateActionAvailability();
      }

      pickerEl.querySelectorAll("button").forEach((button) => {
        button.addEventListener("click", () => {
          selectedPlayer = button.dataset.player;
          updateSelection();
          updateActionAvailability();
          if (latestState) draw(latestState);
        });
      });

      document.querySelectorAll("[data-type]").forEach((button) => {
        button.addEventListener("click", async () => {
          if (!latestState || button.disabled) return;
          const payload = {
            player: selectedPlayer,
            type: button.dataset.type,
            direction: button.dataset.direction || null,
            turn: latestState.turn
          };
          await api("/action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          await refresh();
        });
      });

      resetEl.addEventListener("click", async () => {
        await api("/reset", { method: "POST" });
        await refresh();
      });

      refresh();
      setInterval(refresh, 1500);
    </script>
  </body>
</html>`;
}

const server = http.createServer(route);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log("NEON GRID listening on http://localhost:" + PORT);
  });
}

module.exports = {
  server,
  createInitialState,
  submitAction,
  publicState
};
