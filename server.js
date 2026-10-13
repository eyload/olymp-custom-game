import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { SNAPSHOT, SNAPSHOT_HEROES, BUILDS, BUILDS_SRC, ITEMS } from './meta-data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { DATABASE_URL, BOT_TOKEN, PORT = 3000, SEASON_DAYS = '90', APP_URL } = process.env;
// Сезон как в MLBB: номер, длина 90 дней и дата конца. Сейчас 42-й сезон, конец 16.12.2026 00:00 (Ереван, UTC+4).
// Когда сезон истечёт, следующий создастся сам (номер +1, ещё 90 дней). Поменять можно переменными SEASON_NUMBER и SEASON_ENDS_AT.
const SEASON_NUMBER = Number(process.env.SEASON_NUMBER) || 42;
const SEASON_ENDS_AT = new Date(process.env.SEASON_ENDS_AT || '2026-12-15T20:00:00Z');
if (!DATABASE_URL || !BOT_TOKEN) throw new Error('Set DATABASE_URL and BOT_TOKEN');

// ── Настройки рейтинга ──────────────────────────────────────────────
const MVP_RP = 25; // очков рейтинга за один MVP
const PRIZES = []; // призы сезона: пока пусто, заполним позже
const ROLES = ['jungle', 'exp', 'mid', 'gold', 'roam'];
// ── Персонал ────────────────────────────────────────────────────────
// OWNERS = переменная ADMINS (или старая ADMIN_IDS): Telegram id и/или @username через запятую.
// У владельцев всегда все права, и только они управляют персоналом. Админы и модераторы лежат
// в таблице staff, права каждому выдаются отдельно из админ-панели.
const parseList = v => (v || '').toLowerCase().split(',').map(x => x.trim().replace(/^@/, '')).filter(Boolean);
const OWNERS = parseList(process.env.ADMINS || process.env.ADMIN_IDS);
const GRANTABLE = ['create', 'delete', 'time', 'reset', 'room', 'kick', 'broadcast', 'lock', 'ban', 'log']; // права, которые можно выдать
const PRESET = { admin: GRANTABLE, mod: ['room', 'kick', 'broadcast'] }; // набор по умолчанию при выборе роли
const RANK = { owner: 3, admin: 2, mod: 1 }; // кикать и банить можно только тех, кто ниже рангом
const MOD_BROADCAST_COOLDOWN = 60000; // модератор: одна рассылка / напоминание в минуту
const modBroadcastAt = new Map();
const ownerIds = new Set();
const isOwner = tg => OWNERS.includes(String(tg.id)) || (!!tg.username && OWNERS.includes(tg.username.toLowerCase()));

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 15000,
});
pool.on('error', e => console.error('pg pool error', e));
process.on('unhandledRejection', e => console.error('unhandledRejection', e));

const STAFF_TTL = 3000;
let staffCache = { at: 0, rows: [] }, staffLoading = null;
function staffRows() {
  if (Date.now() - staffCache.at < STAFF_TTL) return Promise.resolve(staffCache.rows);
  staffLoading ??= pool.query('select id, uid::text as uid, handle, role, perms from staff')
    .then(r => { staffCache = { at: Date.now(), rows: r.rows }; return r.rows; })
    .finally(() => { staffLoading = null; });
  return staffLoading;
}
const staffChanged = () => { staffCache = { at: 0, rows: staffCache.rows }; };
async function resolveStaff(tg) {
  const uid = String(tg.id), un = tg.username?.toLowerCase();
  if (isOwner(tg)) { ownerIds.add(uid); return { role: 'owner', perms: [...GRANTABLE, 'staff'] }; }
  const rows = await staffRows().catch(() => staffCache.rows);
  const row = rows.find(r => r.uid === uid) || (un && rows.find(r => !r.uid && r.handle === un));
  if (!row) return { role: null, perms: [] };
  if (!row.uid) { // добавлен по @username: закрепляем за Telegram id при первом входе
    row.uid = uid;
    pool.query('update staff set uid = $2 where id = $1 and uid is null', [row.id, uid]).catch(console.error);
  }
  return { role: row.role, perms: row.perms };
}
async function rankOfUid(uid) {
  if (ownerIds.has(uid) || OWNERS.includes(uid)) return RANK.owner;
  const r = (await staffRows().catch(() => staffCache.rows)).find(x => x.uid === uid);
  return r ? RANK[r.role] || 0 : 0;
}
const roleOf = tg => tg.staff?.role ?? null;
const permsOf = tg => tg.staff?.perms ?? [];
const can = (tg, perm) => permsOf(tg).includes(perm);
const myRank = tg => RANK[roleOf(tg)] || 0;

