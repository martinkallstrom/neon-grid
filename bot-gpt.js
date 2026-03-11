const baseUrl = process.argv[2] || "http://localhost:3000";
const playerId = process.argv[3] || "gpt";
const pollMs = Number(process.env.POLL_MS || 800);

const DIRS = [
  { name: "north", x: 0, y: -1 },
  { name: "south", x: 0, y: 1 },
  { name: "west", x: -1, y: 0 },
  { name: "east", x: 1, y: 0 }
];

let lastSubmittedTurn = 0;
let lastSeenTurn = 0;

function key(pos) {
  return `${pos.x},${pos.y}`;
}

function samePos(a, b) {
  return a.x === b.x && a.y === b.y;
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function actionCost(state, type) {
  return state.rules?.actionCosts?.[type] || 0;
}

function canAfford(state, me, type) {
  return me.energy >= actionCost(state, type);
}

function neighbors(pos, state) {
  const occupied = new Set(
    Object.values(state.players)
      .filter((player) => player.alive)
      .map((player) => key(player.pos))
  );
  occupied.delete(key(state.players[playerId].pos));
  const walls = new Set(state.grid.walls.map(([x, y]) => `${x},${y}`));

  return DIRS
    .map((dir) => ({ dir, pos: { x: pos.x + dir.x, y: pos.y + dir.y } }))
    .filter((entry) => {
      const { x, y } = entry.pos;
      return (
        x >= 0 &&
        y >= 0 &&
        x < state.grid.width &&
        y < state.grid.height &&
        !walls.has(key(entry.pos)) &&
        !occupied.has(key(entry.pos))
      );
    });
}

function bfsPath(state, start, targetTest) {
  const queue = [{ pos: start, firstDir: null, distance: 0 }];
  const seen = new Set([key(start)]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (targetTest(current.pos) && current.firstDir) {
      return { direction: current.firstDir, distance: current.distance };
    }

    for (const next of neighbors(current.pos, state)) {
      const nextKey = key(next.pos);
      if (seen.has(nextKey)) continue;
      seen.add(nextKey);
      queue.push({
        pos: next.pos,
        firstDir: current.firstDir || next.dir.name,
        distance: current.distance + 1
      });
    }
  }

  return null;
}

function bestNodePath(state, me) {
  const candidates = state.nodes
    .filter((node) => node.owner !== playerId)
    .map((node) => {
      const path = bfsPath(state, me.pos, (pos) => samePos(pos, node));
      if (!path) return null;
      const enemyOwned = node.owner && node.owner !== playerId ? 1 : 0;
      return {
        node,
        direction: path.direction,
        score: node.value * 10 + enemyOwned * 3 - path.distance
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return candidates[0] || null;
}

function chooseAction(state) {
  const me = state.players[playerId];
  const enemies = Object.values(state.players).filter((player) => player.id !== playerId && player.alive);
  const hereNode = state.nodes.find((node) => samePos(node, me.pos));
  const adjacentEnemy = enemies.find((enemy) => manhattan(enemy.pos, me.pos) === 1);

  if (hereNode && hereNode.owner === playerId && me.energy <= 1) {
    return { type: "siphon" };
  }

  if (hereNode && hereNode.owner !== playerId && canAfford(state, me, "capture")) {
    return { type: "capture" };
  }

  if (adjacentEnemy && me.hp === 1 && me.shields === 0 && canAfford(state, me, "fortify")) {
    return { type: "fortify" };
  }

  if (adjacentEnemy && canAfford(state, me, "hack")) {
    return { type: "hack" };
  }

  const targetNode = bestNodePath(state, me);
  if (targetNode && canAfford(state, me, "move")) {
    return { type: "move", direction: targetNode.direction };
  }

  if (adjacentEnemy && me.shields < 1 && canAfford(state, me, "fortify")) {
    return { type: "fortify" };
  }

  const enemyPath = bfsPath(state, me.pos, (pos) => enemies.some((enemy) => samePos(enemy.pos, pos)));
  if (enemyPath && canAfford(state, me, "move")) {
    return { type: "move", direction: enemyPath.direction };
  }

  if (hereNode && hereNode.owner === playerId) {
    return { type: "siphon" };
  }

  return { type: "wait" };
}

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
  }
  return response.json();
}

async function tick() {
  const state = await request("/state");
  const me = state.players[playerId];
  if (!me) throw new Error(`Unknown player ${playerId}`);
  if (state.turn < lastSeenTurn) {
    lastSubmittedTurn = 0;
  }
  lastSeenTurn = state.turn;
  if (state.phase !== "waiting_for_actions") return;
  if (!me.alive || me.respawnIn > 0) return;
  if (state.pendingActions[playerId]) return;
  if (state.turn === lastSubmittedTurn) return;

  const action = chooseAction(state);
  const payload = {
    player: playerId,
    turn: state.turn,
    type: action.type,
    direction: action.direction || null,
    actionId: `${playerId}-${state.turn}-${action.type}-${action.direction || "none"}`
  };

  await request("/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  lastSubmittedTurn = state.turn;
  console.log(`[turn ${state.turn}] ${playerId} -> ${action.type}${action.direction ? ` ${action.direction}` : ""}`);
}

async function loop() {
  for (;;) {
    try {
      await tick();
    } catch (error) {
      console.error(error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

console.log(`Starting ${playerId} bot against ${baseUrl}`);
loop();
