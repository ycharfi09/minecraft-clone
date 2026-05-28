const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 3000;

// ---------- HTTP server (serves the game) ----------
const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/minecraft-clone.html' : req.url;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

// ---------- WebSocket server (multiplayer relay) ----------
const wss = new WebSocketServer({ server });

const rooms = new Map(); // code -> {host: ws, guests: Map<id, ws>, seed, nextId}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastExcept(room, excludeId, obj) {
  const data = JSON.stringify(obj);
  if (room.host && room.host._mpId !== excludeId && room.host.readyState === 1) room.host.send(data);
  for (const [id, ws] of room.guests) {
    if (id !== excludeId && ws.readyState === 1) ws.send(data);
  }
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let myId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // --- Host creates a room ---
    if (msg.type === 'host') {
      const code = genCode();
      myId = 'host-' + code;
      ws._mpId = myId;
      const room = { host: ws, guests: new Map(), seed: msg.seed, nextId: 1 };
      rooms.set(code, room);
      currentRoom = { code, room };
      send(ws, { type: 'hosted', code, id: myId });
      console.log(`Room ${code} created by host`);
    }

    // --- Guest joins a room ---
    else if (msg.type === 'join') {
      const room = rooms.get(msg.code);
      if (!room) { send(ws, { type: 'error', msg: 'Room not found' }); return; }
      const guestNum = room.nextId++;
      myId = 'guest-' + guestNum;
      ws._mpId = myId;
      room.guests.set(myId, ws);
      currentRoom = { code: msg.code, room };

      // Tell guest they joined (with seed and host info)
      send(ws, { type: 'joined', id: myId, seed: room.seed, hostId: room.host._mpId });

      // Tell host about the new guest
      send(room.host, { type: 'guestJoin', id: myId, name: msg.name });

      // Tell other guests about the new player
      for (const [gid, gws] of room.guests) {
        if (gid !== myId) {
          send(gws, { type: 'playerJoin', id: myId, name: msg.name });
          // Tell new guest about existing players
          send(ws, { type: 'playerJoin', id: gid, name: gws._mpName || 'Player' });
        }
      }
      // Store name on ws for future joins
      ws._mpName = msg.name;
      console.log(`Guest ${myId} joined room ${currentRoom.code}`);
    }

    // --- Relay game messages ---
    else if (msg.type === 'relay' && currentRoom) {
      const target = msg.to;
      const payload = { type: 'relay', from: myId, data: msg.data };
      if (target === 'host') {
        send(currentRoom.room.host, payload);
      } else if (target === 'all') {
        broadcastExcept(currentRoom.room, myId, payload);
      } else {
        // Send to specific peer
        const guestWs = currentRoom.room.guests.get(target);
        if (guestWs) send(guestWs, payload);
        else if (currentRoom.room.host._mpId === target) send(currentRoom.room.host, payload);
      }
    }

    // --- Set name ---
    else if (msg.type === 'setName') {
      ws._mpName = msg.name;
    }
  });

  ws.on('close', () => {
    if (!currentRoom) return;
    const { code, room } = currentRoom;
    if (room.host === ws) {
      // Host disconnected — tell all guests
      for (const [, gws] of room.guests) {
        send(gws, { type: 'hostDisconnect' });
      }
      rooms.delete(code);
      console.log(`Room ${code} closed (host left)`);
    } else {
      // Guest disconnected
      room.guests.delete(myId);
      // Tell host
      send(room.host, { type: 'playerLeave', id: myId });
      // Tell other guests
      for (const [, gws] of room.guests) {
        send(gws, { type: 'playerLeave', id: myId });
      }
      console.log(`Guest ${myId} left room ${code}`);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let lanIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { lanIP = net.address; break; }
    }
  }
  console.log(`Minecraft clone server running at http://localhost:${PORT}`);
  console.log(`Other devices on your network can connect at http://${lanIP}:${PORT}`);
});
