import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const { DATABASE_URL, BOT_TOKEN, PORT = 3000 } = process.env;
if (!DATABASE_URL || !BOT_TOKEN) throw new Error('Set DATABASE_URL and BOT_TOKEN');

// ---------------------------------------------------------------------------
// DB pool. Bounded size + timeouts so a traffic spike queues requests instead of
// exhausting Postgres connections or hanging forever.
// Tune with PG_POOL_MAX (keep replicas * PG_POOL_MAX below Postgres max_connections).
// ---------------------------------------------------------------------------
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 15000,
});
// Without this handler an idle-connection error (e.g. DB restart on Railway) crashes the whole process.
pool.on('error', (e) => console.error('pg pool error', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

const als = new AsyncLocalStorage();
const L = () => als.getStore() ?? 1; // current game id, set per request from the X-Lobby header
const APP_URL = process.env.APP_URL;
const ADMINS = (process.env.ADMINS || '').toLowerCase().split(',').map((x) => x.trim().replace(/^@/, '')).filter(Boolean);
const isAdmin = (tg) => ADMINS.includes(String(tg.id)) || (!!tg.username && ADMINS.includes(tg.username.toLowerCase()));
const ROLES = ['jungle', 'exp', 'mid', 'gold', 'roam'];

// ---------------------------------------------------------------------------
// Schema. Order matters: a table must be created before it is altered.
// An advisory lock serialises migrations when several replicas start at once.
// ---------------------------------------------------------------------------
const SCHEMA = `
  create table if not exists users (
    id serial primary key,
    telegram_user_id bigint unique not null,
    telegram_username text,
    created_at timestamptz not null default now());

  create table if not exists lobbies (
    id serial primary key,
    status text not null default 'open',
    created_at timestamptz not null default now());
  insert into lobbies (id) select 1 where not exists (select 1 from lobbies);
  select setval(pg_get_serial_sequence('lobbies', 'id'), greatest((select max(id) from lobbies), 1));
  alter table lobbies add column if not exists starts_at timestamptz,
    add column if not exists notified20 boolean not null default false,
    add column if not exists notified10 boolean not null default false,
    add column if not exists room_code text,
    add column if not exists title text not null default 'Кастомка';

  create table if not exists role_assignments (
    id serial primary key,
    lobby_id int not null references lobbies(id),
    telegram_user_id bigint not null,
    telegram_username text not null,
    team smallint not null check (team in (1, 2)),
    role text not null check (role in ('jungle','exp','mid','gold','roam')),
    created_at timestamptz not null default now(),
    constraint uq_slot unique (lobby_id, team, role),
    constraint uq_player unique (lobby_id, telegram_user_id));
  alter table role_assignments add column if not exists confirmed boolean not null default false;

  create table if not exists queue (
    id serial primary key,
    lobby_id int not null default 1,
    telegram_user_id bigint not null,
    telegram_username text not null,
    created_at timestamptz not null default now());
  delete from queue a using queue b
    where a.lobby_id = b.lobby_id and a.telegram_user_id = b.telegram_user_id and a.id > b.id;
  create unique index if not exists uq_queue_player on queue (lobby_id, telegram_user_id);

  create index if not exists idx_queue_lobby on queue (lobby_id, id);
  create index if not exists idx_ra_user on role_assignments (telegram_user_id);
  create index if not exists idx_lobbies_starts on lobbies (starts_at);
`;
{
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(727001)');
    await c.query(SCHEMA);
  } finally {
    await c.query('select pg_advisory_unlock(727001)').catch(() => {});
    c.release();
  }
}

// ---------------------------------------------------------------------------
// Per-user rate limit (in memory). Stops a buggy client or a bot from hammering the API.
// ---------------------------------------------------------------------------
const RATE_WINDOW = 10000;
const RATE_MAX = Number(process.env.RATE_MAX) || 60; // requests per user per 10 s
const hits = new Map();
function allow(id) {
  const now = Date.now();
  const h = hits.get(id);
  if (!h || now - h.t > RATE_WINDOW) { hits.set(id, { t: now, n: 1 }); return true; }
  return ++h.n <= RATE_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (now - h.t > RATE_WINDOW) hits.delete(k);
}, 30000).unref();

