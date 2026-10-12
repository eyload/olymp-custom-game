import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { DATABASE_URL, BOT_TOKEN, PORT = 3000, ADMIN_IDS = '', SEASON_DAYS = '30' } = process.env;
if (!DATABASE_URL || !BOT_TOKEN) throw new Error('Set DATABASE_URL and BOT_TOKEN');

// ── Настройки рейтинга ──────────────────────────────────────────────
const ADMINS = new Set(ADMIN_IDS.split(',').map(s => s.trim()).filter(Boolean)); // Telegram ID админов
const MVP_RP = 25; // очков рейтинга за один MVP
const RANKS = [[0, 'Warrior'], [50, 'Elite'], [100, 'Master'], [175, 'Grandmaster'], [275, 'Epic'],
  [400, 'Legend'], [575, 'Mythic'], [800, 'Mythical Honor'], [1100, 'Mythical Glory'], [1500, 'Mythical Immortal']];
const PRIZES = ['🥇 1 место — 1000 💎 (замени на свой приз)', '🥈 2 место — 500 💎', '🥉 3 место — 250 💎',
  'Ранг Mythic и выше — особая роль в чате'];
const ROLES = ['jungle', 'exp', 'mid', 'gold', 'roam'];
const rankOf = rp => {
  let i = RANKS.length - 1;
  while (RANKS[i][0] > rp) i--;
  return { name: RANKS[i][1], min: RANKS[i][0], next: RANKS[i + 1]?.[0] ?? null };
};

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
});

const SCHEMA = `
  create table if not exists users (
    id serial primary key,
    telegram_user_id bigint unique not null,
    telegram_username text,
    nick text,
    mlbb_id text,
    mlbb_zone text,
    rating int not null default 0,
    mvp_count int not null default 0,
    created_at timestamptz not null default now());
  alter table users add column if not exists mlbb_name text;
  alter table users add column if not exists mlbb_avatar text;
  alter table users add column if not exists mlbb_level int;
  alter table users add column if not exists mlbb_verified boolean not null default false;
  create unique index if not exists uq_mlbb_verified on users (mlbb_id, mlbb_zone) where mlbb_verified;

  create table if not exists seasons (
    id serial primary key,
    number int not null unique,
    name text not null,
    starts_at timestamptz not null default now(),
    ends_at timestamptz not null);
  create table if not exists season_scores (
    season_id int not null references seasons(id),
    telegram_user_id bigint not null,
    rating int not null default 0,
    mvp_count int not null default 0,
    primary key (season_id, telegram_user_id));

  create table if not exists lobbies (
    id serial primary key,
    title text not null default 'Кастомка',
    status text not null default 'open');
  insert into lobbies (id) select 1 where not exists (select 1 from lobbies);

  create table if not exists role_assignments (
    id serial primary key,
    lobby_id int not null references lobbies(id),
    telegram_user_id bigint not null,
    telegram_username text not null,
    team smallint not null,
    role text not null,
    constraint uq_slot unique (lobby_id, team, role),
    constraint uq_player unique (lobby_id, telegram_user_id));
`;
pool.query(SCHEMA).catch(console.error);

// ── Сезоны: когда сезон истёк, следующий создаётся сам, рейтинг начинается с нуля ──
async function season() {
  const cur = () => pool.query('select * from seasons where ends_at > now() order by id desc limit 1').then(r => r.rows[0]);
  const s = await cur();
  if (s) return s;
  await pool.query(
    `insert into seasons (number, name, ends_at)
     select n, 'MLBB Season ' || n, now() + ($1 || ' days')::interval
     from (select coalesce(max(number), 0) + 1 as n from seasons) t
     on conflict (number) do nothing`, [SEASON_DAYS]);
  return cur();
}

