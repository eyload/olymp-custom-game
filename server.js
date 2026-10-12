import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { DATABASE_URL, BOT_TOKEN, PORT = 3000 } = process.env;
if (!DATABASE_URL || !BOT_TOKEN) throw new Error('Set DATABASE_URL and BOT_TOKEN');

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
});

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json());

// Раздача статики из папки public и корневой роут для предотвращения "Cannot GET /"
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Базовая проверка и инициализация таблиц с новыми колонками рейтинга и ID
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

async function auth(req, res, next) {
  try {
    const p = new URLSearchParams(req.get('X-Init-Data') || '');
    const hash = p.get('hash');
    p.delete('hash');
    const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
    if (!hash || hash !== calc) throw new Error('bad auth');
    req.tg = JSON.parse(p.get('user'));
    next();
  } catch {
    res.status(401).json({ error: 'auth' });
  }
}

// Эндпоинты профиля и интеграции MLBB ID / Zone ID
app.get('/api/profile', auth, async (req, res) => {
  const { rows: [u] } = await pool.query('select * from users where telegram_user_id = $1', [req.tg.id]);
  res.json({ ok: true, profile: u ? { nick: u.nick, mlbbId: u.mlbb_id, mlbbZone: u.mlbb_zone, rating: u.rating, mvpCount: u.mvp_count } : null });
});

app.post('/api/profile', auth, async (req, res) => {
  const { mlbbId, mlbbZone, nick } = req.body;
  if (!mlbbId || !mlbbZone) return res.status(400).json({ error: 'Укажите ID и Zone ID' });
  
  const { rows: [u] } = await pool.query(
    `insert into users (telegram_user_id, telegram_username, nick, mlbb_id, mlbb_zone)
     values ($1, $2, $3, $4, $5)
     on conflict (telegram_user_id) do update set nick = $3, mlbb_id = $4, mlbb_zone = $5
     returning *`, [req.tg.id, req.tg.username || null, nick || 'Игрок', mlbbId, mlbbZone]);
     
  res.json({ ok: true, profile: { nick: u.nick, mlbbId: u.mlbb_id, mlbbZone: u.mlbb_zone, rating: u.rating, mvpCount: u.mvp_count } });
});

// Рейтинговая система и таблица лидеров сезона
app.get('/api/rating', auth, async (req, res) => {
  const { rows: leaderboard } = await pool.query('select telegram_username as username, nick, mlbb_id, rating, mvp_count from users where rating >= 0 order by rating desc limit 15');
  res.json({
    ok: true,
    season: { name: 'MLBB Season x OLYMP', endsIn: '14 дней' },
    leaderboard
  });
});

// Лобби игры
app.get('/api/lobby', auth, async (req, res) => {
  const { rows: players } = await pool.query('select telegram_user_id::text as uid, telegram_username as username, team, role from role_assignments where lobby_id = 1');
  const me = players.find(p => p.uid === String(req.tg.id)) || null;
  res.json({ ok: true, players, count: players.length, me });
});

app.post('/api/claim', auth, async (req, res) => {
  const { team, role } = req.body;
  try {
    await pool.query('insert into role_assignments (lobby_id, telegram_user_id, telegram_username, team, role) values (1, $1, $2, $3, $4)',
      [req.tg.id, req.tg.username || 'user', team, role]);
    const { rows: players } = await pool.query('select telegram_user_id::text as uid, telegram_username as username, team, role from role_assignments where lobby_id = 1');
    res.json({ ok: true, players, count: players.length, me: players.find(p => p.uid === String(req.tg.id)) });
  } catch {
    res.status(409).json({ error: 'Роль уже занята или вы уже в лобби' });
  }
});

app.post('/api/release', auth, async (req, res) => {
  await pool.query('delete from role_assignments where lobby_id = 1 and telegram_user_id = $1', [req.tg.id]);
  const { rows: players } = await pool.query('select telegram_user_id::text as uid, telegram_username as username, team, role from role_assignments where lobby_id = 1');
  res.json({ ok: true, players, count: players.length, me: null });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server started on port ${PORT}`));
