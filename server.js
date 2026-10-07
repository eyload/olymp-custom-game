import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const { DATABASE_URL, BOT_TOKEN, PORT = 3000 } = process.env;
if (!DATABASE_URL || !BOT_TOKEN) throw new Error('Set DATABASE_URL and BOT_TOKEN');

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
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

// Schema. Order matters: a table must be created before it is altered.
// The UNIQUE constraints are what make role locking and the waitlist race-proof.
await pool.query(`
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

  create table if not exists admin_log (
    id serial primary key,
    admin_username text not null,
    action text not null,
    created_at timestamptz not null default now());

  create table if not exists queue (
    id serial primary key,
    lobby_id int not null default 1,
    telegram_user_id bigint not null,
    telegram_username text not null,
    created_at timestamptz not null default now());
  delete from queue a using queue b
    where a.lobby_id = b.lobby_id and a.telegram_user_id = b.telegram_user_id and a.id > b.id;
  create unique index if not exists uq_queue_player on queue (lobby_id, telegram_user_id);
`);

// Validate Telegram initData (HMAC-SHA256 per Telegram docs). Identity comes only from here.
function auth(req, res, next) {
  try {
    const p = new URLSearchParams(req.get('X-Init-Data') || '');
    const hash = p.get('hash');
    p.delete('hash');
    const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
    const ok = hash && hash.length === calc.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(calc));
    if (!ok || Date.now() / 1000 - Number(p.get('auth_date')) > 86400) throw new Error('bad auth');
    req.tg = JSON.parse(p.get('user'));
    next();
  } catch {
    res.status(401).json({ error: 'auth' });
  }
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'db' });
  });

// NOTE: `admin` must be declared before any route that uses it (const is not hoisted).
const ACTS = { '/time': 'изменил время старта', '/kick': 'убрал игрока', '/reset': 'сбросил лобби', '/room': 'изменил код комнаты', '/broadcast': 'разослал объявление' };
const admin = (req, res, next) => {
  if (!isAdmin(req.tg)) return res.status(403).json({ error: 'forbidden' });
  res.on('finish', () => res.statusCode < 400 && pool.query('insert into admin_log (admin_username, action) values ($1, $2)',
    [req.tg.username || String(req.tg.id), ACTS[req.path.replace('/api/admin', '')] || req.path]).catch(console.error));
  next();
};

async function state(tg) {
  const uid = tg.id;
  const { rows } = await pool.query(
    'select telegram_user_id::text as uid, telegram_username as username, team, role, confirmed from role_assignments where lobby_id = $1',
    [L()]);
  const { rows: [l] } = await pool.query('select starts_at, room_code, title from lobbies where id = $1', [L()]);
  const me = rows.find((r) => r.uid === String(uid)) || null, adm = isAdmin(tg);
  const out = { players: rows, count: rows.length, me, startsAt: l?.starts_at || null, title: l?.title || '', gameId: L(), gone: !l, isAdmin: adm, roomCode: me || adm ? l?.room_code || null : null };
  const qs = (await pool.query('select telegram_user_id::text as uid from queue where lobby_id = $1 order by id', [L()])).rows;
  out.queueTotal = qs.length;
  out.queuePos = qs.findIndex((x) => x.uid === String(uid)) + 1;
  if (adm) out.log = (await pool.query('select admin_username as who, action, created_at as at from admin_log order by id desc limit 8')).rows;
  return out;
}

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/api', (req, res, next) => { req.lid = Number(req.get('X-Lobby')) || 1; als.run(req.lid, next); });
app.use((req, res, next) => {
  if (/^\/api\/(release|admin\/kick)$/.test(req.path)) res.on('finish', () => res.statusCode < 400 && als.run(req.lid, promote).catch(console.error));
  if (req.path === '/api/admin/reset') res.on('finish', () => res.statusCode < 400 && pool.query('delete from queue where lobby_id = $1', [req.lid]).catch(console.error));
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
    res.json(await state(req.tg));
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
  res.json(await state(req.tg));
}));

app.post('/api/admin/time', auth, admin, wrap(async (req, res) => {
  const t = req.body.startsAt ? new Date(req.body.startsAt) : null;
  if (t && (isNaN(t) || t < Date.now())) return res.status(400).json({ error: 'bad_time' });
  const mins = t ? (t - Date.now()) / 60000 : 0;
  // Windows that already passed are marked as sent, so reminders never fire late or twice.
  await pool.query('update lobbies set starts_at = $2, notified20 = $3, notified10 = $4 where id = $1',
    [L(), t, mins <= 20, mins <= 10]);
  res.json(await state(req.tg));
}));
app.post('/api/admin/kick', auth, admin, wrap(async (req, res) => {
  const uid = String(req.body.uid ?? '');
  if (!/^\d+$/.test(uid)) return res.status(400).json({ error: 'bad_request' });
  await pool.query('delete from role_assignments where lobby_id = $1 and telegram_user_id = $2', [L(), uid]);
  res.json(await state(req.tg));
}));
app.post('/api/admin/reset', auth, admin, wrap(async (req, res) => {
  await pool.query('delete from role_assignments where lobby_id = $1', [L()]);
  res.json(await state(req.tg));
}));

// Player confirms attendance ("Я на месте"): only their own row.
app.post('/api/confirm', auth, wrap(async (req, res) => {
  await pool.query('update role_assignments set confirmed = true where lobby_id = $1 and telegram_user_id = $2', [L(), req.tg.id]);
  res.json(await state(req.tg));
}));

