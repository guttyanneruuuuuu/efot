/* =========================================================
   POCKET FOOTBALL - 簡単操作サッカー  v1.0
   Top-down 1vs1 mini soccer (机でサッカー風 + eFootball UI)
   Live: https://guttyanneruuuuuu.github.io/efot/
   ========================================================= */

(() => {
'use strict';

// ============= CONSTANTS =============
const FIELD = {
  // logical units (meters-ish). All physics done in these units.
  W: 105,
  H: 65,
  GOAL_W: 16,        // goal mouth height (along Y axis)
  GOAL_DEPTH: 3,
  MARGIN: 6,         // visual margin outside the lines
  PENALTY_W: 16,
  PENALTY_H: 32,
};

const PHYS = {
  PLAYER_R: 1.4,
  BALL_R: 0.55,
  PLAYER_SPEED: 17.0,        // u/sec
  PLAYER_SPEED_NOBALL: 18.5,
  PLAYER_SPEED_DRIBBLE: 14.5,
  BALL_FRICTION: 0.985,      // per frame at 60fps -> applied via dt
  BALL_FRICTION_DT: 1.6,     // linear damping coefficient (per sec)
  BALL_MAX_SPEED: 95,
  PASS_SPEED: 42,
  SHOOT_MIN: 50,
  SHOOT_MAX: 90,
  TACKLE_RADIUS: 2.6,
  TACKLE_COOLDOWN: 0.55,
  PASS_COOLDOWN: 0.25,
  SHOOT_COOLDOWN: 0.35,
  CONTROL_DIST: 1.7,         // distance ball is kept from player when dribbling
};

const MATCH = {
  HALF_SEC: 90,   // 1.5 minutes per half = 3 min total
  AI_REACT: 0.15, // AI decision interval
};

const TEAM_COLORS = {
  home: { primary: '#1976d2', secondary: '#5cd6ff', text: '#fff' },
  away: { primary: '#c62828', secondary: '#ff7a7a', text: '#fff' },
};

// ============= STATE =============
const State = {
  screen: 'menu',
  mode: 'ai',           // 'ai' | 'online'
  difficulty: 'normal', // 'easy' | 'normal' | 'hard'
  paused: false,
  ended: false,

  // online
  peer: null,
  conn: null,
  isHost: false,
  netLastSent: 0,
  netLastRecv: null,

  // input
  input: {
    move: { x: 0, y: 0 },
    pass: false,
    shootHeld: false,
    shootHeldT: 0,
    defenseTap: false,
  },

  // remote player input (when online)
  remoteInput: { x: 0, y: 0, pass: false, shoot: false, shootPower: 0, defense: false },

  // game objects
  ball: null,
  players: [],      // array of 6 players (3 per team) — 1 controlled + 2 AI per side
  controlled: { home: 0, away: 3 }, // indices into players[]
  scoreHome: 0,
  scoreAway: 0,
  half: 1,
  timeLeft: MATCH.HALF_SEC,
  lastGoalSide: null,
  resetTimer: 0,
  kickoffSide: 'home', // who kicks off
  announceUntil: 0,
};

// ============= UTILITIES =============
const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
const len = (x, y) => Math.hypot(x, y);
const norm = (x, y) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const lerp = (a, b, t) => a + (b - a) * t;

function randomCode() {
  return 'PF-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

// ============= CANVAS / RENDER =============
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
let DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
let view = { w: 0, h: 0, scale: 1, ox: 0, oy: 0 };

function resizeCanvas() {
  DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.floor(w * DPR);
  canvas.height = Math.floor(h * DPR);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  // compute field scale so that field + margins fit
  const fieldW = FIELD.W + FIELD.MARGIN * 2;
  const fieldH = FIELD.H + FIELD.MARGIN * 2;
  const sX = w / fieldW;
  const sY = h / fieldH;
  view.scale = Math.min(sX, sY);
  view.w = w; view.h = h;
  view.ox = (w - FIELD.W * view.scale) / 2;
  view.oy = (h - FIELD.H * view.scale) / 2;
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 80));

// In online mode for joiner, mirror field so their team plays L->R from their view
function isMirrored() {
  return State.mode === 'online' && !State.isHost;
}
function wx(x) {
  if (isMirrored()) return view.ox + (FIELD.W - x) * view.scale;
  return view.ox + x * view.scale;
}
function wy(y) { return view.oy + y * view.scale; }
function ws(v) { return v * view.scale; }

// ============= GAME OBJECTS =============
function makeBall() {
  return { x: FIELD.W / 2, y: FIELD.H / 2, vx: 0, vy: 0, owner: null };
}
function makePlayer(team, role, x, y) {
  return {
    team, role, // 'gk' | 'def' | 'fwd' | 'mid'
    x, y, vx: 0, vy: 0,
    facing: team === 'home' ? 0 : Math.PI,
    tackleCd: 0, passCd: 0, shootCd: 0,
    stun: 0,
  };
}

function setupKickoff(side) {
  // side: who kicks off ('home' kicks toward right (+x), 'away' kicks toward left)
  const cx = FIELD.W / 2, cy = FIELD.H / 2;
  State.ball.x = cx; State.ball.y = cy; State.ball.vx = 0; State.ball.vy = 0; State.ball.owner = null;

  // Home team (attacks right). 3 players
  State.players = [
    // home
    makePlayer('home', 'gk',  3,                      cy),                // 0: GK
    makePlayer('home', 'def', FIELD.W * 0.28,         cy - 10),           // 1: DEF
    makePlayer('home', 'fwd', side === 'home' ? cx - 1.2 : FIELD.W * 0.32, side === 'home' ? cy : cy + 10), // 2: FWD/controlled
    // away
    makePlayer('away', 'gk',  FIELD.W - 3,            cy),                // 3: GK
    makePlayer('away', 'def', FIELD.W * 0.72,         cy + 10),           // 4: DEF
    makePlayer('away', 'fwd', side === 'away' ? cx + 1.2 : FIELD.W * 0.68, side === 'away' ? cy : cy - 10), // 5: FWD/controlled
  ];
  State.controlled.home = 2;
  State.controlled.away = 5;
  State.resetTimer = 0.6; // small pause
}

function startMatch() {
  State.scoreHome = 0; State.scoreAway = 0;
  State.half = 1; State.timeLeft = MATCH.HALF_SEC;
  State.ended = false; State.paused = false;
  State.ball = makeBall();
  State.kickoffSide = 'home';
  setupKickoff('home');
  announce('KICK OFF!', 1200);
  showScreen('game');
}

// ============= ANNOUNCEMENTS =============
const annEl = document.getElementById('announcement');
function announce(text, ms = 1500) {
  annEl.textContent = text;
  annEl.classList.add('show');
  State.announceUntil = performance.now() + ms;
}
function tickAnnouncement() {
  if (annEl.classList.contains('show') && performance.now() > State.announceUntil) {
    annEl.classList.remove('show');
  }
}

// ============= PHYSICS / UPDATE =============
function update(dt) {
  if (State.paused || State.ended) return;

  // Timer
  if (State.resetTimer > 0) {
    State.resetTimer -= dt;
  } else {
    State.timeLeft -= dt;
    if (State.timeLeft <= 0) {
      State.timeLeft = 0;
      if (State.half === 1) {
        State.half = 2;
        State.timeLeft = MATCH.HALF_SEC;
        State.kickoffSide = 'away';
        setupKickoff('away');
        announce('HALF TIME', 1500);
      } else {
        endMatch();
        return;
      }
    }
  }

  // Decide active inputs for each team
  const homeIn = getHomeInput();
  const awayIn = getAwayInput();

  // Update players
  for (let i = 0; i < State.players.length; i++) {
    const p = State.players[i];
    p.tackleCd = Math.max(0, p.tackleCd - dt);
    p.passCd   = Math.max(0, p.passCd - dt);
    p.shootCd  = Math.max(0, p.shootCd - dt);
    p.stun     = Math.max(0, p.stun - dt);
  }

  // Apply controlled player inputs
  applyTeamControl('home', homeIn, dt);
  applyTeamControl('away', awayIn, dt);

  // AI for non-controlled players (both teams)
  aiNonControlled(dt);

  // Move players (integrate)
  for (const p of State.players) {
    if (p.stun > 0) { p.vx *= 0.9; p.vy *= 0.9; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    // Field bounds (allow GK to go a bit into goal box)
    p.x = clamp(p.x, 1, FIELD.W - 1);
    p.y = clamp(p.y, 1, FIELD.H - 1);
    p.vx *= 0.82;
    p.vy *= 0.82;
  }

  // Player-player collisions (simple push)
  for (let i = 0; i < State.players.length; i++) {
    for (let j = i + 1; j < State.players.length; j++) {
      resolvePlayerCollision(State.players[i], State.players[j]);
    }
  }

  // Ball physics
  updateBall(dt);

  // Ball possession / dribble
  resolveBallOwnership();

  // Goal check
  checkGoal();
}

function applyTeamControl(team, input, dt) {
  const idx = team === 'home' ? State.controlled.home : State.controlled.away;
  const p = State.players[idx];
  if (!p || p.stun > 0) return;

  const owner = State.ball.owner;
  const hasBall = owner === p;

  // Movement
  let mx = input.move.x, my = input.move.y;
  const ml = Math.hypot(mx, my);
  if (ml > 0.05) {
    if (ml > 1) { mx /= ml; my /= ml; }
    const spd = hasBall ? PHYS.PLAYER_SPEED_DRIBBLE : PHYS.PLAYER_SPEED_NOBALL;
    p.vx = mx * spd;
    p.vy = my * spd;
    p.facing = Math.atan2(my, mx);
  }

  // Defense: switch to closest defender + tackle
  if (input.defenseTap) {
    // switch control to closest player to ball on this team
    let best = idx, bd = Infinity;
    for (let i = 0; i < State.players.length; i++) {
      const q = State.players[i];
      if (q.team !== team) continue;
      if (q.role === 'gk') continue;
      const d = dist2(q, State.ball);
      if (d < bd) { bd = d; best = i; }
    }
    if (team === 'home') State.controlled.home = best;
    else State.controlled.away = best;

    // Attempt tackle on owner (if close enough)
    const cp = State.players[best];
    if (State.ball.owner && State.ball.owner.team !== team && cp.tackleCd <= 0) {
      const d2 = dist2(cp, State.ball.owner);
      if (d2 < PHYS.TACKLE_RADIUS * PHYS.TACKLE_RADIUS) {
        // success: dispossess
        const dir = norm(cp.x - State.ball.owner.x, cp.y - State.ball.owner.y);
        State.ball.owner.stun = 0.35;
        State.ball.owner = null;
        // kick the ball slightly away from tackler so they can pick it up
        State.ball.vx = dir.x * 6 + (Math.random() - 0.5) * 4;
        State.ball.vy = dir.y * 6 + (Math.random() - 0.5) * 4;
        cp.tackleCd = PHYS.TACKLE_COOLDOWN;
      } else {
        cp.tackleCd = PHYS.TACKLE_COOLDOWN * 0.6;
      }
    }
  }

  // Pass
  if (input.pass && hasBall && p.passCd <= 0) {
    doPass(p);
    p.passCd = PHYS.PASS_COOLDOWN;
  }

  // Shoot (released with power)
  if (input.shootReleased && hasBall && p.shootCd <= 0) {
    doShoot(p, input.shootPower);
    p.shootCd = PHYS.SHOOT_COOLDOWN;
  }
}

function doPass(p) {
  // pass to nearest teammate (not GK) in forward direction relative to facing
  let best = null, bestScore = -Infinity;
  for (const t of State.players) {
    if (t === p || t.team !== p.team || t.role === 'gk') continue;
    const dx = t.x - p.x, dy = t.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d < 2) continue;
    // prefer teammates in facing direction
    const dot = (dx / d) * Math.cos(p.facing) + (dy / d) * Math.sin(p.facing);
    const score = dot * 8 - d * 0.05;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  let dirX, dirY;
  if (best) {
    // lead the pass a bit (predict)
    const tx = best.x + best.vx * 0.2;
    const ty = best.y + best.vy * 0.2;
    const d = norm(tx - p.x, ty - p.y);
    dirX = d.x; dirY = d.y;
    // auto-switch control of attacking team to receiver
    if (best.team === 'home') State.controlled.home = State.players.indexOf(best);
    else State.controlled.away = State.players.indexOf(best);
  } else {
    dirX = Math.cos(p.facing);
    dirY = Math.sin(p.facing);
  }
  // release ball
  State.ball.owner = null;
  State.ball.vx = dirX * PHYS.PASS_SPEED;
  State.ball.vy = dirY * PHYS.PASS_SPEED;
  // give a small forward kick offset
  State.ball.x = p.x + dirX * (PHYS.PLAYER_R + PHYS.BALL_R + 0.2);
  State.ball.y = p.y + dirY * (PHYS.PLAYER_R + PHYS.BALL_R + 0.2);
}

function doShoot(p, power01) {
  const power = clamp(power01, 0.15, 1);
  // Aim towards opponent goal center, with some accuracy based on facing
  const goalX = p.team === 'home' ? FIELD.W : 0;
  const goalY = FIELD.H / 2 + (Math.random() - 0.5) * 6 * (1 - power * 0.6);
  // blend goal-aim with player's facing (some user control via stick)
  const aimX = goalX - p.x;
  const aimY = goalY - p.y;
  const aim = norm(aimX, aimY);
  const fx = Math.cos(p.facing), fy = Math.sin(p.facing);
  // weight: stronger facing influence if pointing toward goal hemisphere
  const facingToGoal = (p.team === 'home' && fx > 0) || (p.team === 'away' && fx < 0);
  const w = facingToGoal ? 0.45 : 0.15;
  let dx = aim.x * (1 - w) + fx * w;
  let dy = aim.y * (1 - w) + fy * w;
  const dn = norm(dx, dy);

  const speed = lerp(PHYS.SHOOT_MIN, PHYS.SHOOT_MAX, power);
  State.ball.owner = null;
  State.ball.x = p.x + dn.x * (PHYS.PLAYER_R + PHYS.BALL_R + 0.2);
  State.ball.y = p.y + dn.y * (PHYS.PLAYER_R + PHYS.BALL_R + 0.2);
  State.ball.vx = dn.x * speed;
  State.ball.vy = dn.y * speed;
}

function updateBall(dt) {
  const b = State.ball;
  if (b.owner) {
    // glue ball to owner with offset in facing direction
    const dx = Math.cos(b.owner.facing);
    const dy = Math.sin(b.owner.facing);
    const tx = b.owner.x + dx * PHYS.CONTROL_DIST;
    const ty = b.owner.y + dy * PHYS.CONTROL_DIST;
    b.x = lerp(b.x, tx, Math.min(1, dt * 22));
    b.y = lerp(b.y, ty, Math.min(1, dt * 22));
    b.vx = b.owner.vx;
    b.vy = b.owner.vy;
    return;
  }
  // friction
  const sp = Math.hypot(b.vx, b.vy);
  if (sp > 0) {
    const decel = Math.min(sp, PHYS.BALL_FRICTION_DT * dt * (10 + sp * 0.45));
    const f = (sp - decel) / sp;
    b.vx *= f; b.vy *= f;
  }
  // limit speed
  const sp2 = Math.hypot(b.vx, b.vy);
  if (sp2 > PHYS.BALL_MAX_SPEED) {
    b.vx = b.vx / sp2 * PHYS.BALL_MAX_SPEED;
    b.vy = b.vy / sp2 * PHYS.BALL_MAX_SPEED;
  }
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  // Bounce off sidelines (top / bottom), but allow ball to enter goals through the goal mouth (handled in goal check)
  if (b.y < PHYS.BALL_R) { b.y = PHYS.BALL_R; b.vy = -b.vy * 0.7; }
  if (b.y > FIELD.H - PHYS.BALL_R) { b.y = FIELD.H - PHYS.BALL_R; b.vy = -b.vy * 0.7; }
  // left/right: bounce unless ball is within goal mouth Y range (then it goes for goal)
  const goalTop = FIELD.H / 2 - FIELD.GOAL_W / 2;
  const goalBot = FIELD.H / 2 + FIELD.GOAL_W / 2;
  if (b.x < PHYS.BALL_R && (b.y < goalTop || b.y > goalBot)) { b.x = PHYS.BALL_R; b.vx = -b.vx * 0.7; }
  if (b.x > FIELD.W - PHYS.BALL_R && (b.y < goalTop || b.y > goalBot)) { b.x = FIELD.W - PHYS.BALL_R; b.vx = -b.vx * 0.7; }
}

function resolveBallOwnership() {
  const b = State.ball;
  if (b.owner) {
    // can be lost if owner stunned
    if (b.owner.stun > 0) b.owner = null;
    else return;
  }
  // Find player nearest to ball; if within capture radius and ball is slowish (or anyone) -> take possession
  let nearest = null, nd = Infinity;
  for (const p of State.players) {
    if (p.stun > 0) continue;
    const d = dist2(p, b);
    if (d < nd) { nd = d; nearest = p; }
  }
  if (nearest && nd < (PHYS.PLAYER_R + PHYS.BALL_R + 0.6) ** 2) {
    // grant possession; if ball was fast, only grant if moving slow OR player is facing the ball
    const bs = Math.hypot(b.vx, b.vy);
    if (bs < 30 || nearest.role === 'gk' || nd < (PHYS.PLAYER_R + 0.3) ** 2) {
      b.owner = nearest;
      // auto-switch control to receiver if it's same team's controlled-side selection
      if (nearest.team === 'home') {
        // only switch to FWD-ish; allow any non-GK
        if (nearest.role !== 'gk') State.controlled.home = State.players.indexOf(nearest);
      } else if (nearest.team === 'away' && State.mode === 'online') {
        if (nearest.role !== 'gk') State.controlled.away = State.players.indexOf(nearest);
      } else if (nearest.team === 'away') {
        if (nearest.role !== 'gk') State.controlled.away = State.players.indexOf(nearest);
      }
    }
  }
}

function resolvePlayerCollision(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const minD = PHYS.PLAYER_R * 2;
  if (d > 0 && d < minD) {
    const overlap = (minD - d) / 2;
    const nx = dx / d, ny = dy / d;
    a.x -= nx * overlap; a.y -= ny * overlap;
    b.x += nx * overlap; b.y += ny * overlap;
    // slight elastic bump
    const relV = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (relV < 0) {
      a.vx += nx * relV * 0.4; a.vy += ny * relV * 0.4;
      b.vx -= nx * relV * 0.4; b.vy -= ny * relV * 0.4;
    }
  }
}

function checkGoal() {
  if (State.resetTimer > 0) return;
  const b = State.ball;
  const goalTop = FIELD.H / 2 - FIELD.GOAL_W / 2;
  const goalBot = FIELD.H / 2 + FIELD.GOAL_W / 2;

  // Home scores when ball goes past right line within goal mouth
  if (b.x >= FIELD.W - 0.1 && b.y > goalTop && b.y < goalBot) {
    State.scoreHome++;
    announce('GOAL!', 1800);
    flashBoard();
    State.kickoffSide = 'away';
    setupKickoff('away');
    State.resetTimer = 1.8;
    sendNetState(true);
  }
  if (b.x <= 0.1 && b.y > goalTop && b.y < goalBot) {
    State.scoreAway++;
    announce('GOAL!', 1800);
    flashBoard();
    State.kickoffSide = 'home';
    setupKickoff('home');
    State.resetTimer = 1.8;
    sendNetState(true);
  }
}

function flashBoard() {
  const sb = document.querySelector('.score-board');
  sb.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }],
    { duration: 500, easing: 'ease-out' }
  );
}