// Validate Telegram initData (HMAC-SHA256 per Telegram docs). Identity comes only from here.
function auth(req, res, next) {
  let tg;
  try {
    const p = new URLSearchParams(req.get('X-Init-Data') || '');
    const hash = p.get('hash');
    p.delete('hash');
    const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
    const ok = hash && hash.length === calc.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(calc));
    if (!ok || Date.now() / 1000 - Number(p.get('auth_date')) > 86400) throw new Error('bad auth');
    tg = JSON.parse(p.get('user'));
    if (!tg || tg.id == null) throw new Error('bad user');
  } catch {
    return res.status(401).json({ error: 'auth' });
  }
  if (!allow(tg.id)) return res.status(429).json({ error: 'rate_limited' });
  req.tg = tg;
  next();
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'db' });
  });

// NOTE: `admin` must be declared before any route that uses it (const is not hoisted).
const admin = (req, res, next) => {
  if (!isAdmin(req.tg)) return res.status(403).json({ error: 'forbidden' });
  next();
};

// ---------------------------------------------------------------------------
// Read cache. The lobby state is the same for everybody except a few per-user fields,
// so it is loaded ONCE per lobby per TTL (one SQL round trip, concurrent requests share
// the same in-flight promise) and personalised in memory. Every write calls
// state(tg, true) / invalidate() so the writer and later readers always see fresh data.
// ---------------------------------------------------------------------------
const TTL = Number(process.env.CACHE_TTL_MS) || 1500;
const cache = new Map(); // lobby id -> { at, p }
let gamesCache = { at: 0, p: null };

function invalidate(lid) {
  cache.delete(lid);
  gamesCache = { at: 0, p: null };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of cache) if (now - e.at > 60000) cache.delete(k);
}, 30000).unref();

async function loadShared(lid) {
  const { rows: [r] } = await pool.query(
    `select
       (select coalesce(json_agg(json_build_object('uid', telegram_user_id::text, 'username', telegram_username,
          'team', team, 'role', role, 'confirmed', confirmed) order by id), '[]'::json)
          from role_assignments where lobby_id = $1) as players,
       (select row_to_json(x) from (select starts_at, room_code, title from lobbies where id = $1) x) as lobby,
       (select coalesce(json_agg(telegram_user_id::text order by id), '[]'::json) from queue where lobby_id = $1) as queue`,
    [lid]);
  return { players: r.players, lobby: r.lobby, queue: r.queue };
}
function cached(lid) {
  const e = cache.get(lid);
  if (e && Date.now() - e.at < TTL) return e.p;
  const p = loadShared(lid);
  const ne = { at: Date.now(), p };
  cache.set(lid, ne);
  p.catch(() => { if (cache.get(lid) === ne) cache.delete(lid); });
  return p;
}

// fresh = true after any write (and for decisions based on the state): skips and refills the cache.
async function state(tg, fresh = false) {
  const lid = L();
  if (fresh) invalidate(lid);
  const s = await cached(lid);
  const uid = String(tg.id);
  const adm = isAdmin(tg);
  const l = s.lobby;
  const me = s.players.find((r) => r.uid === uid) || null;
  const out = {
    players: s.players, count: s.players.length, me,
    startsAt: l?.starts_at ? new Date(l.starts_at) : null, title: l?.title || '',
    gameId: lid, gone: !l, isAdmin: adm,
    roomCode: me || adm ? l?.room_code || null : null,
    queueTotal: s.queue.length, queuePos: s.queue.indexOf(uid) + 1,
  };
  return out;
}

