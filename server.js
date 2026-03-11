const http = require("node:http");

const state = {
  turn: 1,
  phase: "waiting_for_actions",
  grid: {
    width: 12,
    height: 12,
    walls: [
      [3, 3],
      [3, 4],
      [8, 7],
      [8, 8]
    ]
  },
  players: {
    gpt: {
      id: "gpt",
      label: "GPT",
      color: "#00f5ff",
      pos: { x: 0, y: 0 },
      hp: 3,
      respawnIn: 0,
      capturedNodes: 0,
      alive: true
    },
    claude: {
      id: "claude",
      label: "Claude",
      color: "#ff4fd8",
      pos: { x: 11, y: 11 },
      hp: 3,
      respawnIn: 0,
      capturedNodes: 0,
      alive: true
    }
  },
  nodes: [
    { id: "n1", x: 2, y: 2, owner: null },
    { id: "n2", x: 9, y: 2, owner: null },
    { id: "n3", x: 2, y: 9, owner: null },
    { id: "n4", x: 9, y: 9, owner: null }
  ],
  pendingActions: {},
  log: [
    {
      turn: 1,
      playerId: "system",
      type: "boot",
      summary: "NEON GRID scaffold initialized"
    }
  ]
};

function json(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data, null, 2));
}

function html(res, body) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
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
        --panel: #0e1424;
        --grid: #10192d;
        --line: #1d2b4f;
        --cyan: #00f5ff;
        --magenta: #ff4fd8;
        --green: #5cff87;
        --text: #d7e4ff;
        --muted: #7d8eb8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top, rgba(255,79,216,0.12), transparent 30%),
          radial-gradient(circle at bottom right, rgba(0,245,255,0.14), transparent 30%),
          var(--bg);
      }
      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: clamp(2rem, 5vw, 3.5rem);
        letter-spacing: 0.08em;
      }
      p { color: var(--muted); }
      .layout {
        display: grid;
        grid-template-columns: minmax(320px, 1.3fr) minmax(280px, 0.9fr);
        gap: 20px;
      }
      .panel {
        background: rgba(14,20,36,0.88);
        border: 1px solid rgba(125,142,184,0.18);
        border-radius: 18px;
        padding: 18px;
        backdrop-filter: blur(12px);
      }
      canvas {
        width: 100%;
        aspect-ratio: 1;
        display: block;
        background: var(--grid);
        border-radius: 12px;
      }
      .meta, .actions {
        display: grid;
        gap: 12px;
      }
      .actions button {
        border: 0;
        border-radius: 10px;
        padding: 12px 14px;
        font: inherit;
        color: #08111f;
        background: linear-gradient(135deg, var(--cyan), #8cf8ff);
        cursor: pointer;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        color: var(--muted);
      }
      @media (max-width: 900px) {
        .layout { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>NEON GRID</h1>
      <p>Agent-first turn-based cyberpunk tactics. This is the public scaffold for co-creation.</p>
      <div class="layout">
        <section class="panel">
          <canvas id="board" width="720" height="720"></canvas>
        </section>
        <section class="panel">
          <div class="meta">
            <div id="summary"></div>
            <div class="actions">
              <button data-player="gpt" data-type="wait">Submit WAIT for GPT</button>
              <button data-player="claude" data-type="wait">Submit WAIT for Claude</button>
            </div>
            <pre id="dump"></pre>
          </div>
        </section>
      </div>
    </main>
    <script>
      const canvas = document.getElementById("board");
      const ctx = canvas.getContext("2d");
      const summary = document.getElementById("summary");
      const dump = document.getElementById("dump");
      const cell = canvas.width / 12;

      async function fetchState() {
        const res = await fetch("/state");
        return res.json();
      }

      function drawGrid(state) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#10192d";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.strokeStyle = "#1d2b4f";
        ctx.lineWidth = 1;
        for (let i = 0; i <= state.grid.width; i++) {
          const x = i * cell;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, canvas.height);
          ctx.stroke();
        }
        for (let i = 0; i <= state.grid.height; i++) {
          const y = i * cell;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(canvas.width, y);
          ctx.stroke();
        }

        ctx.fillStyle = "#243456";
        for (const [x, y] of state.grid.walls) {
          ctx.fillRect(x * cell + 4, y * cell + 4, cell - 8, cell - 8);
        }

        for (const node of state.nodes) {
          ctx.fillStyle = node.owner ? "#5cff87" : "#ffe66d";
          ctx.beginPath();
          ctx.arc(node.x * cell + cell / 2, node.y * cell + cell / 2, cell * 0.22, 0, Math.PI * 2);
          ctx.fill();
        }

        for (const player of Object.values(state.players)) {
          ctx.fillStyle = player.color;
          ctx.fillRect(player.pos.x * cell + 10, player.pos.y * cell + 10, cell - 20, cell - 20);
        }
      }

      async function refresh() {
        const state = await fetchState();
        summary.innerHTML = "<strong>Turn " + state.turn + "</strong><br>Phase: " + state.phase;
        dump.textContent = JSON.stringify(state, null, 2);
        drawGrid(state);
      }

      document.querySelectorAll("button").forEach((button) => {
        button.addEventListener("click", async () => {
          const params = new URLSearchParams({
            player: button.dataset.player,
            type: button.dataset.type
          });
          await fetch("/action?" + params.toString(), { method: "POST" });
          refresh();
        });
      });

      refresh();
      setInterval(refresh, 2000);
    </script>
  </body>
</html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost:3000");

  if (req.method === "GET" && url.pathname === "/") {
    return html(res, page());
  }

  if (req.method === "GET" && url.pathname === "/state") {
    return json(res, 200, state);
  }

  if (req.method === "POST" && url.pathname === "/action") {
    const player = url.searchParams.get("player");
    const type = url.searchParams.get("type");
    if (!player || !state.players[player]) {
      return json(res, 400, { error: "Unknown player" });
    }
    if (!type) {
      return json(res, 400, { error: "Missing action type" });
    }
    state.pendingActions[player] = { type };
    state.log.push({
      turn: state.turn,
      playerId: player,
      type: "submit_action",
      summary: player + " submitted " + type
    });
    return json(res, 200, { ok: true, pendingActions: state.pendingActions });
  }

  if (req.method === "POST" && url.pathname === "/reset") {
    state.turn = 1;
    state.phase = "waiting_for_actions";
    state.pendingActions = {};
    state.log.push({
      turn: state.turn,
      playerId: "system",
      type: "reset",
      summary: "Match reset requested"
    });
    return json(res, 200, { ok: true });
  }

  return notFound(res);
});

server.listen(3000, () => {
  console.log("NEON GRID listening on http://localhost:3000");
});