function endMatch() {
  State.ended = true;
  const overlay = document.getElementById('result-overlay');
  const title = document.getElementById('result-title');
  const score = document.getElementById('final-score');
  const msg = document.getElementById('result-msg');
  score.textContent = `${State.scoreHome} - ${State.scoreAway}`;
  if (State.scoreHome > State.scoreAway) {
    title.textContent = State.mode === 'ai' ? 'WIN! 🏆' : (State.isHost ? 'WIN! 🏆' : 'LOSE...');
    msg.textContent = State.mode === 'ai' ? 'よくやった！' : '';
  } else if (State.scoreHome < State.scoreAway) {
    title.textContent = State.mode === 'ai' ? 'LOSE...' : (State.isHost ? 'LOSE...' : 'WIN! 🏆');
    msg.textContent = '';
  } else {
    title.textContent = 'DRAW';
    msg.textContent = '引き分け';
  }
  overlay.classList.add('active');
}

// ============= AI =============
function aiNonControlled(dt) {
  // For each player NOT the currently-controlled one of their team (or AI side), run lightweight AI
  for (let i = 0; i < State.players.length; i++) {
    const p = State.players[i];
    const teamControlledIdx = p.team === 'home' ? State.controlled.home : State.controlled.away;
    const isControlled = (i === teamControlledIdx);

    // Away side fully AI when mode is 'ai'
    if (State.mode === 'online' && p.team === 'away') {
      // Away team: controlled player is driven by remote input; others are AI helpers
      if (isControlled) continue;
    }
    if (State.mode === 'ai' && p.team === 'away') {
      // all away players are AI; controlled-away is the "active" AI brain
      runAIForPlayer(p, isControlled, dt);
      continue;
    }
    // Home team's non-controlled players: AI helpers
    if (p.team === 'home' && !isControlled) {
      runAIForPlayer(p, false, dt);
    }
    // Away team in online mode, non-controlled: AI helper
    if (p.team === 'away' && State.mode === 'online' && !isControlled) {
      runAIForPlayer(p, false, dt);
    }
  }
}