// ── Схема ───────────────────────────────────────────────────────────
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
  alter table users add column if not exists mlbb_stats jsonb;
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
  alter table lobbies add column if not exists starts_at timestamptz,
    add column if not exists notified20 boolean not null default false,
    add column if not exists notified10 boolean not null default false,
    add column if not exists room_code text,
    add column if not exists locked boolean not null default false;

  create table if not exists role_assignments (
    id serial primary key,
    lobby_id int not null references lobbies(id),
    telegram_user_id bigint not null,
    telegram_username text not null,
    team smallint not null,
    role text not null,
    constraint uq_slot unique (lobby_id, team, role),
    constraint uq_player unique (lobby_id, telegram_user_id));
  alter table role_assignments add column if not exists confirmed boolean not null default false;

  create index if not exists idx_ra_user on role_assignments (telegram_user_id);
  create index if not exists idx_scores_rank on season_scores (season_id, rating desc, mvp_count desc);

  create table if not exists staff (
    id serial primary key,
    uid bigint,
    handle text,
    role text not null check (role in ('admin','mod')),
    perms text[] not null default '{}',
    added_by bigint,
    created_at timestamptz not null default now(),
    constraint staff_has_key check (uid is not null or handle is not null));
  create unique index if not exists uq_staff_uid on staff (uid) where uid is not null;
  create unique index if not exists uq_staff_handle on staff (handle) where handle is not null;

  create table if not exists bans (
    telegram_user_id bigint primary key,
    username text,
    by_id bigint,
    created_at timestamptz not null default now());

  create table if not exists audit_log (
    id serial primary key,
    at timestamptz not null default now(),
    actor_id bigint,
    actor_name text,
    role text,
    action text not null,
    lobby_id int,
    detail text);