// ---------------------------------------------------------------------------
// Telegram sending: global throttle (~25 msg/s, Telegram's limit is 30/s), timeout, 429 retry.
// ---------------------------------------------------------------------------
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 40;
  if (at > now) await sleep(at - now);
}
async function tgSend(chat_id, text, extra = {}) {
  for (let i = 0; i < 2; i++) {
    await throttle();
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text, ...extra }), signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!resp) return false;
    if (resp.status === 429) {
      const j = await resp.json().catch(() => null);
      await sleep((j?.parameters?.retry_after || 1) * 1000);
      continue;
    }
    await resp.arrayBuffer().catch(() => {}); // free the socket
    return resp.ok;
  }
  return false;
}
const openLobby = (gid) => (APP_URL
  ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть лобби', web_app: { url: `${APP_URL}?g=${gid}` } }]] } }
  : {});

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.json({ limit: '20kb' }));
app.use(express.static('public'));
app.use('/api', (req, res, next) => {
  const n = Number(req.get('X-Lobby'));
  req.lid = Number.isSafeInteger(n) && n > 0 && n < 2147483647 ? n : 1;
  als.run(req.lid, next);
});
app.use((req, res, next) => {
  if (/^\/api\/(release|admin\/kick)$/.test(req.path)) res.on('finish', () => res.statusCode < 400 && als.run(req.lid, promote).catch(console.error));
  if (req.path === '/api/admin/reset') {
    res.on('finish', () => res.statusCode < 400 && pool.query('delete from queue where lobby_id = $1', [req.lid])
      .then(() => invalidate(req.lid)).catch(console.error));
  }
  next();
});

app.get('/api/lobby', auth, wrap(async (req, res) => res.json(await state(req.tg))));
app.get('/api/me', auth, wrap(async (req, res) => res.json({ me: (await state(req.tg)).me })));

app.post('/api/claim', auth, wrap(async (req, res) => {
  const team = Number(req.body.team);
  const role = req.body.role;
  const username = String(req.body.username || '').trim().replace(/^@/, '');
  if (![1, 2].includes(team) || !ROLES.includes(role)) return res.status(400).json({ error: 'bad_request' });
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return res.status(400).json({ error: 'bad_username' });

  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(
      `insert into users (telegram_user_id, telegram_username) values ($1, $2)
       on conflict (telegram_user_id) do update set telegram_username = $2`, [req.tg.id, username]);
    await c.query(
      `insert into role_assignments (lobby_id, telegram_user_id, telegram_username, team, role)
       values ($1, $2, $3, $4, $5)`, [L(), req.tg.id, username, team, role]);
    await c.query('commit');
    res.json(await state(req.tg, true));
  } catch (e) {
    await c.query('rollback').catch(() => {});
    if (e.code !== '23505') throw e;
    if (e.constraint === 'uq_player') return res.status(409).json({ error: 'has_role' });
    const { rows } = await pool.query('select count(*)::int as n from role_assignments where lobby_id = $1', [L()]);
    res.status(409).json({ error: rows[0].n >= 10 ? 'full' : 'role_taken' });
  } finally {
    c.release();
  }
}));

// Only deletes the caller's own row (identity from validated initData).
app.post('/api/release', auth, wrap(async (req, res) => {
  await pool.query('delete from role_assignments where lobby_id = $1 and telegram_user_id = $2', [L(), req.tg.id]);
  res.json(await state(req.tg, true));
}));

app.post('/api/admin/time', auth, admin, wrap(async (req, res) => {
  const t = req.body.startsAt ? new Date(req.body.startsAt) : null;
  if (t && (isNaN(t) || t < Date.now())) return res.status(400).json({ error: 'bad_time' });
  const mins = t ? (t - Date.now()) / 60000 : 0;
  // Windows that already passed are marked as sent, so reminders never fire late or twice.
  await pool.query('update lobbies set starts_at = $2, notified20 = $3, notified10 = $4 where id = $1',
    [L(), t, mins <= 20, mins <= 10]);
  res.json(await state(req.tg, true));
}));
app.post('/api/admin/kick', auth, admin, wrap(async (req, res) => {
  const uid = String(req.body.uid ?? '');
  if (!/^\d{1,18}$/.test(uid)) return res.status(400).json({ error: 'bad_request' });
  await pool.query('delete from role_assignments where lobby_id = $1 and telegram_user_id = $2', [L(), uid]);
  res.json(await state(req.tg, true));
}));
app.post('/api/admin/reset', auth, admin, wrap(async (req, res) => {
  await pool.query('delete from role_assignments where lobby_id = $1', [L()]);
  res.json(await state(req.tg, true));
}));

// Player confirms attendance ("Я на месте"): only their own row.
app.post('/api/confirm', auth, wrap(async (req, res) => {
  await pool.query('update role_assignments set confirmed = true where lobby_id = $1 and telegram_user_id = $2', [L(), req.tg.id]);
  res.json(await state(req.tg, true));
}));