function runAIForPlayer(p, isActive, dt) {
  if (p.stun > 0) return;
  const b = State.ball;
  const ownerTeam = b.owner ? b.owner.team : null;
  const myGoal = p.team === 'home' ? { x: 0, y: FIELD.H / 2 } : { x: FIELD.W, y: FIELD.H / 2 };
  const oppGoal = p.team === 'home' ? { x: FIELD.W, y: FIELD.H / 2 } : { x: 0, y: FIELD.H / 2 };

  // GK behavior: stay on goal line, track ball Y
  if (p.role === 'gk') {
    const targetY = clamp(b.y, FIELD.H / 2 - FIELD.GOAL_W / 2 + 1, FIELD.H / 2 + FIELD.GOAL_W / 2 - 1);
    const targetX = p.team === 'home' ? 2.5 : FIELD.W - 2.5;
    moveToward(p, targetX, targetY, 16);
    // facing
    const dx = b.x - p.x, dy = b.y - p.y;
    p.facing = Math.atan2(dy, dx);
    return;
  }

  // If active AI (controlling player on away team for AI mode), handle ball/play logic
  if (isActive && State.mode === 'ai' && p.team === 'away') {
    activeAILogic(p, dt);
    return;
  }

  // Supporting player AI
  let targetX, targetY;
  if (ownerTeam === p.team) {
    // attacking: move forward, find space
    const offsetY = (p.role === 'def') ? (p === State.players[1] ? -8 : 8) : (Math.sin(performance.now() / 1500 + p.x) * 6);
    if (p.team === 'home') {
      targetX = clamp(b.x + 12, 10, FIELD.W - 12);
    } else {
      targetX = clamp(b.x - 12, 12, FIELD.W - 10);
    }
    targetY = clamp(FIELD.H / 2 + offsetY, 6, FIELD.H - 6);
    if (p.role === 'def') {
      // defender holds back
      targetX = p.team === 'home' ? clamp(b.x - 8, 8, FIELD.W * 0.5) : clamp(b.x + 8, FIELD.W * 0.5, FIELD.W - 8);
    }
  } else {
    // defending: chase ball or cover goal
    if (p.role === 'def') {
      targetX = p.team === 'home' ? clamp(b.x - 4, 6, FIELD.W * 0.45) : clamp(b.x + 4, FIELD.W * 0.55, FIELD.W - 6);
      targetY = clamp(b.y, 6, FIELD.H - 6);
    } else {
      // forward presses ball lightly
      targetX = b.x;
      targetY = b.y;
    }
  }
  moveToward(p, targetX, targetY, PHYS.PLAYER_SPEED_NOBALL * 0.85);
  // facing
  const dx = b.x - p.x, dy = b.y - p.y;
  if (Math.hypot(dx, dy) > 0.2) p.facing = Math.atan2(dy, dx);

  // If I happen to have ball as supporting AI: do a smart pass/shoot
  if (b.owner === p) {
    handleAIWithBall(p);
  }
}

