const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use((req,res,next)=>{ if(req.path.endsWith('.html')||req.path==='/'){ res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate'); res.setHeader('Pragma','no-cache'); res.setHeader('Expires','0'); } next(); });
app.use(express.static(path.join(__dirname), { etag:false, lastModified:false, maxAge:0 }));

const COLORS = ['red','yellow','green','blue'];
const EMOJIS = ['😎','🦊','🐼','🐸','🐯','🐵','🐱'];
const NAMES = ['Nova','Pixel','Rex','Mochi','Ziggy','Luna','Kai'];

const rooms = new Map();

function playerTokenFor(socket){ return String(socket.handshake.auth?.playerToken||socket.id).slice(0,120); }

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random()*chars.length)];
  return c;
}

function shuffle(a){ for(let i=a.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]} return a; }
function makeDeck(){ let d=[]; for(let c of COLORS){ d.push({color:c,value:'0'}); for(let n=1;n<=9;n++) d.push({color:c,value:''+n},{color:c,value:''+n}); for(let v of ['Skip','Reverse','+2']) d.push({color:c,value:v},{color:c,value:v}); } for(let i=0;i<4;i++) d.push({color:'wild',value:'Wild'},{color:'wild',value:'+4'}); return shuffle(d); }
function take(room){ if(!room.game.deck.length){ if(room.game.discard.length<=1) return null; let top=room.game.discard.pop(); room.game.deck=shuffle(room.game.discard); room.game.discard=[top]; } return room.game.deck.pop(); }

function newGame(room) {
  const g = {
    players: room.players.map(p => ({ id: p.id, token:p.token, name: p.name, emoji: p.emoji, cards: [] })),
    deck: makeDeck(),
    discard: [],
    current: 0,
    direction: 1,
    currentColor: 'red',
    hasDrawn: false,
    drawnCard: null,
    pendingDraw: 0,
    unoSaid: false,
    gameOver: false,
    winner: null,
    pendingWild: false,
    pendingWildPlayer: null,
    round: (room.round||0)+1
  };
  room.round = g.round;
  g.players.forEach(p => { for(let i=0;i<7;i++) p.cards.push(take({game:g})); });
  // take needs room-like; adjust: use g directly
  // redo take handling: we passed {game:g}; take expects room.game. Let's instead implement deal with g.
  // Oops: above take({game:g}) works because take reads room.game. Good.
  let first = take({game:g});
  while (first.color==='wild' || ['Skip','Reverse','+2'].includes(first.value)) { g.deck.unshift(first); first = take({game:g}); }
  g.discard.push(first);
  g.currentColor = first.color;
  room.game = g;
  room.game.deck = g.deck;
  room.game.discard = g.discard;
}

// Fix take to accept room with .game
// already does.

function topCard(room){ return room.game.discard[room.game.discard.length-1]; }
function isStack(c){ return c.value==='+2' || c.value==='+4'; }
function canPlay(room,c){
  const g=room.game;
  if(g.pendingDraw>0) return isStack(c);
  return c.color==='wild' || c.color===g.currentColor || c.value===topCard(room).value;
}

function giveCards(room, i, n){
  const g=room.game;
  let got=0;
  for(let k=0;k<n;k++){ let c=take(room); if(c){ g.players[i].cards.push(c); got++; } }
  return got;
}

function nextIndex(room, from){ const g=room.game; return (from + g.direction + g.players.length) % g.players.length; }

function resolveCard(room, who, c){
  const g=room.game;
  if(g.players[who].cards.length===0){ endGame(room, who); return; }
  let skip=false;
  if(c.value==='Reverse'){
    g.direction*=-1;
    if(g.players.length===2){ skip=true; }
  }
  let next = nextIndex(room, who);
  if(c.value==='Skip'){ skip=true; }
  if(isStack(c)){
    g.pendingDraw += c.value==='+2'?2:4;
    if(!g.players[next].cards.some(isStack)){
      giveCards(room, next, g.pendingDraw);
      g.pendingDraw=0;
      skip=true;
    }
  }
  if(skip) next = (next + g.direction + g.players.length) % g.players.length;
  g.current = next;
  g.hasDrawn = false;
  g.drawnCard = null;
  if(g.players[who].cards.length>1) g.unoSaid=false;
  broadcastState(room);
  if(g.current===/* human all */0) {} // all humans
  // schedule nothing; clients act
  if(g.gameOver) return;
  // if current player has no moves? client handles
}