// Move own role to another free slot in ONE atomic UPDATE (uq_slot rejects a taken slot).
app.post('/api/move', auth, wrap(async (req, res) => {
  const team = Number(req.body.team), role = req.body.role;
  if (![1, 2].includes(team) || !ROLES.includes(role)) return res.status(400).json({ error: 'bad_request' });
  try {
    const r = await pool.query('update role_assignments set team = $3, role = $4, confirmed = false where lobby_id = $1 and telegram_user_id = $2',
      [L(), req.tg.id, team, role]);
    if (!r.rowCount) return res.status(409).json({ error: 'has_role' });
    res.json(await state(req.tg, true));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'role_taken' });
    throw e;
  }
}));

app.post('/api/admin/room', auth, admin, wrap(async (req, res) => {
  const code = String(req.body.code || '').trim().slice(0, 32) || null;
  await pool.query('update lobbies set room_code = $2 where id = $1', [L(), code]);
  res.json(await state(req.tg, true));
}));

async function sendAll(text) {
  const { rows } = await pool.query('select telegram_user_id::text as id from role_assignments where lobby_id = $1', [L()]);
  const extra = openLobby(L());
  let sent = 0;
  for (const r of rows) if (await tgSend(r.id, text, extra)) sent++;
  return sent;
}
app.post('/api/admin/broadcast', auth, admin, wrap(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'bad_request' });
  const sent = await sendAll('📢 ' + text);
  res.json({ ...(await state(req.tg, true)), sent });
}));

// Waitlist: join only when 10/10. Slots freed by release/kick go to the first in line, atomically.
app.post('/api/queue/join', auth, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return res.status(400).json({ error: 'bad_username' });
  const st = await state(req.tg, true);
  if (st.me) return res.status(409).json({ error: 'has_role' });
  if (st.count < 10) return res.status(409).json({ error: 'not_full' });
  await pool.query('insert into queue (lobby_id, telegram_user_id, telegram_username) values ($1, $2, $3) on conflict (lobby_id, telegram_user_id) do nothing',
    [L(), req.tg.id, username]);
  await promote();
  res.json(await state(req.tg, true));
}));
app.post('/api/queue/leave', auth, wrap(async (req, res) => {
  await pool.query('delete from queue where lobby_id = $1 and telegram_user_id = $2', [L(), req.tg.id]);
  res.json(await state(req.tg, true));
}));

async function promote() {
  for (;;) {
    const c = await pool.connect();
    let q;
    try {
      await c.query('begin');
      const { rows: taken } = await c.query('select team, role from role_assignments where lobby_id = $1', [L()]);
      const slot = [1, 2].flatMap((t) => ROLES.map((r) => [t, r])).find(([t, r]) => !taken.some((x) => x.team === t && x.role === r));
      if (!slot) { await c.query('rollback'); return; }
      ({ rows: [q] } = await c.query('select id, telegram_user_id::text as uid, telegram_username as username from queue where lobby_id = $1 order by id limit 1 for update skip locked', [L()]));
      if (!q) { await c.query('rollback'); return; }
      await c.query('delete from queue where id = $1', [q.id]);
      await c.query('insert into role_assignments (lobby_id, telegram_user_id, telegram_username, team, role) values ($1, $2, $3, $4, $5)',
        [L(), q.uid, q.username, slot[0], slot[1]]);
      await c.query('commit');
      invalidate(L());
      tgSend(q.uid, `🎮 Освободилась роль, и она твоя: Команда ${slot[0]} · ${slot[1].toUpperCase()}`, openLobby(L())).catch(() => {});
    } catch (e) {
      await c.query('rollback').catch(() => {});
      if (e.code !== '23505' || !q) throw e;
      if (e.constraint === 'uq_slot') return; // slot was grabbed directly; queue row is kept
      await pool.query('delete from queue where lobby_id = $1 and telegram_user_id = $2', [L(), q.uid]); // user already has a role
      invalidate(L());
    } finally {
      c.release();
    }
  }
}