`;
{
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(727001)'); // миграции при старте нескольких реплик идут по очереди
    await c.query(SCHEMA);
  } finally {
    await c.query('select pg_advisory_unlock(727001)').catch(() => {});
    c.release();
  }
}

// ── Сезоны: когда сезон истёк, следующий создаётся сам, рейтинг начинается с нуля ──
// При старте подгоняем текущий сезон под MLBB: если активный сезон другой, переименовываем его в нужный номер
// (очки игроков сохраняются), иначе создаём новый. Старые сезоны с меньшим номером закрываются.
async function syncSeason() {
  const days = Number(SEASON_DAYS) || 90;
  if (isNaN(SEASON_ENDS_AT)) return;
  const startsAt = new Date(SEASON_ENDS_AT.getTime() - days * 864e5);
  if (SEASON_ENDS_AT <= Date.now()) return; // дата в прошлом: сезоны пойдут по обычной цепочке
  const name = 'MLBB Season ' + SEASON_NUMBER;
  const { rows: [have] } = await pool.query('select id from seasons where number = $1', [SEASON_NUMBER]);
  if (have) { await pool.query('update seasons set name = $2, starts_at = $3, ends_at = $4 where id = $1', [have.id, name, startsAt, SEASON_ENDS_AT]); return; }
  const { rows: [cur] } = await pool.query('select id from seasons where ends_at > now() and number < $1 order by id desc limit 1', [SEASON_NUMBER]);
  if (cur) await pool.query('update seasons set number = $2, name = $3, starts_at = $4, ends_at = $5 where id = $1', [cur.id, SEASON_NUMBER, name, startsAt, SEASON_ENDS_AT]);
  else await pool.query('insert into seasons (number, name, starts_at, ends_at) values ($1, $2, $3, $4)', [SEASON_NUMBER, name, startsAt, SEASON_ENDS_AT]);
}
await syncSeason().catch(e => console.error('syncSeason', e));

async function loadSeason() {
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

// Сезон меняется раз в месяц: держим в памяти до конца, а не ходим в базу на каждый запрос.
let seasonCache = null;
async function season() {
  if (seasonCache && new Date(seasonCache.ends_at) > Date.now()) return seasonCache;
  return (seasonCache = await loadSeason());
}
// Топ сезона: один запрос раз в 10 секунд на всех (сбрасывается при выдаче MVP).
const BOARD_TTL = 10000;
let boardCache = { at: 0, sid: 0, rows: null };
async function board(sid) {
  if (boardCache.sid === sid && Date.now() - boardCache.at < BOARD_TTL && boardCache.rows) return boardCache.rows;
  const { rows } = await pool.query(
    `select coalesce(u.mlbb_name, u.nick, u.telegram_username, 'Игрок') as name, sc.rating, sc.mvp_count as mvp
     from season_scores sc join users u on u.telegram_user_id = sc.telegram_user_id
     where sc.season_id = $1 and sc.rating > 0 order by sc.rating desc, sc.mvp_count desc limit 15`, [sid]);
  boardCache = { at: Date.now(), sid, rows };
  return rows;
}

// ── Rone Arena API (неофициальный, MLBB). Запросы только с бэкенда ──
const HOSTS = ['https://arena.rone.dev/api', 'https://arena-hv.fastapicloud.dev/api'];
async function rone(method, p, { body, jwt } = {}) {
  let last;
  for (const host of HOSTS) { // при 503 / сетевой ошибке пробуем запасной хост
    try {
      const r = await fetch(host + p, {
        method, signal: AbortSignal.timeout(10000), body: body && JSON.stringify(body),
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
// ── Статистика игрока из ответов Rone Arena ──
// Форматы по документации API: /user/info даёт rank_level и history_rank_level (числа),
// /user/stats даёт wc (победы), tc (матчи), mvpc, wsc (серия побед), gt (часы), as (оценка ×100),
// /user/heroes/frequent требует sid сезона (берём из stats.sids). Названия рангов берём из /academy/ranks по диапазонам id.
const num = v => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : null; };
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
// Таблица рангов из API всегда приходит на китайском (lang не действует), поэтому названия задаём сами по номеру тира.
// Диапазоны id берём из /academy/ranks. Mythic (bigrank 7, id от 236) включает Honor / Glory / Immortal, их считаем по звёздам.
const BIG = { 1: 'Warrior', 2: 'Elite', 3: 'Master', 4: 'Grandmaster', 5: 'Epic', 6: 'Legend', 7: 'Mythic' };
const ROMAN = { 'Ⅰ': 'I', 'Ⅱ': 'II', 'Ⅲ': 'III', 'Ⅳ': 'IV', 'Ⅴ': 'V' };
let rankTable = null, rankTableAt = 0;
async function rankName(level) {
  if (level == null) return null;
  if (!rankTable || Date.now() - rankTableAt > 6 * 3600e3) {
    try {
      const d = await rone('GET', '/academy/ranks?size=60&index=1&lang=en');
      const t = (d?.records || []).map(r => r.data).filter(x => x && x.rankid_start != null)
        .map(x => ({ a: +x.rankid_start, b: +x.rankid_end, big: +x.bigrank, sub: ROMAN[x.minrank_name] || x.minrank_name || '' }));
      if (t.length) { rankTable = t; rankTableAt = Date.now(); }
    } catch (e) { console.error('[mlbb] ranks', e.message); }
  }
  if (!rankTable) return null;
  const hit = rankTable.find(r => level >= r.a && level <= r.b);
  if (!hit || !BIG[hit.big]) return null;
  if (hit.big === 7) { // Mythic+: звёзды = id − 236 (оценка по порогам 25 / 50 / 100)
    const st = Math.max(0, level - hit.a);
    return (st >= 100 ? 'Mythical Immortal' : st >= 50 ? 'Mythical Glory' : st >= 25 ? 'Mythical Honor' : 'Mythic') + ` · ${st}★`;
  }
  return BIG[hit.big] + (hit.sub ? ' ' + hit.sub : '');
}
async function playerStats(jwt, info) {
  let note = null;
  const get = p => rone('GET', p, { jwt }).catch(e => { console.error('[mlbb] fail', p.split('?')[0], e.message); note ||= String(e.message).slice(0, 80); return null; });
  const st = await get('/user/stats?lang=en'), sid = st?.sids?.[0];
  const [fr, rank, best] = await Promise.all([sid != null ? get(`/user/heroes/frequent?sid=${sid}&limit=5&lang=en`) : null,
    rankName(num(info?.rank_level)), rankName(num(info?.history_rank_level))]);
  const tc = num(st?.tc), wc = num(st?.wc), as = num(st?.as);
  const heroes = (fr?.result || []).slice(0, 5).map(x => ({ n: x.hid_e?.n || '?', m: num(x.tc) ?? 0, wr: num(x.tc) ? r1(num(x.wc) / num(x.tc) * 100) : 0, img: x.hid_e?.ix || null }));
  return { rank, best, wr: tc ? r1(wc / tc * 100) : null, matches: tc, mvp: num(st?.mvpc), streak: num(st?.wsc),
    hours: r1(num(st?.gt)), score: as != null ? Math.round(as) / 100 : null, heroes, note: st ? null : /[\u3400-\u9fff]/.test(note || '') ? 'offline' : note || 'нет ответа', at: new Date().toISOString() };
}

// Защита от спама кодами в игровую почту: 1 запрос в минуту на Telegram-аккаунт и на игровой ID
const vcSeen = new Map();
const tooSoon = k => { const t = vcSeen.get(k) || 0; if (Date.now() - t < 60000) return true; vcSeen.set(k, Date.now()); return false; };

// ── Лимит запросов на пользователя (в памяти) ──
const RATE_WINDOW = 10000;
const RATE_MAX = Number(process.env.RATE_MAX) || 60;
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
  for (const [k, t] of vcSeen) if (now - t > 120000) vcSeen.delete(k);
}, 30000).unref();

// ── Отправка сообщений в Telegram: троттлинг (~25 сообщений/с), таймаут, повтор при 429 ──
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
    await resp.arrayBuffer().catch(() => {});
    return resp.ok;
  }
  return false;
}
const openLobby = () => (APP_URL ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть лобби', web_app: { url: APP_URL } }]] } } : {});

// ── Приложение ──────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.get('/health', (req, res) => res.json({ ok: true }));
// gzip, если установлен пакет compression (npm i compression): страница и JSON уменьшаются в разы.
const compression = await import('compression').then(m => m.default).catch(() => null);
if (compression) app.use(compression());
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res, p) => res.setHeader('Cache-Control', p.endsWith('.html') ? 'no-cache' : 'public, max-age=86400'), // html всегда сверяется, остальное из кэша
}));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const h = fn => (req, res) => fn(req, res).catch(e => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'Ошибка сервера, попробуй ещё раз' }); });

// Проверка initData Telegram (HMAC-SHA256). Личность берётся только отсюда.
async function auth(req, res, next) {
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
  tg.staff = await resolveStaff(tg).catch(() => ({ role: null, perms: [] })); // роль и права определяются здесь, раз на запрос
  req.tg = tg;
  next();
}

// Каждое изменяющее действие персонала попадает в журнал (таблица + логи).
const need = perm => (req, res, next) => {
  if (!can(req.tg, perm)) return res.status(403).json({ error: 'forbidden' });
  if (req.method !== 'GET') audit(req);
  next();
};
function audit(req) {
  const action = req.path.replace(/^\/api\/admin\//, '');
  const detail = req.body && Object.keys(req.body).length ? JSON.stringify(req.body).slice(0, 200) : null;
  console.log(`[staff] ${roleOf(req.tg)} ${req.tg.id}${req.tg.username ? ' @' + req.tg.username : ''} ${action} ${detail || ''}`);
  pool.query('insert into audit_log (actor_id, actor_name, role, action, lobby_id, detail) values ($1, $2, $3, $4, 1, $5)',
    [req.tg.id, req.tg.username || null, roleOf(req.tg), action, detail]).catch(console.error);
}
setInterval(() => pool.query("delete from audit_log where at < now() - interval '60 days'").catch(() => {}), 6 * 3600 * 1000).unref();

// Модератор может делать рассылку / напоминание раз в минуту. true = запрос отклонён.
function modCooldown(req, res) {
  if (roleOf(req.tg) !== 'mod') return false;
  if (Date.now() - (modBroadcastAt.get(req.tg.id) || 0) < MOD_BROADCAST_COOLDOWN) { res.status(429).json({ error: 'cooldown' }); return true; }
  modBroadcastAt.set(req.tg.id, Date.now());
  return false;
}

const prof = u => u && { nick: u.mlbb_name || u.nick, mlbbId: u.mlbb_id, mlbbZone: u.mlbb_zone, avatar: u.mlbb_avatar, level: u.mlbb_level, verified: u.mlbb_verified, stats: u.mlbb_stats || null };

// Разбор ранга из Yanjiestore. Ответ сервиса может быть JSON, текстом или HTML.
function parseYanjiestoreRank(payload) {
  const rankKeys = /^(rank|rankname|rank_name|currentrank|current_rank|tier|league|grade|ranklevel|rank_level)$/i;
  const candidates = [];
  const walk = (v, key = '') => {
    if (v == null) return;
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    } else if (typeof v === 'string' || typeof v === 'number') {
      const value = String(v).trim();
      if (rankKeys.test(key) && value) candidates.unshift(value);
      else if (/(mythical?\s*(immortal|glory|honor)|mythic|legend|epic|grandmaster|master|elite|warrior)/i.test(value)) candidates.push(value);
    }
  };
  walk(payload);
  const text = typeof payload === 'string' ? payload.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ') : '';
  if (text) candidates.push(text);
  const rankPattern = /(Mythical\s*Immortal|Mythical\s*Glory|Mythical\s*Honor|Mythic|Legend|Epic|Grandmaster|Master|Elite|Warrior)(?:\s*(?:[IVX]+|\d+))?(?:\s*[·•-]?\s*\d+\s*(?:stars?|★))?/i;
  for (const candidate of candidates) {
    const match = candidate.match(rankPattern);
    if (match) return match[0].replace(/\s+/g, ' ').trim();
  }
  return null;
}

// Точнее определяем текущий ранг через Yanjiestore по игровому ID и Zone ID.
app.post('/api/mlbb/rank-lookup', auth, h(async (req, res) => {
  const mlbbId = String(req.body.mlbbId || '').trim();
  const mlbbZone = String(req.body.mlbbZone || '').trim();
  if (!/^\d{5,12}$/.test(mlbbId) || !/^\d{3,6}$/.test(mlbbZone)) {
    return res.status(400).json({ error: 'Проверь игровой ID и Zone ID' });
  }
  const { rows: [saved] } = await pool.query(
    'select * from users where telegram_user_id = $1', [req.tg.id]);
  if (!saved || saved.mlbb_id !== mlbbId || saved.mlbb_zone !== mlbbZone) {
    return res.status(409).json({ error: 'Сначала сохрани этот ID и Zone ID в профиле' });
  }
  const url = new URL('https://yanjiestore.com/submitt.php');
  url.searchParams.set('ID', mlbbId);
  url.searchParams.set('server', mlbbZone);
  let payload, rawText = '';
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: { 'Accept': 'application/json, text/plain, text/html;q=0.9', 'User-Agent': 'OLYMP-CUSTOM/1.0' }
    });
    rawText = await response.text();
    if (!response.ok) return res.status(502).json({ error: `Сервис определения ранга ответил HTTP ${response.status}` });
    try { payload = JSON.parse(rawText); } catch { payload = rawText; }
  } catch (e) {
    console.error('[mlbb] Yanjiestore rank lookup:', e.message);
    return res.status(502).json({ error: 'Сервис определения ранга временно недоступен' });
  }
  const rank = parseYanjiestoreRank(payload);
  if (!rank) {
    console.warn('[mlbb] Yanjiestore response format not recognized:', rawText.slice(0, 300));
    return res.status(502).json({ error: 'Сервис ответил, но формат ранга не распознан. Проверь ответ API или попробуй позже.' });
  }
  const stats = { ...(saved.mlbb_stats || {}), rank, rankSource: 'Yanjiestore', rankCheckedAt: new Date().toISOString() };
  const { rows: [updated] } = await pool.query(
    'update users set mlbb_stats = $1 where telegram_user_id = $2 returning *',
    [JSON.stringify(stats), req.tg.id]);
  res.json({ ok: true, rank, profile: prof(updated) });
}));

// ── Профиль и привязка аккаунта MLBB ──
app.get('/api/profile', auth, h(async (req, res) => {
  const { rows: [u] } = await pool.query('select * from users where telegram_user_id = $1', [req.tg.id]);
  res.json({ ok: true, profile: prof(u) });
}));

// Сохранение ID, Zone ID и ника. Смена ID или Zone сбрасывает подтверждение аккаунта.
app.post('/api/profile', auth, h(async (req, res) => {
  const mlbbId = String(req.body.mlbbId || '').trim(), mlbbZone = String(req.body.mlbbZone || '').trim(), nick = String(req.body.nick || '').trim().slice(0, 24);
  if (!/^\d{5,12}$/.test(mlbbId) || !/^\d{3,6}$/.test(mlbbZone)) return res.status(400).json({ error: 'Проверь формат ID и Zone ID' });
  const { rows: [u] } = await pool.query(
    `insert into users (telegram_user_id, telegram_username, nick, mlbb_id, mlbb_zone) values ($1, $2, nullif($3, ''), $4, $5)
     on conflict (telegram_user_id) do update set telegram_username = $2,
       mlbb_verified = users.mlbb_verified and users.mlbb_id = $4 and users.mlbb_zone = $5,
       mlbb_stats = case when users.mlbb_id = $4 and users.mlbb_zone = $5 then users.mlbb_stats end,
       nick = coalesce(nullif($3, ''), users.nick),
       mlbb_name = case when users.mlbb_verified and users.mlbb_id = $4 and users.mlbb_zone = $5 then coalesce(nullif($3, ''), users.mlbb_name) else users.mlbb_name end,
       mlbb_id = $4, mlbb_zone = $5
     returning *`, [req.tg.id, req.tg.username || null, nick, mlbbId, mlbbZone]);
  boardCache.at = 0; lobbyCache = null;
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
  let jwt, info, stats = null;
  try {
    ({ jwt } = await rone('POST', '/user/auth/login', { body: { role_id: +mlbbId, zone_id: +mlbbZone, vc: +code } }));
    info = await rone('GET', '/user/info?lang=en', { jwt });
  } catch { return res.status(400).json({ error: 'Код неверный или истёк' }); }
  // Ранг, винрейт и т.д. Если запросы не прошли, аккаунт всё равно подтверждается, просто без этих цифр.
  try {
    stats = await playerStats(jwt, info);
    console.log('[mlbb] stats', JSON.stringify({ rank_level: info.rank_level, history: info.history_rank_level, got: Object.keys(stats).filter(k => stats[k] != null && !(Array.isArray(stats[k]) && !stats[k].length)) }));
  } catch (e) { console.error('[mlbb] stats parse', e); }
  rone('POST', '/user/auth/logout', { jwt }).catch(() => {});
  try {
    const { rows: [u] } = await pool.query(
      `insert into users (telegram_user_id, telegram_username, nick, mlbb_id, mlbb_zone, mlbb_name, mlbb_avatar, mlbb_level, mlbb_verified, mlbb_stats)
       values ($1, $2, $3, $4, $5, $3, $6, $7, true, $8)
       on conflict (telegram_user_id) do update set telegram_username = $2, nick = $3, mlbb_id = $4, mlbb_zone = $5,
         mlbb_name = $3, mlbb_avatar = $6, mlbb_level = $7, mlbb_verified = true, mlbb_stats = $8
       returning *`,
      [req.tg.id, req.tg.username || null, info.name || 'Игрок', mlbbId, mlbbZone, info.avatar || null, info.level ?? null, stats ? JSON.stringify(stats) : null]);
    res.json({ ok: true, profile: prof(u) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Этот аккаунт уже привязан к другому игроку' });
    throw e;
  }
}));

// ── Рейтинг ──
app.get('/api/rating', auth, h(async (req, res) => {
  const s = await season();
  const [rows, { rows: [m] }] = await Promise.all([board(s.id),
    pool.query('select rating, mvp_count from season_scores where season_id = $1 and telegram_user_id = $2', [s.id, req.tg.id])]);
  const rating = m?.rating || 0;
  const place = rating > 0 ? 1 + (await pool.query('select count(*)::int as n from season_scores where season_id = $1 and rating > $2', [s.id, rating])).rows[0].n : null;
  const total = Math.round((new Date(s.ends_at) - new Date(s.starts_at)) / 864e5);
  res.json({
    ok: true, mvpRp: MVP_RP, prizes: PRIZES,
    season: { number: s.number, name: s.name, days: total, left: Math.max(0, Math.ceil((new Date(s.ends_at) - Date.now()) / 864e5)), endsAt: s.ends_at },
    me: { rating, mvp: m?.mvp_count || 0, place },
    leaderboard: rows,
  });
}));

// ── Мета героев ──
// Живая статистика берётся из Rone Arena (/heroes/rank) и кэшируется на 10 минут. Если API недоступно или ответ не похож на ожидаемый,
// отдаётся сохранённый срез из meta-data.js, поэтому раздел никогда не остаётся пустым.
const META_TTL = 10 * 60 * 1000, metaCache = new Map();
const RANKS_OK = ['all', 'epic', 'legend', 'mythic', 'honor', 'glory'], DAYS_OK = [1, 3, 7, 15, 30];
function tierize(list) { // тир по сумме: винрейт важнее всего, пик и бан добавляют вес
  const sc = h => h.wr + 0.08 * (h.pick || 0) + 0.04 * (h.ban || 0);
  const sorted = [...list].sort((a, b) => sc(b) - sc(a)), n = sorted.length;
  sorted.forEach((h, i) => { const q = i / n; h.tier = q < 0.08 ? 'S' : q < 0.28 ? 'A' : q < 0.63 ? 'B' : q < 0.88 ? 'C' : 'D'; });
  return sorted;
}
async function liveHeroes(rank, days) {
  const d = await rone('GET', `/heroes/rank?days=${days}&rank=${rank}&size=130&index=1&sort_field=win_rate&sort_order=desc&lang=en`);
  const recs = d?.records || d?.list || (Array.isArray(d) ? d : []);
  const raw = recs.map(r => {
    const m = r?.data?.main_hero?.data || r?.main_hero?.data || r?.hero || r || {}, x = r?.data || r;
    return { name: m.name, img: m.head || m.head_big || m.icon || null,
      wr: num(x.main_hero_win_rate ?? x.win_rate), pick: num(x.main_hero_appearance_rate ?? x.appearance_rate ?? x.pick_rate), ban: num(x.main_hero_ban_rate ?? x.ban_rate) };
  }).filter(h => h.name && h.wr != null);
  if (raw.length < 20) throw new Error('meta shape');
  const frac = Math.max(...raw.map(h => Math.max(h.wr, h.pick || 0, h.ban || 0))) <= 1; // доли (0.53) или проценты (53)
  const k = frac ? 100 : 1, r1 = v => v == null ? null : Math.round(v * k * 100) / 100;
  return tierize(raw.map(h => ({ ...h, wr: r1(h.wr), pick: r1(h.pick), ban: r1(h.ban) })));
}
app.get('/api/meta', auth, h(async (req, res) => {
  const rank = RANKS_OK.includes(req.query.rank) ? req.query.rank : 'mythic', days = DAYS_OK.includes(+req.query.days) ? +req.query.days : 7;
  const key = rank + days, hit = metaCache.get(key);
  let live = hit && Date.now() - hit.at < META_TTL ? hit : null;
  if (!live) {
    try { live = { at: Date.now(), heroes: await liveHeroes(rank, days) }; metaCache.set(key, live); }
    catch (e) { console.error('meta live failed:', e.message); live = hit || null; }
  }
  res.set('Cache-Control', 'private, max-age=60');
  res.json({
    ok: true, live: !!live, heroes: live ? live.heroes : SNAPSHOT_HEROES, updatedAt: live ? new Date(live.at).toISOString() : SNAPSHOT.date,
    snapshot: SNAPSHOT, builds: BUILDS, buildsSrc: BUILDS_SRC, items: ITEMS,
  });
}));

// ── Лобби ──
// Состояние лобби одинаково для всех, кроме нескольких полей: грузим его ОДНИМ запросом раз в TTL
// (одновременные запросы делят один промис), а персонализируем в памяти. После любой записи state(tg, true)
// сбрасывает кэш, поэтому автор и следующие читатели сразу видят свежие данные.
const TTL = Number(process.env.CACHE_TTL_MS) || 1500;
let lobbyCache = null;
async function loadShared() {
  const { rows: [r] } = await pool.query(
    `select
       (select coalesce(json_agg(json_build_object('uid', r.telegram_user_id::text,
          'name', coalesce(u.mlbb_name, u.nick, r.telegram_username), 'username', r.telegram_username,
          'team', r.team, 'role', r.role, 'confirmed', r.confirmed) order by r.id), '[]'::json)
        from role_assignments r left join users u on u.telegram_user_id = r.telegram_user_id where r.lobby_id = 1) as players,
       (select row_to_json(x) from (select starts_at, room_code, title, locked from lobbies where id = 1) x) as lobby`);
  return r;
}
function cachedLobby() {
  const e = lobbyCache;
  if (e && Date.now() - e.at < TTL) return e.p;
  const p = loadShared();
  const ne = { at: Date.now(), p };
  lobbyCache = ne;
  p.catch(() => { if (lobbyCache === ne) lobbyCache = null; });
  return p;
}
// Состояние лобби с учётом того, кто спрашивает: роль и права персонала, код комнаты видят только игроки и персонал.
async function state(tg, fresh = false) {
  if (fresh) lobbyCache = null;
  const { players, lobby: l } = await cachedLobby();
  const uid = String(tg.id), role = roleOf(tg), me = players.find(p => p.uid === uid) || null;
  return {
    players, count: players.length, me, mvpRp: MVP_RP,
    role, perms: permsOf(tg), admin: can(tg, 'reset'), // admin: может завершать матч
    title: l?.title || '', startsAt: l?.starts_at ? new Date(l.starts_at) : null, locked: !!l?.locked,
    roomCode: me || role ? l?.room_code || null : null,
  };
}

app.get('/api/lobby', auth, h(async (req, res) => res.json({ ok: true, ...(await state(req.tg)) })));

app.post('/api/claim', auth, h(async (req, res) => {
  const { team, role } = req.body;
  if (![1, 2].includes(team) || !ROLES.includes(role)) return res.status(400).json({ error: 'Неверная роль' });
  const { rows: [g] } = await pool.query( // аккаунт, бан и закрытый набор: один запрос вместо трёх
    `select (select mlbb_verified from users where telegram_user_id = $1) as verified,
            (select locked from lobbies where id = 1) as locked,
            exists (select 1 from bans where telegram_user_id = $1) as banned`, [req.tg.id]);
  if (!g.verified) return res.status(403).json({ error: 'Сначала подтверди аккаунт MLBB' });
  if (g.banned) return res.status(403).json({ error: 'Тебе закрыт доступ к играм' });
  if (g.locked && !can(req.tg, 'lock')) return res.status(403).json({ error: 'Набор в эту игру закрыт' });
  try {
    await pool.query('insert into role_assignments (lobby_id, telegram_user_id, telegram_username, team, role) values (1, $1, $2, $3, $4)',
      [req.tg.id, req.tg.username || 'user', team, role]);
  } catch { return res.status(409).json({ error: 'Роль уже занята или ты уже в лобби' }); }
  res.json({ ok: true, ...(await state(req.tg, true)) });
}));

app.post('/api/release', auth, h(async (req, res) => {
  await pool.query('delete from role_assignments where lobby_id = 1 and telegram_user_id = $1', [req.tg.id]);
  res.json({ ok: true, ...(await state(req.tg, true)) });
}));

// Игрок подтверждает участие («Я на месте»): только своя строка.
app.post('/api/confirm', auth, h(async (req, res) => {
  await pool.query('update role_assignments set confirmed = true where lobby_id = 1 and telegram_user_id = $1', [req.tg.id]);
  res.json({ ok: true, ...(await state(req.tg, true)) });
}));

// ── Админ: управление игрой ──
// Завершить матч, выдать MVP (+RP в текущем сезоне) и очистить лобби. Нужно право reset.
app.post('/api/admin/finish', auth, need('reset'), h(async (req, res) => {
  const { mvpUid } = req.body;
  if (mvpUid) {
    const s = await season();
    const { rowCount } = await pool.query('select 1 from role_assignments where lobby_id = 1 and telegram_user_id = $1', [mvpUid]);
    if (!rowCount) return res.status(400).json({ error: 'Игрока нет в лобби' });
    await pool.query(
      `insert into season_scores (season_id, telegram_user_id, rating, mvp_count) values ($1, $2, $3, 1)
       on conflict (season_id, telegram_user_id) do update
       set rating = season_scores.rating + $3, mvp_count = season_scores.mvp_count + 1`, [s.id, mvpUid, MVP_RP]);
    boardCache.at = 0;
  }
  await pool.query('delete from role_assignments where lobby_id = 1');
  res.json({ ok: true, ...(await state(req.tg, true)) });
}));

app.post('/api/admin/time', auth, need('time'), h(async (req, res) => {
  const t = req.body.startsAt ? new Date(req.body.startsAt) : null;
  if (t && (isNaN(t) || t < Date.now())) return res.status(400).json({ error: 'bad_time' });
  const mins = t ? (t - Date.now()) / 60000 : 0;
  // Окна, которые уже прошли, помечаются отправленными: напоминания не придут поздно или дважды.
  await pool.query('update lobbies set starts_at = $1, notified20 = $2, notified10 = $3 where id = 1', [t, mins <= 20, mins <= 10]);
  res.json({ ok: true, ...(await state(req.tg, true)) });
}));
app.post('/api/admin/kick', auth, need('kick'), h(async (req, res) => {
  const uid = String(req.body.uid ?? '');
  if (!/^\d{1,18}$/.test(uid)) return res.status(400).json({ error: 'bad_request' });
  if ((await rankOfUid(uid)) >= myRank(req.tg)) return res.status(403).json({ error: 'protected' });
  await pool.query('delete from role_assignments where lobby_id = 1 and telegram_user_id = $1', [uid]);
  res.json({ ok: true, ...(await state(req.tg, true)) });
}));
app.post('/api/admin/reset', auth, need('reset'), h(async (req, res) => {
  await pool.query('delete from role_assignments where lobby_id = 1');
  res.json({ ok: true, ...(await state(req.tg, true)) });
}));
app.post('/api/admin/room', auth, need('room'), h(async (req, res) => {
  const code = String(req.body.code || '').trim().slice(0, 32) || null;
  await pool.query('update lobbies set room_code = $1 where id = 1', [code]);
  res.json({ ok: true, ...(await state(req.tg, true)) });
}));
// Закрыть / открыть набор.
app.post('/api/admin/lock', auth, need('lock'), h(async (req, res) => {
  await pool.query('update lobbies set locked = $1 where id = 1', [!!req.body.locked]);
  res.json({ ok: true, ...(await state(req.tg, true)) });
}));

async function sendAll(text, pendingOnly = false) {
  const { rows } = await pool.query('select telegram_user_id::text as id from role_assignments where lobby_id = 1 and (not $1::boolean or not confirmed)', [pendingOnly]);
  const extra = openLobby();
  let sent = 0;
  for (const r of rows) if (await tgSend(r.id, text, extra)) sent++;
  return sent;
}
app.post('/api/admin/broadcast', auth, need('broadcast'), h(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'bad_request' });
  if (modCooldown(req, res)) return;
  const sent = await sendAll('📢 ' + text);
  res.json({ ok: true, ...(await state(req.tg, true)), sent });
}));
// Напоминание только тем, кто ещё не нажал «Я на месте».
app.post('/api/admin/remind', auth, need('broadcast'), h(async (req, res) => {
  if (modCooldown(req, res)) return;
  const st = await state(req.tg, true);
  const sent = await sendAll(`⏰ ${st.title || 'Игра'}: подтверди участие. Открой лобби и нажми «Я на месте».`, true);
  res.json({ ok: true, ...st, sent });
}));

// ── Баны: игрок теряет роль и не может занять новую ──
app.post('/api/admin/ban', auth, need('ban'), h(async (req, res) => {
  const uid = String(req.body.uid ?? '');
  if (!/^\d{1,18}$/.test(uid)) return res.status(400).json({ error: 'bad_request' });
  if ((await rankOfUid(uid)) >= myRank(req.tg)) return res.status(403).json({ error: 'protected' });
  const name = String(req.body.username || '').replace(/^@/, '').slice(0, 32) || null;
  await pool.query('insert into bans (telegram_user_id, username, by_id) values ($1, $2::text, $3) on conflict (telegram_user_id) do update set username = coalesce($2::text, bans.username)', [uid, name, req.tg.id]);
  await pool.query('delete from role_assignments where telegram_user_id = $1', [uid]);
  res.json({ ok: true, ...(await state(req.tg, true)) });
}));
app.post('/api/admin/unban', auth, need('ban'), h(async (req, res) => {
  const uid = String(req.body.uid ?? '');
  if (!/^\d{1,18}$/.test(uid)) return res.status(400).json({ error: 'bad_request' });
  await pool.query('delete from bans where telegram_user_id = $1', [uid]);
  res.json({ ok: true });
}));
app.get('/api/admin/bans', auth, need('ban'), h(async (req, res) => {
  const { rows } = await pool.query('select telegram_user_id::text as uid, username, created_at as at from bans order by created_at desc limit 200');
  res.json({ ok: true, bans: rows });
}));

// ── Журнал: кто что сделал ──
app.get('/api/admin/log', auth, need('log'), h(async (req, res) => {
  const { rows } = await pool.query(`select id, at, actor_id::text as "actorId", actor_name as "actorName", role, action, lobby_id as "lobbyId", detail
    from audit_log order by id desc limit 60`);
  res.json({ ok: true, log: rows });
}));

// ── Персонал (только владельцы): кто админ / модератор и какие права у каждого ──
const parseHandle = v => { // '@name' | 'name' → по username, цифры → по Telegram id
  const x = String(v || '').trim().replace(/^@/, '');
  if (/^\d{3,18}$/.test(x)) return { uid: x, handle: null };
  if (/^[A-Za-z0-9_]{5,32}$/.test(x)) return { uid: null, handle: x.toLowerCase() };
  return null;
};
const cleanPerms = a => [...new Set((Array.isArray(a) ? a : []).filter(p => GRANTABLE.includes(p)))];
app.get('/api/admin/staff', auth, need('staff'), h(async (req, res) => {
  const { rows } = await pool.query("select id, uid::text as uid, handle, role, perms from staff order by (role = 'mod'), id");
  res.json({ ok: true, staff: rows, owners: OWNERS, presets: PRESET });
}));
app.post('/api/admin/staff/save', auth, need('staff'), h(async (req, res) => {
  const role = req.body.role;
  if (!['admin', 'mod'].includes(role)) return res.status(400).json({ error: 'bad_request' });
  const perms = cleanPerms(req.body.perms);
  try {
    if (req.body.id) {
      const r = await pool.query('update staff set role = $2, perms = $3 where id = $1', [Number(req.body.id), role, perms]);
      if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    } else {
      const x = parseHandle(req.body.handle);
      if (!x) return res.status(400).json({ error: 'bad_handle' });
      await pool.query('insert into staff (uid, handle, role, perms, added_by) values ($1, $2, $3, $4, $5)', [x.uid, x.handle, role, perms, req.tg.id]);
    }
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'exists' });
    throw e;
  }
  staffChanged();
  res.json({ ok: true });
}));
app.post('/api/admin/staff/remove', auth, need('staff'), h(async (req, res) => {
  await pool.query('delete from staff where id = $1', [Number(req.body.id) || 0]);
  staffChanged();
  res.json({ ok: true });
}));

// ── Напоминания о старте за 20 и 10 минут ──
async function notify(m) {
  const { rows } = await pool.query('select telegram_user_id::text as id from role_assignments where lobby_id = 1');
  const { rows: [g] } = await pool.query('select title from lobbies where id = 1');
  const text = `⏰ ${g?.title || 'Игра'}: через ${m} минут старт! Заходи в лобби.`;
  const extra = openLobby();
  for (const r of rows) if (!(await tgSend(r.id, text, extra))) console.error('notify failed for', r.id);
}
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const { rows: [l] } = await pool.query('select starts_at, notified20, notified10 from lobbies where id = 1');
    if (!l?.starts_at) return;
    const mins = (new Date(l.starts_at) - Date.now()) / 60000;
    for (const [m, col] of [[20, 'notified20'], [10, 'notified10']]) {
      if (mins > 0 && mins <= m && !l[col]) {
        // Атомарная смена флага: отправит только один процесс.
        const r = await pool.query(`update lobbies set ${col} = true where id = 1 and ${col} = false`);
        if (r.rowCount) await notify(m);
      }
    }
  } finally {
    ticking = false;
  }
}
setInterval(() => tick().catch(console.error), 15000);

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'server' });
});

const server = app.listen(Number(PORT), '0.0.0.0', () => console.log(`Server started on port ${PORT}`));
server.keepAliveTimeout = 65000; // прокси Railway держит соединения ~60 с
server.headersTimeout = 66000;

// Плавная остановка при редеплое
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => pool.end().catch(() => {}).finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