function activeAILogic(p, dt) {
  const b = State.ball;
  const oppGoal = p.team === 'home' ? { x: FIELD.W, y: FIELD.H / 2 } : { x: 0, y: FIELD.H / 2 };

  if (b.owner === p) {
    // dribble toward goal
    const dirGoal = norm(oppGoal.x - p.x, oppGoal.y - p.y);
    const distGoal = Math.hypot(oppGoal.x - p.x, oppGoal.y - p.y);
    p.vx = dirGoal.x * PHYS.PLAYER_SPEED_DRIBBLE;
    p.vy = dirGoal.y * PHYS.PLAYER_SPEED_DRIBBLE;
    p.facing = Math.atan2(dirGoal.y, dirGoal.x);
    handleAIWithBall(p);
    return;
  }

  if (b.owner && b.owner.team !== p.team) {
    // pressure ball carrier
    moveToward(p, b.owner.x, b.owner.y, PHYS.PLAYER_SPEED_NOBALL);
    // try tackle if close
    if (Math.hypot(p.x - b.owner.x, p.y - b.owner.y) < PHYS.TACKLE_RADIUS && p.tackleCd <= 0) {
      // attempt tackle
      const succ = Math.random() < (State.difficulty === 'hard' ? 0.55 : State.difficulty === 'normal' ? 0.4 : 0.28);
      p.tackleCd = PHYS.TACKLE_COOLDOWN;
      if (succ) {
        const dir = norm(p.x - b.owner.x, p.y - b.owner.y);
        b.owner.stun = 0.3;
        b.owner = null;
        b.vx = dir.x * 6; b.vy = dir.y * 6;
      }
    }
    return;
  }

  // Loose ball: go get it (predict)
  const tx = b.x + b.vx * 0.15;
  const ty = b.y + b.vy * 0.15;
  moveToward(p, tx, ty, PHYS.PLAYER_SPEED_NOBALL);
  p.facing = Math.atan2(b.y - p.y, b.x - p.x);
}