// ── Rone Arena API (неофициальный, MLBB). Запросы только с бэкенда ──
const HOSTS = ['https://arena.rone.dev/api', 'https://arena-hv.fastapicloud.dev/api'];
async function rone(method, p, { body, jwt } = {}) {
  let last;
  for (const host of HOSTS) { // при 503 / сетевой ошибке пробуем запасной хост
    try {
      const r = await fetch(host + p, {
        method, signal: AbortSignal.timeout(15000), body: body && JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'olymp-custom-bot', ...(jwt && { Authorization: `Bearer ${jwt}` }) },
      });
      if (r.status === 503) { last = new Error('503'); continue; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.code !== 0) throw Object.assign(new Error(j.msg || j.message || 'api'), { api: true });
      return j.data;
    } catch (e) { if (e.api) throw e; last = e; }
  }
  throw last;
}
// Защита от спама кодами в игровую почту: 1 запрос в минуту на Telegram-аккаунт и на игровой ID
const vcSeen = new Map();
const tooSoon = k => { const t = vcSeen.get(k) || 0; if (Date.now() - t < 60000) return true; vcSeen.set(k, Date.now()); return false; };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const h = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Ошибка сервера, попробуй ещё раз' }); });

async function auth(req, res, next) {
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

const prof = u => u && { nick: u.mlbb_name || u.nick, mlbbId: u.mlbb_id, mlbbZone: u.mlbb_zone, avatar: u.mlbb_avatar, level: u.mlbb_level, verified: u.mlbb_verified };

// ── Профиль и привязка аккаунта MLBB ──
app.get('/api/profile', auth, h(async (req, res) => {
  const { rows: [u] } = await pool.query('select * from users where telegram_user_id = $1', [req.tg.id]);
  res.json({ ok: true, profile: prof(u) });
}));

// Шаг 1: игра отправляет код в игровую почту (так API подтверждает, что аккаунт принадлежит игроку)
app.post('/api/mlbb/send-code', auth, h(async (req, res) => {
  const { mlbbId, mlbbZone } = req.body;
  if (!/^\d{5,12}$/.test(mlbbId || '') || !/^\d{3,6}$/.test(mlbbZone || '')) return res.status(400).json({ error: 'Проверь формат ID и Zone ID' });
  if (tooSoon('tg' + req.tg.id) || tooSoon(`g${mlbbId}:${mlbbZone}`)) return res.status(429).json({ error: 'Подожди минуту перед повторной отправкой' });
  const { rows: [t] } = await pool.query('select 1 from users where mlbb_id = $1 and mlbb_zone = $2 and mlbb_verified and telegram_user_id <> $3', [mlbbId, mlbbZone, req.tg.id]);
  if (t) return res.status(409).json({ error: 'Этот аккаунт уже привязан к другому игроку' });
  try { await rone('POST', '/user/auth/send-vc', { body: { role_id: +mlbbId, zone_id: +mlbbZone } }); }
  catch { return res.status(502).json({ error: 'Не удалось отправить код. Проверь ID и Zone ID или повтори позже' }); }
  res.json({ ok: true });
}));

// Шаг 2: код из почты → JWT → данные аккаунта (ник, аватар, уровень). JWT нигде не храним
app.post('/api/mlbb/verify', auth, h(async (req, res) => {
  const { mlbbId, mlbbZone, code } = req.body;
  if (!/^\d{4,8}$/.test(code || '')) return res.status(400).json({ error: 'Введи код из игровой почты' });
  let jwt, info;
  try {
    ({ jwt } = await rone('POST', '/user/auth/login', { body: { role_id: +mlbbId, zone_id: +mlbbZone, vc: +code } }));
    info = await rone('GET', '/user/info?lang=en', { jwt });
  } catch { return res.status(400).json({ error: 'Код неверный или истёк' }); }
  rone('POST', '/user/auth/logout', { jwt }).catch(() => {});
  try {
    const { rows: [u] } = await pool.query(
      `insert into users (telegram_user_id, telegram_username, nick, mlbb_id, mlbb_zone, mlbb_name, mlbb_avatar, mlbb_level, mlbb_verified)
       values ($1, $2, $3, $4, $5, $3, $6, $7, true)
       on conflict (telegram_user_id) do update set telegram_username = $2, nick = $3, mlbb_id = $4, mlbb_zone = $5,
         mlbb_name = $3, mlbb_avatar = $6, mlbb_level = $7, mlbb_verified = true
       returning *`,
      [req.tg.id, req.tg.username || null, info.name || 'Игрок', mlbbId, mlbbZone, info.avatar || null, info.level ?? null]);
    res.json({ ok: true, profile: prof(u) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Этот аккаунт уже привязан к другому игроку' });
    throw e;
  }
}));

// ── Рейтинг ──
app.get('/api/rating', auth, h(async (req, res) => {
  const s = await season();
  const { rows } = await pool.query(
    `select coalesce(u.mlbb_name, u.nick, u.telegram_username, 'Игрок') as name, sc.rating, sc.mvp_count as mvp
     from season_scores sc join users u on u.telegram_user_id = sc.telegram_user_id
     where sc.season_id = $1 and sc.rating > 0 order by sc.rating desc, sc.mvp_count desc limit 15`, [s.id]);
  const { rows: [m] } = await pool.query('select rating, mvp_count from season_scores where season_id = $1 and telegram_user_id = $2', [s.id, req.tg.id]);
  const rating = m?.rating || 0;
  res.json({
    ok: true, mvpRp: MVP_RP, prizes: PRIZES,
    season: { name: s.name, days: Math.round((new Date(s.ends_at) - new Date(s.starts_at)) / 864e5), left: Math.max(0, Math.ceil((new Date(s.ends_at) - Date.now()) / 864e5)) },
    me: { rating, mvp: m?.mvp_count || 0, rank: rankOf(rating) },
    leaderboard: rows.map(r => ({ ...r, rank: rankOf(r.rating).name })),
  });
}));

// ── Лобби ──
async function lobby(uid) {
  const { rows: players } = await pool.query(
    `select r.telegram_user_id::text as uid, coalesce(u.mlbb_name, u.nick, r.telegram_username) as name, r.team, r.role
     from role_assignments r left join users u on u.telegram_user_id = r.telegram_user_id where r.lobby_id = 1 order by r.id`);
  return { players, count: players.length, me: players.find(p => p.uid === String(uid)) || null, admin: ADMINS.has(String(uid)), mvpRp: MVP_RP };
}

app.get('/api/lobby', auth, h(async (req, res) => res.json({ ok: true, ...(await lobby(req.tg.id)) })));

app.post('/api/claim', auth, h(async (req, res) => {
  const { team, role } = req.body;
  const { rows: [u] } = await pool.query('select mlbb_verified from users where telegram_user_id = $1', [req.tg.id]);
  if (!u?.mlbb_verified) return res.status(403).json({ error: 'Сначала подтверди аккаунт MLBB' });
  if (![1, 2].includes(team) || !ROLES.includes(role)) return res.status(400).json({ error: 'Неверная роль' });
  try {
    await pool.query('insert into role_assignments (lobby_id, telegram_user_id, telegram_username, team, role) values (1, $1, $2, $3, $4)',
      [req.tg.id, req.tg.username || 'user', team, role]);
  } catch { return res.status(409).json({ error: 'Роль уже занята или ты уже в лобби' }); }
  res.json({ ok: true, ...(await lobby(req.tg.id)) });
}));

app.post('/api/release', auth, h(async (req, res) => {
  await pool.query('delete from role_assignments where lobby_id = 1 and telegram_user_id = $1', [req.tg.id]);
  res.json({ ok: true, ...(await lobby(req.tg.id)) });
}));

// Админ: завершить матч, выдать MVP (+RP в текущем сезоне) и очистить лобби
app.post('/api/admin/finish', auth, h(async (req, res) => {
  if (!ADMINS.has(String(req.tg.id))) return res.status(403).json({ error: 'Только для админов' });
  const { mvpUid } = req.body;
  if (mvpUid) {
    const s = await season();
    const { rowCount } = await pool.query('select 1 from role_assignments where lobby_id = 1 and telegram_user_id = $1', [mvpUid]);
    if (!rowCount) return res.status(400).json({ error: 'Игрока нет в лобби' });
    await pool.query(
      `insert into season_scores (season_id, telegram_user_id, rating, mvp_count) values ($1, $2, $3, 1)
       on conflict (season_id, telegram_user_id) do update
       set rating = season_scores.rating + $3, mvp_count = season_scores.mvp_count + 1`, [s.id, mvpUid, MVP_RP]);
  }
  await pool.query('delete from role_assignments where lobby_id = 1');
  res.json({ ok: true, ...(await lobby(req.tg.id)) });
}));

app.listen(PORT, '0.0.0.0', () => console.log(`Server started on port ${PORT}`));