// Games list: one cached query for ALL users (each game carries its player ids, max 10),
// "mine" is computed in memory, so the number of viewers does not add DB load.
async function loadGames() {
  const { rows } = await pool.query(`select l.id, l.title, l.starts_at as "startsAt",
    coalesce(array_agg(r.telegram_user_id::text) filter (where r.id is not null), '{}') as uids
    from lobbies l left join role_assignments r on r.lobby_id = l.id
    where l.starts_at is null or l.starts_at > now() - interval '3 hours'
    group by l.id
    order by (l.starts_at is null), l.starts_at, l.id
    limit 100`);
  return rows;
}
function games() {
  if (gamesCache.p && Date.now() - gamesCache.at < TTL) return gamesCache.p;
  const p = loadGames();
  const ne = { at: Date.now(), p };
  gamesCache = ne;
  p.catch(() => { if (gamesCache === ne) gamesCache = { at: 0, p: null }; });
  return p;
}
app.get('/api/games', auth, wrap(async (req, res) => {
  const rows = await games();
  const uid = String(req.tg.id);
  res.json({
    games: rows.map(({ uids, ...g }) => ({ ...g, count: uids.length, mine: uids.includes(uid) })),
    isAdmin: isAdmin(req.tg),
  });
}));
app.post('/api/admin/game', auth, admin, wrap(async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 40);
  if (!title) return res.status(400).json({ error: 'bad_request' });
  const t = req.body.startsAt ? new Date(req.body.startsAt) : null;
  if (t && (isNaN(t) || t < Date.now())) return res.status(400).json({ error: 'bad_time' });
  const mins = t ? (t - Date.now()) / 60000 : 0;
  const { rows: [g] } = await pool.query('insert into lobbies (title, starts_at, notified20, notified10) values ($1, $2, $3, $4) returning id', [title, t, mins <= 20, mins <= 10]);
  invalidate(g.id);
  res.json({ id: g.id });
}));
app.post('/api/admin/delete', auth, admin, wrap(async (req, res) => {
  await pool.query('delete from role_assignments where lobby_id = $1', [L()]);
  await pool.query('delete from queue where lobby_id = $1', [L()]);
  await pool.query('delete from lobbies where id = $1', [L()]);
  invalidate(L());
  res.json({ ok: true });
}));

async function notify(m) {
  const { rows } = await pool.query('select telegram_user_id::text as id from role_assignments where lobby_id = $1', [L()]);
  const { rows: [g] } = await pool.query('select title from lobbies where id = $1', [L()]);
  const text = `⏰ ${g?.title || 'Игра'}: через ${m} минут старт! Заходи в лобби.`;
  const extra = openLobby(L());
  for (const r of rows) if (!(await tgSend(r.id, text, extra))) console.error('notify failed for', r.id);
}

// Reminder ticker. Only lobbies that start within 20 minutes and still have an unsent reminder
// are fetched (not every lobby ever created), and ticks never overlap.
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const { rows } = await pool.query(
      `select id from lobbies
       where starts_at > now() and starts_at <= now() + interval '20 minutes' and not (notified20 and notified10)`);
    for (const { id } of rows) await als.run(id, tickOne);
  } finally {
    ticking = false;
  }
}
async function tickOne() {
  const { rows: [l] } = await pool.query('select starts_at, notified20, notified10 from lobbies where id = $1', [L()]);
  if (!l?.starts_at) return;
  const mins = (new Date(l.starts_at) - Date.now()) / 60000;
  for (const [m, col] of [[20, 'notified20'], [10, 'notified10']]) {
    if (mins > 0 && mins <= m && !l[col]) {
      // Atomic flag flip: only one process/tick can win and send.
      const r = await pool.query(`update lobbies set ${col} = true where id = $1 and ${col} = false`, [L()]);
      if (r.rowCount) await notify(m);
    }
  }
}
setInterval(() => tick().catch(console.error), 15000);

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'server' });
});

const server = app.listen(Number(PORT), '0.0.0.0', () => console.log(`PartyFinder on :${PORT}`));
// Railway's proxy keeps connections open ~60s; a longer keep-alive avoids sporadic 502s.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Graceful shutdown on redeploy: finish in-flight requests, then close the pool.
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => pool.end().catch(() => {}).finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