function handleAIWithBall(p) {
  const oppGoal = p.team === 'home' ? { x: FIELD.W, y: FIELD.H / 2 } : { x: 0, y: FIELD.H / 2 };
  const dxg = oppGoal.x - p.x, dyg = oppGoal.y - p.y;
  const dg = Math.hypot(dxg, dyg);

  // Shoot if close & cooldown ok
  const shootThresh = State.difficulty === 'hard' ? 28 : State.difficulty === 'normal' ? 24 : 20;
  if (dg < shootThresh && p.shootCd <= 0 && Math.random() < 0.07) {
    const power = lerp(0.5, 1, Math.max(0, 1 - dg / shootThresh));
    doShoot(p, power);
    p.shootCd = PHYS.SHOOT_COOLDOWN;
    return;
  }

  // Pass if marked
  let pressure = 0;
  for (const op of State.players) {
    if (op.team === p.team) continue;
    if (op.role === 'gk') continue;
    const d = Math.hypot(op.x - p.x, op.y - p.y);
    if (d < 5) pressure++;
  }
  if (pressure >= 1 && p.passCd <= 0 && Math.random() < 0.04) {
    doPass(p);
    p.passCd = PHYS.PASS_COOLDOWN;
  }
}

function moveToward(p, tx, ty, speed) {
  const dx = tx - p.x, dy = ty - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.3) { p.vx *= 0.6; p.vy *= 0.6; return; }
  p.vx = (dx / d) * speed;
  p.vy = (dy / d) * speed;
}

// ============= INPUT (Joystick + Buttons) =============
const joystickEl = document.getElementById('joystick');
const joystickStick = document.getElementById('joystick-stick');
let joyActive = false, joyId = null, joyCx = 0, joyCy = 0, joyR = 55;

function joyStart(e, t) {
  joyActive = true;
  joyId = t.identifier;
  const rect = joystickEl.getBoundingClientRect();
  joyCx = rect.left + rect.width / 2;
  joyCy = rect.top + rect.height / 2;
  joyR = rect.width * 0.42;
  joyMove(t.clientX, t.clientY);
  e.preventDefault();
}
function joyMove(cx, cy) {
  let dx = cx - joyCx, dy = cy - joyCy;
  const d = Math.hypot(dx, dy);
  if (d > joyR) { dx = dx / d * joyR; dy = dy / d * joyR; }
  joystickStick.style.transform = `translate(${dx}px, ${dy}px)`;
  State.input.move.x = dx / joyR;
  State.input.move.y = dy / joyR;
}
function joyEnd() {
  joyActive = false; joyId = null;
  joystickStick.style.transform = 'translate(0,0)';
  State.input.move.x = 0; State.input.move.y = 0;
}

joystickEl.addEventListener('touchstart', e => {
  for (const t of e.changedTouches) { if (!joyActive) joyStart(e, t); }
}, { passive: false });
joystickEl.addEventListener('touchmove', e => {
  for (const t of e.changedTouches) { if (t.identifier === joyId) joyMove(t.clientX, t.clientY); }
  e.preventDefault();
}, { passive: false });
joystickEl.addEventListener('touchend', e => {
  for (const t of e.changedTouches) { if (t.identifier === joyId) joyEnd(); }
}, { passive: false });
joystickEl.addEventListener('touchcancel', e => {
  for (const t of e.changedTouches) { if (t.identifier === joyId) joyEnd(); }
}, { passive: false });

// Mouse fallback (for desktop testing)
joystickEl.addEventListener('mousedown', e => {
  joyActive = true;
  const rect = joystickEl.getBoundingClientRect();
  joyCx = rect.left + rect.width / 2;
  joyCy = rect.top + rect.height / 2;
  joyR = rect.width * 0.42;
  joyMove(e.clientX, e.clientY);
  const mv = ev => joyActive && joyMove(ev.clientX, ev.clientY);
  const up = () => { joyEnd(); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', mv);
  window.addEventListener('mouseup', up);
});

// Buttons
const btnPass = document.getElementById('btn-pass');
const btnShoot = document.getElementById('btn-shoot');
const btnDef = document.getElementById('btn-def');
const powerRing = document.getElementById('power-ring');

function bindTap(el, onDown, onUp) {
  el.addEventListener('touchstart', e => { e.preventDefault(); onDown && onDown(); }, { passive: false });
  el.addEventListener('touchend', e => { e.preventDefault(); onUp && onUp(); }, { passive: false });
  el.addEventListener('touchcancel', e => { e.preventDefault(); onUp && onUp(); }, { passive: false });
  el.addEventListener('mousedown', e => { e.preventDefault(); onDown && onDown(); });
  el.addEventListener('mouseup', e => { e.preventDefault(); onUp && onUp(); });
  el.addEventListener('mouseleave', e => { onUp && onUp(); });
}

bindTap(btnPass, () => { State.input.pass = true; }, () => {});
bindTap(btnDef, () => { State.input.defenseTap = true; }, () => {});
bindTap(btnShoot,
  () => { State.input.shootHeld = true; State.input.shootHeldT = 0; },
  () => {
    if (State.input.shootHeld) {
      State.input.shootReleased = true;
      State.input.shootPower = clamp(State.input.shootHeldT / 1.2, 0.2, 1);
    }
    State.input.shootHeld = false;
  }
);

function getHomeInput() {
  // gather and reset edge events
  const out = {
    move: { x: State.input.move.x, y: State.input.move.y },
    pass: State.input.pass,
    defenseTap: State.input.defenseTap,
    shootReleased: !!State.input.shootReleased,
    shootPower: State.input.shootPower || 0,
  };
  State.input.pass = false;
  State.input.defenseTap = false;
  State.input.shootReleased = false;
  // accumulate shoot held time
  if (State.input.shootHeld) {
    State.input.shootHeldT += 1 / 60;
    const ratio = clamp(State.input.shootHeldT / 1.2, 0, 1);
    powerRing.style.clipPath = `inset(0 ${(1 - ratio) * 100}% 0 0)`;
  } else {
    powerRing.style.clipPath = `inset(0 100% 0 0)`;
  }
  return out;
}

function getAwayInput() {
  if (State.mode === 'online') {
    // remote input
    const r = State.remoteInput;
    // Mirror X axis: away controls feel intuitive on their device.
    // Convention: remote sends in their own coordinate frame; we mirror here.
    const out = {
      move: { x: -r.x, y: r.y },
      pass: r.pass,
      defenseTap: r.defense,
      shootReleased: r.shoot,
      shootPower: r.shootPower || 0,
    };
    r.pass = false; r.defense = false; r.shoot = false;
    return out;
  }
  // AI mode: away input is driven inside aiNonControlled
  return { move: { x: 0, y: 0 }, pass: false, defenseTap: false, shootReleased: false, shootPower: 0 };
}

// ============= RENDER =============
function render() {
  ctx.save();
  ctx.scale(DPR, DPR);
  // bg
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, view.w, view.h);

  drawField();
  drawShadows();
  drawBall();
  drawPlayers();
  drawGoals();
  drawControlIndicator();
  drawPowerArrow();

  ctx.restore();
}

