import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';

const { DATABASE_URL, BOT_TOKEN, PORT = 3000 } = process.env;
if (!DATABASE_URL || !BOT_TOKEN) throw new Error('Set DATABASE_URL and BOT_TOKEN');

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
});
const LOBBY = 1;
const APP_URL = process.env.APP_URL;
const ADMINS = (process.env.ADMINS || '').toLowerCase().split(',').map((x) => x.trim().replace(/^@/, '')).filter(Boolean);
const isAdmin = (tg) => ADMINS.includes(String(tg.id)) || (!!tg.username && ADMINS.includes(tg.username.toLowerCase()));
const ROLES = ['jungle', 'exp', 'mid', 'gold', 'roam'];

// Schema. The two UNIQUE constraints are what make role locking race-proof.
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
  insert into lobbies (id) values (${LOBBY}) on conflict do nothing;
  alter table lobbies add column if not exists starts_at timestamptz,
    add column if not exists notified20 boolean not null default false,
    add column if not exists notified10 boolean not null default false;
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
  fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'db' }); });

async function state(tg) {
  const uid = tg.id;
  const { rows } = await pool.query(
    'select telegram_user_id::text as uid, telegram_username as username, team, role from role_assignments where lobby_id = $1',
    [LOBBY]);
  const { rows: [l] } = await pool.query('select starts_at from lobbies where id = $1', [LOBBY]);
  return { players: rows, count: rows.length, me: rows.find((r) => r.uid === String(uid)) || null, startsAt: l?.starts_at || null, isAdmin: isAdmin(tg) };
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

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
       values ($1, $2, $3, $4, $5)`, [LOBBY, req.tg.id, username, team, role]);
    await c.query('commit');
    res.json(await state(req.tg));
  } catch (e) {
    await c.query('rollback').catch(() => {});
    if (e.code !== '23505') throw e;
    if (e.constraint === 'uq_player') return res.status(409).json({ error: 'has_role' });
    const { rows } = await pool.query('select count(*)::int as n from role_assignments where lobby_id = $1', [LOBBY]);
    res.status(409).json({ error: rows[0].n >= 10 ? 'full' : 'role_taken' });
  } finally {
    c.release();
  }
}));

// Only deletes the caller's own row (identity from validated initData).
app.post('/api/release', auth, wrap(async (req, res) => {
  await pool.query('delete from role_assignments where lobby_id = $1 and telegram_user_id = $2', [LOBBY, req.tg.id]);
  res.json(await state(req.tg));
}));


const admin = (req, res, next) => (isAdmin(req.tg) ? next() : res.status(403).json({ error: 'forbidden' }));

app.post('/api/admin/time', auth, admin, wrap(async (req, res) => {
  const t = req.body.startsAt ? new Date(req.body.startsAt) : null;
  if (t && (isNaN(t) || t < Date.now())) return res.status(400).json({ error: 'bad_time' });
  const mins = t ? (t - Date.now()) / 60000 : 0;
  // Windows that already passed are marked as sent, so reminders never fire late or twice.
  await pool.query('update lobbies set starts_at = $2, notified20 = $3, notified10 = $4 where id = $1',
    [LOBBY, t, mins <= 20, mins <= 10]);
  res.json(await state(req.tg));
}));
app.post('/api/admin/kick', auth, admin, wrap(async (req, res) => {
  await pool.query('delete from role_assignments where lobby_id = $1 and telegram_user_id = $2', [LOBBY, req.body.uid]);
  res.json(await state(req.tg));
}));
app.post('/api/admin/reset', auth, admin, wrap(async (req, res) => {
  await pool.query('delete from role_assignments where lobby_id = $1', [LOBBY]);
  res.json(await state(req.tg));
}));

async function notify(m) {
  const { rows } = await pool.query('select telegram_user_id::text as id from role_assignments where lobby_id = $1', [LOBBY]);
  const msg = { text: `⏰ Через ${m} минут начинается кастомная игра! Заходи в лобби.` };
  if (APP_URL) msg.reply_markup = { inline_keyboard: [[{ text: 'Открыть лобби', web_app: { url: APP_URL } }]] };
  for (const r of rows) {
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: r.id, ...msg }),
    }).catch(() => null);
    if (!resp?.ok) console.error('notify failed for', r.id);
  }
}

async function tick() {
  const { rows: [l] } = await pool.query('select starts_at, notified20, notified10 from lobbies where id = $1', [LOBBY]);
  if (!l?.starts_at) return;
  const mins = (new Date(l.starts_at) - Date.now()) / 60000;
  for (const [m, col] of [[20, 'notified20'], [10, 'notified10']]) {
    if (mins > 0 && mins <= m && !l[col]) {
      // Atomic flag flip: only one process/tick can win and send.
      const r = await pool.query(`update lobbies set ${col} = true where id = $1 and ${col} = false`, [LOBBY]);
      if (r.rowCount) await notify(m);
    }
  }
}
setInterval(() => tick().catch(console.error), 15000);

app.listen(PORT, () => console.log(`PartyFinder on :${PORT}`));
