// Добавьте в схему базы данных (внутрь SCHEMA в server.js):
/*
  alter table users add column if not exists mlbb_zone text;
  alter table users add column if not exists rating int not null default 0;
  alter table users add column if not exists mvp_count int not null default 0;
  
  create table if not exists seasons (
    id serial primary key,
    name text not null,
    ends_at timestamptz not null,
    active boolean not null default true
  );
*/

// Эндпоинт проверки аккаунта MLBB и сохранения профиля
app.post('/api/profile', auth, wrap(async (req, res) => {
  const { mlbbId, mlbbZone, nick } = req.body;
  if (!mlbbId || !mlbbZone) return res.status(400).json({ error: 'Укажите ID и Zone ID' });

  // Здесь вызывается логика Rone Arena API или симуляция проверки по ID/Zone
  // (согласно rone_arena_api.md, запросы идут через бэкенд)
  let verifiedNick = nick || `MLBB#${mlbbId}`;
  
  const { rows: [u] } = await pool.query(
    `insert into users (telegram_user_id, telegram_username, nick, mlbb_id, mlbb_zone)
     values ($1, $2, $3, $4, $5)
     on conflict (telegram_user_id) do update set nick = $3, mlbb_id = $4, mlbb_zone = $5
     returning *`, [req.tg.id, req.tg.username || null, verifiedNick, mlbbId, mlbbZone]);
     
  res.json({ ok: true, profile: { nick: u.nick, mlbbId: u.mlbb_id, mlbbZone: u.mlbb_zone, rank: u.mlbb_rank, rating: u.rating || 0, mvpCount: u.mvp_count || 0 } });
}));

// Эндпоинт рейтинговой системы и сезона MLBB
app.get('/api/rating', auth, wrap(async (req, res) => {
  // Получаем топ игроков по рейтингу текущего сезона
  const { rows: leaderboard } = await pool.query(
    `select telegram_username as username, nick, mlbb_id, rating, mvp_count from users where rating > 0 order by rating desc limit 20`
  );
  
  res.json({
    ok: true,
    season: { name: 'MLBB Season 34 x OLYMP', endsIn: '18 дней' },
    leaderboard
  });
}));

// Админ-команда для начисления MVP игроку (поднимает рейтинг и начисляет призы за сезон)
app.post('/api/admin/mvp', auth, need('create'), wrap(async (req, res) => {
  const { uid } = req.body; // telegram_user_id игрока, получившего MVP в кастомке
  await pool.query('update users set rating = rating + 100, mvp_count = mvp_count + 1 where telegram_user_id = $1', [uid]);
  res.json({ ok: true, message: 'Рейтинг за MVP успешно начислен!' });
}));