function drawField() {
  // Grass with subtle stripes
  const fx = wx(0), fy = wy(0);
  const fw = ws(FIELD.W), fh = ws(FIELD.H);
  // outer margin (border)
  ctx.fillStyle = '#0e2a18';
  ctx.fillRect(fx - ws(FIELD.MARGIN), fy - ws(FIELD.MARGIN), fw + ws(FIELD.MARGIN * 2), fh + ws(FIELD.MARGIN * 2));
  // pitch base
  const grad = ctx.createLinearGradient(0, fy, 0, fy + fh);
  grad.addColorStop(0, '#1d6a3a');
  grad.addColorStop(0.5, '#1a5d33');
  grad.addColorStop(1, '#16522c');
  ctx.fillStyle = grad;
  ctx.fillRect(fx, fy, fw, fh);
  // stripes
  const stripeCount = 12;
  const stripeW = fw / stripeCount;
  for (let i = 0; i < stripeCount; i++) {
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.04)';
    ctx.fillRect(fx + i * stripeW, fy, stripeW, fh);
  }

  // Lines
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = Math.max(1, ws(0.18));
  ctx.strokeRect(fx, fy, fw, fh);

  // Halfway line
  ctx.beginPath();
  ctx.moveTo(fx + fw / 2, fy);
  ctx.lineTo(fx + fw / 2, fy + fh);
  ctx.stroke();

  // Center circle
  ctx.beginPath();
  ctx.arc(fx + fw / 2, fy + fh / 2, ws(7), 0, Math.PI * 2);
  ctx.stroke();
  // Center dot
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(fx + fw / 2, fy + fh / 2, ws(0.4), 0, Math.PI * 2);
  ctx.fill();

  // Penalty areas
  const py = (FIELD.H - FIELD.PENALTY_H) / 2;
  ctx.strokeRect(fx, fy + ws(py), ws(FIELD.PENALTY_W), ws(FIELD.PENALTY_H));
  ctx.strokeRect(fx + fw - ws(FIELD.PENALTY_W), fy + ws(py), ws(FIELD.PENALTY_W), ws(FIELD.PENALTY_H));

  // Small goal areas
  const gay = (FIELD.H - 18) / 2;
  ctx.strokeRect(fx, fy + ws(gay), ws(6), ws(18));
  ctx.strokeRect(fx + fw - ws(6), fy + ws(gay), ws(6), ws(18));
}

function drawGoals() {
  const goalTopY = FIELD.H / 2 - FIELD.GOAL_W / 2;
  // left goal (home defends)
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(1, ws(0.25));
  ctx.fillRect(wx(-FIELD.GOAL_DEPTH), wy(goalTopY), ws(FIELD.GOAL_DEPTH), ws(FIELD.GOAL_W));
  ctx.strokeRect(wx(-FIELD.GOAL_DEPTH), wy(goalTopY), ws(FIELD.GOAL_DEPTH), ws(FIELD.GOAL_W));
  // net pattern
  drawNet(wx(-FIELD.GOAL_DEPTH), wy(goalTopY), ws(FIELD.GOAL_DEPTH), ws(FIELD.GOAL_W));

  // right goal (away defends)
  ctx.fillRect(wx(FIELD.W), wy(goalTopY), ws(FIELD.GOAL_DEPTH), ws(FIELD.GOAL_W));
  ctx.strokeRect(wx(FIELD.W), wy(goalTopY), ws(FIELD.GOAL_DEPTH), ws(FIELD.GOAL_W));
  drawNet(wx(FIELD.W), wy(goalTopY), ws(FIELD.GOAL_DEPTH), ws(FIELD.GOAL_W));
}

function drawNet(x, y, w, h) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  const step = Math.max(3, ws(0.6));
  for (let i = 0; i <= w; i += step) {
    ctx.beginPath(); ctx.moveTo(x + i, y); ctx.lineTo(x + i, y + h); ctx.stroke();
  }
  for (let j = 0; j <= h; j += step) {
    ctx.beginPath(); ctx.moveTo(x, y + j); ctx.lineTo(x + w, y + j); ctx.stroke();
  }
  ctx.restore();
}