function endGame(room, winnerIndex){
  const g=room.game;
  g.gameOver=true;
  g.winner=winnerIndex;
  broadcastState(room);
}

function broadcastState(room){
  const g=room.game;
  const pubPlayers = g.players.map((p,i)=>({ index:i, name:p.name, emoji:p.emoji, cardCount:p.cards.length, isCurrent: i===g.current }));
  g.players.forEach((p,i)=>{
    const sock = io.sockets.sockets.get(p.id);
    if(!sock) return;
    sock.emit('state', {
      code: room.code,
      you: i,
      players: pubPlayers,
      hand: p.cards,
      topCard: topCard(room),
      currentColor: g.currentColor,
      direction: g.direction,
      current: g.current,
      deckCount: g.deck.length,
      pendingDraw: g.pendingDraw,
      gameOver: g.gameOver,
      winner: g.winner,
      pendingWild: g.pendingWild && g.pendingWildPlayer===p.id,
      hasDrawn: i===g.current ? g.hasDrawn : false,
      drawnCard: i===g.current ? g.drawnCard : null,
      unoSaid: g.unoSaid,
      round: g.round
    });
  });
  // also to spectators? none
}

function createRoom(socket, name, count){
  let code;
  do { code = genCode(); } while(rooms.has(code));
  const room = {
    code,
    hostId: socket.id,
    maxPlayers: Math.max(2, Math.min(6, count||2)),
    players: [{ id: socket.id, token: playerTokenFor(socket), name: (name||'Player').slice(0,16), emoji: EMOJIS[0] }],
    game: null,
    round: 0,
    started: false
  };
  // assign emoji by index
  room.players[0].emoji = EMOJIS[0];
  rooms.set(code, room);
  socket.join(code);
  socket.data.code = code;
  socket.emit('room_created', { code, maxPlayers: room.maxPlayers, players: room.players.map((p,i)=>({name:p.name,emoji:p.emoji})) });
  broadcastRoom(room);
  return room;
}

function broadcastRoom(room){
  io.to(room.code).emit('room_update', {
    code: room.code,
    maxPlayers: room.maxPlayers,
    players: room.players.map((p,i)=>({ name:p.name, emoji:p.emoji, id:p.id })),
    hostId: room.hostId,
    started: room.started
  });
}