// Move own role to another free slot in ONE atomic UPDATE (uq_slot rejects a taken slot).
app.post('/api/move', auth, wrap(async (req, res) => {
  const team = Number(req.body.team), role = req.body.role;
  if (![1, 2].includes(team) || !ROLES.includes(role)) return res.status(400).json({ error: 'bad_request' });
  try {
    const r = await pool.query('update role_assignments set team = $3, role = $4, confirmed = false where lobby_id = $1 and telegram_user_id = $2',
      [L(), req.tg.id, team, role]);
    if (!r.rowCount) return res.status(409).json({ error: 'has_role' });
    res.json(await state(req.tg));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'role_taken' });
    throw e;
  }
}));

app.post('/api/admin/room', auth, admin, wrap(async (req, res) => {
  const code = String(req.body.code || '').trim().slice(0, 32) || null;
  await pool.query('update lobbies set room_code = $2 where id = $1', [L(), code]);
  res.json(await state(req.tg));
}));

async function sendAll(text) {
  const { rows } = await pool.query('select telegram_user_id::text as id from role_assignments where lobby_id = $1', [L()]);
  const markup = APP_URL ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть лобби', web_app: { url: `${APP_URL}?g=${L()}` } }]] } } : {};
  let sent = 0;
  for (const r of rows) {
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: r.id, text, ...markup }),
    }).catch(() => null);
    if (resp?.ok) sent++;
  }
  return sent;
}
app.post('/api/admin/broadcast', auth, admin, wrap(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'bad_request' });
  const sent = await sendAll('📢 ' + text);
  res.json({ ...(await state(req.tg)), sent });
}));

// Waitlist: join only when 10/10. Slots freed by release/kick go to the first in line, atomically.
app.post('/api/queue/join', auth, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return res.status(400).json({ error: 'bad_username' });
  const st = await state(req.tg);
  if (st.me) return res.status(409).json({ error: 'has_role' });
  if (st.count < 10) return res.status(409).json({ error: 'not_full' });
  await pool.query('insert into queue (lobby_id, telegram_user_id, telegram_username) values ($1, $2, $3) on conflict (lobby_id, telegram_user_id) do nothing',
    [L(), req.tg.id, username]);
  await promote();
  res.json(await state(req.tg));
}));
app.post('/api/queue/leave', auth, wrap(async (req, res) => {
  await pool.query('delete from queue where lobby_id = $1 and telegram_user_id = $2', [L(), req.tg.id]);
  res.json(await state(req.tg));
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
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: q.uid, text: `🎮 Освободилась роль, и она твоя: Команда ${slot[0]} · ${slot[1].toUpperCase()}`,
          ...(APP_URL && { reply_markup: { inline_keyboard: [[{ text: 'Открыть лобби', web_app: { url: `${APP_URL}?g=${L()}` } }]] } }) }),
      }).catch(() => {});
    } catch (e) {
      await c.query('rollback').catch(() => {});
      if (e.code !== '23505' || !q) throw e;
      if (e.constraint === 'uq_slot') return; // slot was grabbed directly; queue row is kept
      await pool.query('delete from queue where lobby_id = $1 and telegram_user_id = $2', [L(), q.uid]); // user already has a role
    } finally {
      c.release();
    }
  }
}

app.get('/api/games', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(`select l.id, l.title, l.starts_at as "startsAt",
    (select count(*)::int from role_assignments r where r.lobby_id = l.id) as count,
    exists (select 1 from role_assignments r where r.lobby_id = l.id and r.telegram_user_id = $1) as mine
    from lobbies l where l.starts_at is null or l.starts_at > now() - interval '3 hours'
    order by (l.starts_at is null), l.starts_at, l.id`, [req.tg.id]);
  res.json({ games: rows, isAdmin: isAdmin(req.tg) });
}));
app.post('/api/admin/game', auth, admin, wrap(async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 40);
  if (!title) return res.status(400).json({ error: 'bad_request' });
  const t = req.body.startsAt ? new Date(req.body.startsAt) : null;
  if (t && (isNaN(t) || t < Date.now())) return res.status(400).json({ error: 'bad_time' });
  const mins = t ? (t - Date.now()) / 60000 : 0;
  const { rows: [g] } = await pool.query('insert into lobbies (title, starts_at, notified20, notified10) values ($1, $2, $3, $4) returning id', [title, t, mins <= 20, mins <= 10]);
  res.json({ id: g.id });
}));
app.post('/api/admin/delete', auth, admin, wrap(async (req, res) => {
  await pool.query('delete from role_assignments where lobby_id = $1', [L()]);
  await pool.query('delete from queue where lobby_id = $1', [L()]);
  await pool.query('delete from lobbies where id = $1', [L()]);
  res.json({ ok: true });
}));

async function notify(m) {
  const { rows } = await pool.query('select telegram_user_id::text as id from role_assignments where lobby_id = $1', [L()]);
  const { rows: [g] } = await pool.query('select title from lobbies where id = $1', [L()]);
  const msg = { text: `⏰ ${g?.title || 'Игра'}: через ${m} минут старт! Заходи в лобби.` };
  if (APP_URL) msg.reply_markup = { inline_keyboard: [[{ text: 'Открыть лобби', web_app: { url: `${APP_URL}?g=${L()}` } }]] };
  for (const r of rows) {
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: r.id, ...msg }),
    }).catch(() => null);
    if (!resp?.ok) console.error('notify failed for', r.id);
  }
}

async function tick() {
  const { rows } = await pool.query('select id from lobbies where starts_at is not null');
  for (const { id } of rows) await als.run(id, tickOne);
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

app.listen(Number(PORT), '0.0.0.0', () => console.log(`PartyFinder on :${PORT}`));