function drawShadows() {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  for (const p of State.players) {
    ctx.beginPath();
    ctx.ellipse(wx(p.x) + ws(0.3), wy(p.y) + ws(0.5), ws(PHYS.PLAYER_R * 1.1), ws(PHYS.PLAYER_R * 0.5), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // ball shadow
  ctx.beginPath();
  ctx.ellipse(wx(State.ball.x) + ws(0.15), wy(State.ball.y) + ws(0.25), ws(PHYS.BALL_R * 1.2), ws(PHYS.BALL_R * 0.55), 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawPlayers() {
  for (let i = 0; i < State.players.length; i++) {
    const p = State.players[i];
    const isCtrlHome = (i === State.controlled.home);
    const isCtrlAway = (i === State.controlled.away);
    const isControlled = (p.team === 'home' && isCtrlHome) || (p.team === 'away' && isCtrlAway);
    const colors = TEAM_COLORS[p.team];

    const x = wx(p.x), y = wy(p.y), r = ws(PHYS.PLAYER_R);

    // Selection ring: bright for "my" controlled player, subtle for opponent's controlled
    const localTeam = isMirrored() ? 'away' : 'home';
    const myCtrl = (p.team === 'home' && isCtrlHome) || (p.team === 'away' && isCtrlAway);
    if (myCtrl && p.team === localTeam) {
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = Math.max(2, ws(0.18));
      ctx.beginPath();
      ctx.arc(x, y, r + ws(0.55), 0, Math.PI * 2);
      ctx.stroke();
      // little arrow above
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(x, y - r - ws(1.6));
      ctx.lineTo(x - ws(0.7), y - r - ws(0.7));
      ctx.lineTo(x + ws(0.7), y - r - ws(0.7));
      ctx.closePath();
      ctx.fill();
    } else if (myCtrl && p.team !== localTeam && State.mode === 'online') {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = Math.max(1, ws(0.12));
      ctx.beginPath();
      ctx.arc(x, y, r + ws(0.5), 0, Math.PI * 2);
      ctx.stroke();
    }

    // body
    const grad = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, r * 0.2, x, y, r);
    grad.addColorStop(0, colors.secondary);
    grad.addColorStop(1, colors.primary);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = Math.max(1, ws(0.1));
    ctx.stroke();

    // Direction indicator (mirror-aware)
    ctx.fillStyle = colors.text;
    const cosF = isMirrored() ? -Math.cos(p.facing) : Math.cos(p.facing);
    const sinF = Math.sin(p.facing);
    const fx = x + cosF * r * 0.55;
    const fy = y + sinF * r * 0.55;
    ctx.beginPath();
    ctx.arc(fx, fy, ws(0.32), 0, Math.PI * 2);
    ctx.fill();

    // GK marker
    if (p.role === 'gk') {
      ctx.fillStyle = 'rgba(255,255,200,0.95)';
      ctx.font = `bold ${Math.max(8, ws(1.2))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('GK', x, y);
    }
  }
}

function drawBall() {
  const b = State.ball;
  const x = wx(b.x), y = wy(b.y), r = ws(PHYS.BALL_R * 1.5);
  // ball
  const grad = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, r * 0.1, x, y, r);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, '#bbbbbb');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1;
  ctx.stroke();
  // pentagon
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(x, y, r * 0.3, 0, Math.PI * 2);
  ctx.fill();
}

function drawControlIndicator() {
  // Optional: trail dot on ball
  const b = State.ball;
  if (b.owner) {
    const x = wx(b.owner.x), y = wy(b.owner.y);
    ctx.strokeStyle = 'rgba(255, 220, 80, 0.7)';
    ctx.lineWidth = Math.max(1, ws(0.1));
    ctx.beginPath();
    ctx.arc(x, y, ws(PHYS.PLAYER_R + 0.9), 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawPowerArrow() {
  if (!State.input.shootHeld) return;
  // The local player controls "home" team if host or AI mode; "away" team if joiner
  const idx = isMirrored() ? State.controlled.away : State.controlled.home;
  const p = State.players[idx];
  if (!p) return;
  const power = clamp(State.input.shootHeldT / 1.2, 0, 1);
  if (power < 0.05) return;
  const x = wx(p.x), y = wy(p.y);
  const len = ws(3 + power * 7);
  // mirror facing for display
  const cosF = isMirrored() ? -Math.cos(p.facing) : Math.cos(p.facing);
  const sinF = Math.sin(p.facing);
  const ax = x + cosF * len;
  const ay = y + sinF * len;
  ctx.strokeStyle = `rgba(255, ${Math.round(220 - power * 120)}, 60, ${0.6 + power * 0.4})`;
  ctx.lineWidth = Math.max(2, ws(0.4));
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(ax, ay);
  ctx.stroke();
  // arrowhead
  const head = ws(1.1);
  const dispAng = Math.atan2(sinF, cosF);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax - Math.cos(dispAng - 0.5) * head, ay - Math.sin(dispAng - 0.5) * head);
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax - Math.cos(dispAng + 0.5) * head, ay - Math.sin(dispAng + 0.5) * head);
  ctx.stroke();
}

// ============= HUD UPDATE =============
function updateHUD() {
  // For joiner (mirrored view), swap the displayed scores so "YOU" (left) shows their team
  if (isMirrored()) {
    document.getElementById('home-score').textContent = State.scoreAway;
    document.getElementById('away-score').textContent = State.scoreHome;
  } else {
    document.getElementById('home-score').textContent = State.scoreHome;
    document.getElementById('away-score').textContent = State.scoreAway;
  }
  const t = Math.max(0, Math.ceil(State.timeLeft));
  const m = Math.floor(t / 60);
  const s = t % 60;
  document.getElementById('timer').textContent =
    `${State.half === 1 ? '1st ' : '2nd '}${m}:${s.toString().padStart(2,'0')}`;
}

// ============= NET (PeerJS) =============
function setupPeerHost() {
  // create peer with random short id
  const id = randomCode();
  State.isHost = true;
  State.peer = new Peer(id, { debug: 1 });
  const codeEl = document.getElementById('host-code');
  const statusEl = document.getElementById('host-status');
  codeEl.textContent = '接続中...';
  statusEl.textContent = '';
  State.peer.on('open', pid => {
    codeEl.textContent = pid;
  });
  State.peer.on('connection', conn => {
    State.conn = conn;
    bindConnection(conn);
    statusEl.textContent = '接続成功！試合を開始します...';
    statusEl.className = 'status-text success';
    setTimeout(() => {
      State.mode = 'online';
      startMatch();
      sendNet({ type: 'start' });
    }, 800);
  });
  State.peer.on('error', err => {
    statusEl.textContent = 'エラー: ' + err.type;
    statusEl.className = 'status-text error';
  });
}

function setupPeerJoin(code) {
  State.isHost = false;
  State.peer = new Peer(undefined, { debug: 1 });
  const statusEl = document.getElementById('join-status');
  statusEl.textContent = '接続中...';
  statusEl.className = 'status-text';
  State.peer.on('open', () => {
    const conn = State.peer.connect(code, { reliable: false });
    State.conn = conn;
    conn.on('open', () => {
      bindConnection(conn);
      statusEl.textContent = '接続成功！';
      statusEl.className = 'status-text success';
    });
    conn.on('error', err => {
      statusEl.textContent = 'エラー: ' + err;
      statusEl.className = 'status-text error';
    });
  });
  State.peer.on('error', err => {
    statusEl.textContent = 'エラー: ' + err.type;
    statusEl.className = 'status-text error';
  });
}

function bindConnection(conn) {
  conn.on('data', data => onNetMessage(data));
  conn.on('close', () => {
    announce('切断されました', 2000);
    setTimeout(() => quitToMenu(), 2000);
  });
}

function onNetMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'start') {
    State.mode = 'online';
    startMatch();
    // For joiner, swap displayed team names so "YOU" is on the left (mirrored view)
    if (!State.isHost) {
      document.getElementById('home-name').textContent = 'YOU';
      document.getElementById('away-name').textContent = 'OPP';
    }
  } else if (msg.type === 'input') {
    // remote (away) player's input — comes from joiner's POV
    State.remoteInput.x = msg.x || 0;
    State.remoteInput.y = msg.y || 0;
    if (msg.pass) State.remoteInput.pass = true;
    if (msg.defense) State.remoteInput.defense = true;
    if (msg.shoot) { State.remoteInput.shoot = true; State.remoteInput.shootPower = msg.shootPower || 0.6; }
  } else if (msg.type === 'state') {
    // joiner receives authoritative state
    applyAuthState(msg);
  }
}

function sendNet(msg) {
  if (State.conn && State.conn.open) {
    try { State.conn.send(msg); } catch (e) {}
  }
}

function sendNetInputFromJoiner() {
  // Joiner sends its inputs to host. Joiner controls AWAY team but on their screen the active player is shown on left side.
  // We need to mirror their joystick so their "forward" feels right.
  // The simplest: joiner views the field mirrored so their team is on left visually.
  // For simplicity, we don't visually mirror — we ask the host to mirror input X axis (done in getAwayInput).
  const inp = {
    type: 'input',
    x: State.input.move.x,
    y: State.input.move.y,
    pass: State.input.pass,
    defense: State.input.defenseTap,
    shoot: !!State.input.shootReleased,
    shootPower: State.input.shootPower || 0,
  };
  State.input.pass = false;
  State.input.defenseTap = false;
  State.input.shootReleased = false;
  sendNet(inp);
}

function sendNetState(force) {
  if (!State.isHost) return;
  const now = performance.now();
  if (!force && now - State.netLastSent < 40) return; // ~25Hz
  State.netLastSent = now;
  const msg = {
    type: 'state',
    t: now,
    b: { x: State.ball.x, y: State.ball.y, vx: State.ball.vx, vy: State.ball.vy, owner: State.players.indexOf(State.ball.owner) },
    p: State.players.map(pl => ({ x: pl.x, y: pl.y, f: pl.facing, st: pl.stun })),
    sh: State.scoreHome, sa: State.scoreAway,
    tl: State.timeLeft, hf: State.half, rt: State.resetTimer,
    ch: State.controlled.home, ca: State.controlled.away,
    end: State.ended,
  };
  sendNet(msg);
}

function applyAuthState(s) {
  // joiner applies host state (interpolate slightly)
  if (!State.ball) { State.ball = makeBall(); State.players = []; }
  State.ball.x = s.b.x; State.ball.y = s.b.y;
  State.ball.vx = s.b.vx; State.ball.vy = s.b.vy;
  if (s.p && s.p.length) {
    if (State.players.length !== s.p.length) {
      // rebuild
      const teams = ['home','home','home','away','away','away'];
      const roles = ['gk','def','fwd','gk','def','fwd'];
      State.players = s.p.map((sp, i) => {
        const pl = makePlayer(teams[i], roles[i], sp.x, sp.y);
        pl.facing = sp.f; pl.stun = sp.st;
        return pl;
      });
    } else {
      for (let i = 0; i < s.p.length; i++) {
        const target = s.p[i], pl = State.players[i];
        pl.x = lerp(pl.x, target.x, 0.6);
        pl.y = lerp(pl.y, target.y, 0.6);
        pl.facing = target.f;
        pl.stun = target.st;
      }
    }
  }
  State.ball.owner = (s.b.owner >= 0 && State.players[s.b.owner]) ? State.players[s.b.owner] : null;
  State.scoreHome = s.sh; State.scoreAway = s.sa;
  State.timeLeft = s.tl; State.half = s.hf; State.resetTimer = s.rt;
  State.controlled.home = s.ch; State.controlled.away = s.ca;
  State.ended = s.end;
  if (State.ended) {
    // joiner shows result based on home/away with swapped perspective
    endMatch();
  }
}

// ============= LOOP =============
let lastTime = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (State.screen === 'game') {
    if (State.mode === 'online' && !State.isHost) {
      // Joiner: don't simulate; just send inputs and render last received state
      sendNetInputFromJoiner();
      // Still ticking joystick power display
      if (State.input.shootHeld) {
        State.input.shootHeldT += dt;
        const ratio = clamp(State.input.shootHeldT / 1.2, 0, 1);
        powerRing.style.clipPath = `inset(0 ${(1 - ratio) * 100}% 0 0)`;
      } else {
        powerRing.style.clipPath = `inset(0 100% 0 0)`;
      }
    } else {
      update(dt);
      if (State.mode === 'online' && State.isHost) sendNetState(false);
    }
    if (State.ball && State.players.length) render();
    updateHUD();
    tickAnnouncement();
  }
  requestAnimationFrame(loop);
}

// ============= SCREEN MGMT =============
function showScreen(name) {
  ['menu','howto','online','game'].forEach(s => {
    document.getElementById(s).classList.toggle('active', s === name);
  });
  State.screen = name;
}

function quitToMenu() {
  State.ended = true;
  State.paused = false;
  document.getElementById('pause-overlay').classList.remove('active');
  document.getElementById('result-overlay').classList.remove('active');
  if (State.conn) { try { State.conn.close(); } catch (e) {} State.conn = null; }
  if (State.peer) { try { State.peer.destroy(); } catch (e) {} State.peer = null; }
  showScreen('menu');
}

// ============= MENU WIRING =============
document.querySelectorAll('.diff-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    State.difficulty = b.dataset.diff;
  });
});

document.querySelectorAll('#menu .menu-btn').forEach(b => {
  b.addEventListener('click', () => {
    const a = b.dataset.action;
    if (a === 'ai') {
      State.mode = 'ai';
      document.getElementById('home-name').textContent = 'YOU';
      document.getElementById('away-name').textContent = 'CPU';
      startMatch();
    } else if (a === 'host') {
      document.getElementById('host-section').style.display = '';
      document.getElementById('join-section').style.display = 'none';
      document.getElementById('online-title').textContent = 'ホスト';
      showScreen('online');
      setupPeerHost();
    } else if (a === 'join') {
      document.getElementById('host-section').style.display = 'none';
      document.getElementById('join-section').style.display = '';
      document.getElementById('online-title').textContent = '参加';
      showScreen('online');
    } else if (a === 'howto') {
      showScreen('howto');
    }
  });
});

document.getElementById('howto-back').addEventListener('click', () => showScreen('menu'));

document.getElementById('online-back').addEventListener('click', () => {
  if (State.conn) { try { State.conn.close(); } catch(e){} State.conn = null; }
  if (State.peer) { try { State.peer.destroy(); } catch(e){} State.peer = null; }
  showScreen('menu');
});

document.getElementById('connect-btn').addEventListener('click', () => {
  const code = document.getElementById('join-code-input').value.trim().toUpperCase();
  if (!code) return;
  setupPeerJoin(code);
});

document.getElementById('copy-code').addEventListener('click', () => {
  const code = document.getElementById('host-code').textContent;
  navigator.clipboard?.writeText(code).then(() => {
    document.getElementById('host-status').textContent = 'コピーしました！相手の接続を待っています...';
  });
});

// Pause/result buttons
document.getElementById('pause-btn').addEventListener('click', () => {
  if (State.ended) return;
  State.paused = !State.paused;
  document.getElementById('pause-overlay').classList.toggle('active', State.paused);
});
document.getElementById('resume-btn').addEventListener('click', () => {
  State.paused = false;
  document.getElementById('pause-overlay').classList.remove('active');
});
document.getElementById('quit-btn').addEventListener('click', () => quitToMenu());
document.getElementById('back-menu-btn').addEventListener('click', () => quitToMenu());
document.getElementById('rematch-btn').addEventListener('click', () => {
  document.getElementById('result-overlay').classList.remove('active');
  startMatch();
});

// Prevent context menu on long press
window.addEventListener('contextmenu', e => e.preventDefault());

// Init
resizeCanvas();
showScreen('menu');
requestAnimationFrame(loop);

})();