io.on('connection', (socket) => {
  const playerToken=String(socket.handshake.auth?.playerToken||'').slice(0,120);
  if(playerToken){
    for(const room of rooms.values()){
      const player=room.players.find(p=>p.token===playerToken);
      if(!player) continue;
      player.id=socket.id;
      socket.data.code=room.code;
      socket.join(room.code);
      if(room.game){const gp=room.game.players.find(p=>p.token===playerToken);if(gp)gp.id=socket.id;socket.emit('room_resumed',{code:room.code});socket.emit('game_start',{code:room.code});broadcastState(room);}
      else broadcastRoom(room);
      break;
    }
  }
  socket.on('create_room', ({name, count}) => {
    createRoom(socket, name, count);
  });

  socket.on('join_room', ({code, name}) => {
    const room = rooms.get((code||'').toUpperCase());
    if(!room){ socket.emit('error_msg', 'Room not found'); return; }
    if(room.started){ socket.emit('error_msg', 'Game already started'); return; }
    if(room.players.length >= room.maxPlayers){ socket.emit('error_msg', 'Room full'); return; }
    const idx = room.players.length;
    const p = { id: socket.id, token: playerTokenFor(socket), name: (name||'Player').slice(0,16), emoji: EMOJIS[idx % EMOJIS.length] };
    room.players.push(p);
    socket.join(room.code);
    socket.data.code = room.code;
    socket.emit('room_joined', { code: room.code, maxPlayers: room.maxPlayers });
    broadcastRoom(room);
    // auto start when full
    if(room.players.length >= room.maxPlayers){
      startGame(room);
    }
  });

  socket.on('start_game', ({code}) => {
    const room = rooms.get((code||'').toUpperCase());
    if(!room) return;
    if(socket.id !== room.hostId) return;
    if(room.players.length < 2) return;
    startGame(room);
  });

  socket.on('play_card', ({code, index}) => {
    const room = rooms.get((code||'').toUpperCase());
    if(!room || !room.game) return;
    const g = room.game;
    if(g.gameOver) return;
    const pi = g.players.findIndex(p=>p.id===socket.id);
    if(pi !== g.current) return;
    const p = g.players[pi];
    const c = p.cards[index];
    if(!c) return;
    if(!canPlay(room,c)) return;
    // if hasDrawn restriction? server: allow if drawnCard matches? We'll track drawnCard
    if(g.hasDrawn && g.drawnCard && c !== g.drawnCard) return;
    p.cards.splice(index,1);
    g.discard.push(c);
    g.hasDrawn = false;
    g.drawnCard = null;
    if(p.cards.length===0){ /* need color if wild handled below */ }
    if(c.color==='wild'){
      g.pendingWild = true;
      g.pendingWildPlayer = socket.id;
      if(p.cards.length===0){ /* still choose color then end */ }
      broadcastState(room);
      // emit choose color to player
      socket.emit('choose_color', {});
      return;
    }
    g.currentColor = c.color;
    resolveCard(room, pi, c);
  });

  socket.on('choose_color', ({code, color}) => {
    const room = rooms.get((code||'').toUpperCase());
    if(!room || !room.game) return;
    const g = room.game;
    if(!g.pendingWild || g.pendingWildPlayer !== socket.id) return;
    const pi = g.players.findIndex(p=>p.id===socket.id);
    const c = topCard(room); // last played wild is top
    // find the wild card? topCard is the wild just pushed. good.
    g.pendingWild = false;
    g.pendingWildPlayer = null;
    g.currentColor = color;
    resolveCard(room, pi, c);
  });

  socket.on('draw_card', ({code}) => {
    const room = rooms.get((code||'').toUpperCase());
    if(!room || !room.game) return;
    const g = room.game;
    if(g.gameOver) return;
    const pi = g.players.findIndex(p=>p.id===socket.id);
    if(pi !== g.current) return;
    if(g.hasDrawn) return;
    if(g.pendingDraw>0){
      const n = g.pendingDraw;
      g.pendingDraw = 0;
      giveCards(room, pi, n);
      g.current = nextIndex(room, pi);
      g.hasDrawn = false;
      g.drawnCard = null;
      broadcastState(room);
      return;
    }
    const c = take(room);
    if(c){
      g.players[pi].cards.push(c);
      g.hasDrawn = true;
      g.drawnCard = c;
      broadcastState(room);
      if(canPlay(room,c)){
        // player may play; state already
      } else {
        // cannot play; auto? client can end turn
      }
    } else {
      g.hasDrawn = true;
      broadcastState(room);
    }
  });

  socket.on('end_turn', ({code}) => {
    const room = rooms.get((code||'').toUpperCase());
    if(!room || !room.game) return;
    const g = room.game;
    if(g.gameOver) return;
    const pi = g.players.findIndex(p=>p.id===socket.id);
    if(pi !== g.current) return;
    if(!g.hasDrawn) return;
    g.hasDrawn = false;
    g.drawnCard = null;
    g.current = nextIndex(room, pi);
    broadcastState(room);
  });

  socket.on('call_uno', ({code}) => {
    const room = rooms.get((code||'').toUpperCase());
    if(!room || !room.game) return;
    const g = room.game;
    const pi = g.players.findIndex(p=>p.id===socket.id);
    if(pi<0) return;
    if(g.players[pi].cards.length <= 2){
      g.unoSaid = true;
      broadcastState(room);
    }
  });

  socket.on('reaction', ({code, emoji}) => {
    const room = rooms.get((code||'').toUpperCase());
    if(!room) return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    io.to(room.code).emit('reaction', { fromIndex: idx, emoji });
  });

  socket.on('disconnect', () => {
    const code=socket.data.code;
    if(!code) return;
    const room=rooms.get(code);
    if(!room) return;
    // Keep an in-progress seat and game state during temporary network loss.
    // The same browser reconnects with its stable playerToken and reclaims this seat.
    if(room.started){
      const player=room.players.find(p=>p.id===socket.id);
      if(player) player.disconnectedAt=Date.now();
      return;
    }
    room.players=room.players.filter(p=>p.id!==socket.id);
    if(room.players.length===0){rooms.delete(code);return;}
    if(room.hostId===socket.id) room.hostId=room.players[0].id;
    broadcastRoom(room);
  });
});

function startGame(room){
  room.started = true;
  newGame(room);
  io.to(room.code).emit('game_start', { code: room.code });
  broadcastState(room);
}

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('UNO Arena server listening on', PORT);
  });
}

// Vercel serverless export
module.exports = app;
module.exports.app = app;
module.exports.server = server;
module.exports.io = io;
