const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/olymp_custom'
});

// Инициализация структуры БД
async function initDb() {
  await pool.query(`
    create table if not exists users (
      telegram_user_id bigint primary key,
      telegram_username text,
      nick text,
      mlbb_id text,
      mlbb_zone text,
      rating int not null default 0,
      mvp_count int not null default 0
    );
    create table if not exists lobbies (
      id text primary key,
      title text not null,
      room_code text,
      created_at timestamptz default now()
    );
    create table if not exists lobby_players (
      lobby_id text references lobbies(id),
      user_id bigint references users(telegram_user_id),
      team int not null,
      role text not null,
      primary key(lobby_id, team, role)
    );
  `);
}
initDb().catch(console.error);

// Middleware авторизации Telegram WebApp
function auth(req, res, next) {
  const initData = req.headers['x-init-data'];
  if (!initData) {
    // Режим разработки или упрощенной авторизации
    req.tg = { id: 100000001, username: 'demo_user' };
    return next();
  }
  const params = new URLSearchParams(initData);
  const userStr = params.get('user');
  if (userStr) {
    try {
      req.tg = JSON.parse(userStr);
      return next();
    } catch (e) {}
  }
  res.status(401).json({ error: 'Unauthorized' });
}

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// Профиль пользователя и сохранения ID/Zone ID
app.get('/api/profile', auth, wrap(async (req, res) => {
  const { rows: [u] } = await pool.query('select * from users where telegram_user_id = $1', [req.tg.id]);
  if (!u) return res.json({ ok: true, profile: null });
  res.json({
    ok: true,
    profile: {
      nick: u.nick,
      mlbbId: u.mlbb_id,
      mlbbZone: u.mlbb_zone,
      rating: u.rating,
      mvpCount: u.mvp_count
    }
  });
}));

app.post('/api/profile', auth, wrap(async (req, res) => {
  const { mlbbId, mlbbZone, nick } = req.body;
  if (!mlbbId || !mlbbZone) return res.status(400).json({ error: 'Укажите ID и Zone ID' });

  const verifiedNick = nick || `Player_${mlbbId}`;
  const { rows: [u] } = await pool.query(
    `insert into users (telegram_user_id, telegram_username, nick, mlbb_id, mlbb_zone)
     values ($1, $2, $3, $4, $5)
     on conflict (telegram_user_id) do update set nick = $3, mlbb_id = $4, mlbb_zone = $5
     returning *`,
    [req.tg.id, req.tg.username || null, verifiedNick, mlbbId, mlbbZone]
  );

  res.json({
    ok: true,
    profile: {
      nick: u.nick,
      mlbbId: u.mlbb_id,
      mlbbZone: u.mlbb_zone,
      rating: u.rating,
      mvpCount: u.mvp_count
    }
  });
}));

// Лобби
app.get('/api/lobby', auth, wrap(async (req, res) => {
  const lobbyId = req.headers['x-lobby'] || 'default';
  const { rows: players } = await pool.query(
    `select lp.team, lp.role, u.telegram_user_id as uid, u.telegram_username as username, u.nick
     from lobby_players lp
     join users u on u.telegram_user_id = lp.user_id
     where lp.lobby_id = $1`, [lobbyId]
  );

  const me = players.find(p => String(p.uid) === String(req.tg.id)) || null;

  res.json({
    ok: true,
    title: 'OLYMP Custom MLBB',
    roomCode: 'OLYMP-2026',
    count: players.length,
    players,
    me
  });
}));

app.post('/api/claim', auth, wrap(async (req, res) => {
  const lobbyId = req.headers['x-lobby'] || 'default';
  const { team, role } = req.body;

  // Создаем дефолтное лобби, если его ещё нет
  await pool.query(`insert into lobbies (id, title) values ($1, 'OLYMP Match') on conflict do nothing`, [lobbyId]);

  // Удаляем предыдущую роль игрока в лобби
  await pool.query(`delete from lobby_players where lobby_id = $1 and user_id = $2`, [lobbyId, req.tg.id]);

  // Занимаем новую роль
  await pool.query(
    `insert into lobby_players (lobby_id, user_id, team, role) values ($1, $2, $3, $4)`,
    [lobbyId, req.tg.id, team, role]
  );

  const { rows: players } = await pool.query(
    `select lp.team, lp.role, u.telegram_user_id as uid, u.telegram_username as username, u.nick
     from lobby_players lp join users u on u.telegram_user_id = lp.user_id where lp.lobby_id = $1`, [lobbyId]
  );

  res.json({
    ok: true,
    count: players.length,
    players,
    me: { team, role, uid: req.tg.id }
  });
}));

app.post('/api/release', auth, wrap(async (req, res) => {
  const lobbyId = req.headers['x-lobby'] || 'default';
  await pool.query(`delete from lobby_players where lobby_id = $1 and user_id = $2`, [lobbyId, req.tg.id]);

  const { rows: players } = await pool.query(
    `select lp.team, lp.role, u.telegram_user_id as uid, u.telegram_username as username, u.nick
     from lobby_players lp join users u on u.telegram_user_id = lp.user_id where lp.lobby_id = $1`, [lobbyId]
  );

  res.json({ ok: true, count: players.length, players, me: null });
}));

// Рейтинг и Сезоны
app.get('/api/rating', auth, wrap(async (req, res) => {
  const { rows: leaderboard } = await pool.query(
    `select telegram_username as username, nick, mlbb_id, rating, mvp_count from users where rating > 0 order by rating desc limit 50`
  );

  res.json({
    ok: true,
    season: { name: 'OLYMP Season 1', endsIn: '12 дней' },
    leaderboard
  });
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OLYMP Custom Bot Server running on port ${PORT}`));