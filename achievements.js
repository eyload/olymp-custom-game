// ════════════════════════════════════════════════════════════════════════
//  OLYMP CUSTOM — движок достижений и титулов
//  Все названия и пороги живут в achievements-config.js, здесь только логика.
//
//  Как это работает:
//   • Достижения считаются из истории матчей (matches / match_players) «проигрыванием»
//     истории игрока по порядку. Поэтому дата получения — это дата матча, на котором
//     условие впервые выполнилось, а повторная проверка ничего не ломает.
//   • Награды лежат в отдельной таблице achievements_earned с первичным ключом
//     (игрок, достижение, сезон). Дубль физически невозможен: insert … on conflict do nothing.
//   • Сезонный рейтинг обнуляется новой строкой в seasons; таблица наград его не касается,
//     поэтому награды сохраняются. Сезонные достижения привязаны к сезону и выдаются заново.
//   • Титулы не хранятся отдельно: игрок владеет титулом, если получил достижение с полем title.
//     Активный титул — одно поле users.active_title.
// ════════════════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto';
import { ACHIEVEMENTS, TITLES, RARITY, CATEGORIES, EVENTS, TZ_OFFSET_H, NIGHT_FROM, NIGHT_TO } from './achievements-config.js';

export const ACHV_SCHEMA = `
  create table if not exists achievements_earned (
    uid bigint not null,
    code text not null,
    season_id int not null default 0,
    earned_at timestamptz not null default now(),
    match_id int,
    source text not null default 'auto',
    seen boolean not null default false,
    primary key (uid, code, season_id));
  create index if not exists idx_achv_unseen on achievements_earned (uid) where not seen;
  create table if not exists achievement_events (
    uid bigint not null,
    event text not null,
    ref text not null default '',
    season_id int,
    at timestamptz not null default now(),
    by_id bigint,
    primary key (uid, event, ref));
  alter table users add column if not exists active_title text;
`;

const ROLES = ['jungle', 'exp', 'mid', 'gold', 'roam'];
const SCOPES = ['permanent', 'season'];
const RULE_TYPES = ['stat', 'event', 'season_end', 'manual'];

// ── Метрики: как из счётчиков получить число. Новое условие = новая строка здесь + порог в конфиге ──
const METRICS = {
  games:        c => c.games,
  wins:         c => c.wins,
  losses:       c => c.losses,
  winStreak:    c => c.bestWin,
  mvp:          c => c.mvp,
  mvpStreak:    c => c.bestMvp,
  roles:        c => c.roles.size,
  roleWins:     (c, r) => c.roleWins[r.role] || 0,
  roleGames:    (c, r) => c.roleGames[r.role] || 0,
  comebackWins: c => c.comeback,
  nightWins:    c => c.night,
};

// Проверка конфига при старте: опечатка в пороге не должна тихо ломать выдачу наград.
export function validateConfig(defs = ACHIEVEMENTS, titles = TITLES) {
  const errs = [], seen = new Set();
  for (const d of defs) {
    const at = `«${d.code}»`;
    if (!d.code || !/^[a-z0-9_]+$/.test(d.code)) errs.push(`${at}: code только из a-z, 0-9, _`);
    if (seen.has(d.code)) errs.push(`${at}: код повторяется`);
    seen.add(d.code);
    if (!d.name || !d.desc || !d.icon) errs.push(`${at}: нужны name, desc, icon`);
    if (!CATEGORIES[d.cat]) errs.push(`${at}: неизвестная категория ${d.cat}`);
    if (!RARITY[d.rarity]) errs.push(`${at}: неизвестная редкость ${d.rarity}`);
    if (!SCOPES.includes(d.scope)) errs.push(`${at}: scope должен быть permanent или season`);
    if (d.title && !titles[d.title]) errs.push(`${at}: титул ${d.title} не описан в TITLES`);
    const r = d.rule;
    if (!r || !RULE_TYPES.includes(r.type)) { errs.push(`${at}: неизвестный тип условия`); continue; }
    if (r.type === 'stat') {
      if (!METRICS[r.metric]) errs.push(`${at}: неизвестная метрика ${r.metric}`);
      if (!(r.gte > 0)) errs.push(`${at}: gte должен быть больше нуля`);
      if (/^role(Wins|Games)$/.test(r.metric) && !ROLES.includes(r.role)) errs.push(`${at}: для ${r.metric} нужен role из ${ROLES.join('/')}`);
    }
    if (r.type === 'event') {
      if (!EVENTS[r.event]) errs.push(`${at}: событие ${r.event} не описано в EVENTS`);
      if (!(r.gte >= 1)) errs.push(`${at}: gte должен быть не меньше 1`);
      if (d.scope !== 'permanent') errs.push(`${at}: достижения по событиям бывают только permanent`);
    }
    if (r.type === 'season_end') {
      if (!(Number.isInteger(r.maxRank) && r.maxRank >= 1)) errs.push(`${at}: maxRank — целое число от 1`);
      if (d.scope !== 'season') errs.push(`${at}: season_end требует scope: 'season'`);
    }
  }
  for (const [k, e] of Object.entries(EVENTS)) for (const i of e.implies || []) if (!EVENTS[i]) errs.push(`событие ${k}: implies ссылается на ${i}`);
  return errs;
}

// ── Проигрывание истории игрока ──
const blank = () => ({ games: 0, wins: 0, losses: 0, run: 0, bestWin: 0, lose: 0, mvp: 0, mvpRun: 0, bestMvp: 0, roles: new Set(), roleWins: {}, roleGames: {}, comeback: 0, night: 0 });
function step(c, x) {
  c.games++;
  if (ROLES.includes(x.role)) { c.roles.add(x.role); c.roleGames[x.role] = (c.roleGames[x.role] || 0) + 1; }
  if (x.won) {
    if (c.lose >= 3) c.comeback++;               // победа после ≥3 поражений подряд
    c.wins++; c.run++; c.lose = 0; c.bestWin = Math.max(c.bestWin, c.run);
    c.roleWins[x.role] = (c.roleWins[x.role] || 0) + 1;
    if (x.night) c.night++;
  } else if (x.lost) { c.losses++; c.lose++; c.run = 0; }
  // матч без победителя серии побед и поражений не рвёт
  if (x.mvp) { c.mvp++; c.mvpRun++; c.bestMvp = Math.max(c.bestMvp, c.mvpRun); } else c.mvpRun = 0;
}
const isNight = at => { const h = (new Date(at).getUTCHours() + TZ_OFFSET_H + 24) % 24; return h >= NIGHT_FROM && h < NIGHT_TO; };
const metric = (c, rule) => METRICS[rule.metric](c, rule);

// rows — матчи одного игрока по возрастанию id. Возвращает полученные награды и итоговые счётчики.
export function replay(rows, uid, defs = ACHIEVEMENTS) {
  const perm = blank(), bySeason = new Map(), hits = [], done = new Set();
  const stat = defs.filter(d => d.rule.type === 'stat');
  for (const r of rows) {
    const sid = r.season_id || 0;
    const x = { role: r.role, won: r.winner != null && r.winner === r.team, lost: r.winner != null && r.winner !== r.team, mvp: r.mvp != null && String(r.mvp) === String(uid), night: isNight(r.finished_at) };
    step(perm, x);
    let sc = null;
    if (sid) { sc = bySeason.get(sid) || bySeason.set(sid, blank()).get(sid); step(sc, x); }
    for (const d of stat) {
      const c = d.scope === 'season' ? sc : perm;
      if (!c) continue;
      const key = d.code + '|' + (d.scope === 'season' ? sid : 0);
      if (done.has(key) || metric(c, d.rule) < d.rule.gte) continue;
      done.add(key);
      hits.push({ code: d.code, seasonId: d.scope === 'season' ? sid : 0, at: r.finished_at, matchId: r.match_id });
    }
  }
  return { hits, perm, bySeason };
}

const key = (code, sid) => code + '|' + sid;

export function createAchievements({ pool, season, tgSend, openApp = () => ({}), auth, need, h, app, onChange = () => {} }) {
  const defs = ACHIEVEMENTS, byCode = new Map(defs.map(d => [d.code, d]));
  const problems = validateConfig();
  const enabled = problems.length === 0;
  if (!enabled) console.error('[achv] конфиг достижений с ошибками, система отключена:\n  - ' + problems.join('\n  - '));
  const cfgHash = createHash('sha1').update(JSON.stringify([defs.map(d => [d.code, d.scope, d.rule, d.title || null]), EVENTS])).digest('hex').slice(0, 12);
  const titleName = code => (code && TITLES[code]?.name) || null;
  const eventsFor = ev => [ev, ...(EVENTS[ev]?.implies || [])];

  // ── Запись наград: один атомарный insert, возвращает только действительно новые ──
  async function insertEarned(entries, { silent = false, source = 'auto' } = {}) {
    const fresh = [];
    for (let i = 0; i < entries.length; i += 500) {
      const part = entries.slice(i, i + 500);
      const { rows } = await pool.query(
        `insert into achievements_earned (uid, code, season_id, earned_at, match_id, source, seen)
         select t.uid, t.code, t.season_id, t.at, t.match_id, $6::text, $7::boolean
         from unnest($1::bigint[], $2::text[], $3::int[], $4::timestamptz[], $5::int[]) as t(uid, code, season_id, at, match_id)
         on conflict (uid, code, season_id) do nothing
         returning uid::text as uid, code, season_id`,
        [part.map(e => e.uid), part.map(e => e.code), part.map(e => e.seasonId || 0), part.map(e => new Date(e.at || Date.now()).toISOString()), part.map(e => e.matchId ?? null), source, silent]);
      fresh.push(...rows.map(r => ({ uid: r.uid, code: r.code, seasonId: r.season_id })));
    }
    return fresh;
  }

  async function loadHistory(list) {
    const ids = list.map(String);
    const { rows } = await pool.query(
      `select mp.uid::text as uid, m.id as match_id, m.season_id, m.finished_at, m.winner, m.mvp_uid::text as mvp, mp.team, mp.role
       from match_players mp join matches m on m.id = mp.match_id where mp.uid = any($1::bigint[]) order by m.id`, [ids]);
    const by = new Map(ids.map(i => [i, []]));
    for (const r of rows) by.get(r.uid)?.push(r);
    return by;
  }
  async function loadEvents(list) {
    const ids = list.map(String);
    const { rows } = await pool.query(
      `select uid::text as uid, event, array_agg(at order by at) as ats from achievement_events where uid = any($1::bigint[]) group by 1, 2`, [ids]);
    const by = new Map(ids.map(i => [i, new Map()]));
    for (const r of rows) by.get(r.uid)?.set(r.event, r.ats);
    return by;
  }

  // Проверка списка игроков: достаёт всё, что они уже заслужили, и записывает новое.
  // Возвращает Map<uid, [{code, seasonId}]> только с НОВЫМИ наградами.
  async function evaluateUsers(uids, { silent = false } = {}) {
    const out = new Map();
    if (!enabled) return out;
    const ids = [...new Set(uids.map(String))].filter(u => /^\d{1,18}$/.test(u));
    if (!ids.length) return out;
    const [hist, evs] = await Promise.all([loadHistory(ids), loadEvents(ids)]);
    const entries = [];
    for (const uid of ids) {
      for (const hit of replay(hist.get(uid), uid, defs).hits) entries.push({ uid, ...hit });
      for (const d of defs) {
        if (d.rule.type !== 'event') continue;
        const ats = evs.get(uid).get(d.rule.event);
        if (ats && ats.length >= d.rule.gte) entries.push({ uid, code: d.code, seasonId: 0, at: ats[d.rule.gte - 1] });
      }
    }
    for (const n of await insertEarned(entries, { silent })) (out.get(n.uid) || out.set(n.uid, []).get(n.uid)).push(n);
    return out;
  }

  // ── Тексты уведомлений ──
  const defOf = n => byCode.get(n.code);
  function telegramBlock(newly) {
    const list = (newly || []).map(defOf).filter(Boolean);
    if (!list.length) return '';
    const titles = list.filter(d => d.title).map(d => `👑 Открыт титул: ${TITLES[d.title].name}`);
    return `\n\n🏆 ${list.length > 1 ? 'Новые достижения' : 'Новое достижение'}:\n${list.map(d => `${d.icon} ${d.name} — ${d.desc}`).join('\n')}` + (titles.length ? `\n${titles.join('\n')}\nВыбери его в профиле.` : '');
  }
  // Отдельные сообщения (турнирные события, ручная выдача, итоги сезона): в фоне, по одному игроку
  function notifyMap(map) {
    if (!map?.size) return;
    (async () => { const extra = openApp(); for (const [uid, list] of map) await tgSend(uid, telegramBlock(list).trim(), extra); })().catch(e => console.error('[achv] notify', e));
  }

  // ── После матча: вызывается из завершения матча, ошибки не должны ломать сохранение матча ──
  async function onMatchFinished(uids) {
    try { return await evaluateUsers(uids); } catch (e) { console.error('[achv] onMatchFinished', e); return new Map(); }
  }

  // ── Итоги сезонов: награды по месту в рейтинге. Идемпотентно. ──
  async function finalizeSeasons({ silent = false } = {}) {
    if (!enabled) return;
    const endDefs = defs.filter(d => d.rule.type === 'season_end');
    if (!endDefs.length) return;
    const maxRank = Math.max(...endDefs.map(d => d.rule.maxRank));
    const { rows: ended } = await pool.query(
      `select s.id, s.ends_at from seasons s where s.ends_at <= now() and not exists (select 1 from app_migrations a where a.k = 'achv_season:' || s.id::text) order by s.id`);
    for (const s of ended) {
      const { rows } = await pool.query(
        `select uid, r::int as r from (select telegram_user_id::text as uid, rank() over (order by rating desc, mvp_count desc) as r
           from season_scores where season_id = $1 and rating > 0) t where r <= $2`, [s.id, maxRank]);
      const entries = [];
      for (const row of rows) for (const d of endDefs) if (row.r <= d.rule.maxRank) entries.push({ uid: row.uid, code: d.code, seasonId: s.id, at: s.ends_at });
      const fresh = await insertEarned(entries, { silent });
      if (!silent) { const m = new Map(); for (const n of fresh) (m.get(n.uid) || m.set(n.uid, []).get(n.uid)).push(n); notifyMap(m); }
      await pool.query('insert into app_migrations (k) values ($1) on conflict do nothing', ['achv_season:' + s.id]); // метка после наград: если упали посередине, повтор безопасен
      if (fresh.length) onChange();
    }
  }

  // ── Старт: ретро-выдача по истории (тихо), когда менялся конфиг, затем итоги прошлых сезонов ──
  async function backfill() {
    const mk = 'achv_cfg:' + cfgHash;
    const { rows: [done] } = await pool.query('select 1 as x from app_migrations where k = $1', [mk]);
    if (done) return;
    const { rows } = await pool.query('select uid::text as uid from (select uid from match_players union select uid from achievement_events) t group by uid');
    const all = rows.map(r => r.uid);
    for (let i = 0; i < all.length; i += 200) await evaluateUsers(all.slice(i, i + 200), { silent: true });
    await finalizeSeasons({ silent: true });
    await pool.query('insert into app_migrations (k) values ($1) on conflict do nothing', [mk]);
    console.log(`[achv] ретро-проверка выполнена: игроков ${all.length}`);
  }
  function init() {
    if (!enabled) return;
    backfill().catch(e => console.error('[achv] backfill', e))
      .then(() => finalizeSeasons()).catch(e => console.error('[achv] finalize', e));
    setInterval(() => finalizeSeasons().catch(e => console.error('[achv] finalize', e)), 10 * 60 * 1000).unref();
  }

  // ── Данные для клиента ──
  const view = (d, extra = {}) => ({ code: d.code, name: d.name, desc: d.desc, icon: d.icon, cat: d.cat, rarity: d.rarity, rl: RARITY[d.rarity].label, color: RARITY[d.rarity].color, scope: d.scope, secret: !!d.secret, title: d.title ? { code: d.title, name: TITLES[d.title].name } : null, ...extra });
  async function loadEarned(uid) {
    const { rows } = await pool.query(
      `select e.code, e.season_id, e.earned_at, e.seen, s.number as season_number from achievements_earned e left join seasons s on s.id = e.season_id where e.uid = $1 order by e.earned_at desc`, [uid]);
    return rows.filter(r => byCode.has(r.code));
  }
  const rarityRank = Object.keys(RARITY);

  // Ещё не показанные игроку награды, старые первыми; k — ключ для отметки «показано»
  const unseenOf = rows => rows.filter(r => !r.seen).map(r => { const d = byCode.get(r.code); return { ...view(d), k: r.code + ':' + r.season_id, season: d.scope === 'season' ? r.season_number : null }; }).reverse();

  // Короткая сводка для профиля (своего или чужого)
  async function summary(uid, own) {
    if (!enabled) return null;
    const rows = await loadEarned(uid), seenCodes = new Set(), list = [];
    for (const r of rows) {
      const d = byCode.get(r.code);
      if (seenCodes.has(r.code)) { const it = list.find(x => x.code === r.code); it.times++; continue; }
      seenCodes.add(r.code);
      list.push({ ...view(d), at: r.earned_at, season: d.scope === 'season' ? r.season_number : null, times: 1 });
    }
    list.sort((a, b) => rarityRank.indexOf(b.rarity) - rarityRank.indexOf(a.rarity) || new Date(b.at) - new Date(a.at));
    return { earned: seenCodes.size, total: defs.length, list, cats: CATEGORIES, ...(own && { unseen: unseenOf(rows) }) };
  }

  // Полный каталог со своим прогрессом
  async function catalog(uid) {
    const s = await season(), id = String(uid);
    const [hist, evs, rows] = await Promise.all([loadHistory([id]), loadEvents([id]), loadEarned(id)]);
    const { perm, bySeason } = replay(hist.get(id), id, defs), cur = bySeason.get(s.id) || blank(), ev = evs.get(id);
    const got = new Map(), times = new Map();
    for (const r of rows) { got.set(key(r.code, r.season_id), r); times.set(r.code, (times.get(r.code) || 0) + 1); }
    const items = defs.map(d => {
      const e = got.get(key(d.code, d.scope === 'season' ? s.id : 0));
      const anyTime = times.get(d.code) > 0;
      if (d.secret && !anyTime) return { secret: true, hidden: true, name: '???', desc: 'Секретное достижение. Условие откроется после получения.', icon: '❓', cat: d.cat, rarity: d.rarity, rl: RARITY[d.rarity].label, color: RARITY[d.rarity].color, scope: d.scope, earned: false };
      let progress = null;
      if (d.rule.type === 'stat') progress = { cur: Math.min(metric(d.scope === 'season' ? cur : perm, d.rule), d.rule.gte), goal: d.rule.gte };
      else if (d.rule.type === 'event') progress = { cur: Math.min(ev.get(d.rule.event)?.length || 0, d.rule.gte), goal: d.rule.gte };
      return { ...view(d), earned: !!e, at: e?.earned_at || null, times: times.get(d.code) || 0, progress: e ? null : progress };
    });
    const earnedCodes = new Set(rows.map(r => r.code));
    const titles = Object.entries(TITLES).map(([code, t]) => {
      const from = defs.filter(d => d.title === code);
      const row = rows.find(r => from.some(d => d.code === r.code));
      return { code, name: t.name, icon: t.icon, rarity: t.rarity, color: RARITY[t.rarity].color, unlocked: !!row, at: row?.earned_at || null, from: from.map(d => d.name).join(', ') };
    });
    const { rows: [u] } = await pool.query('select active_title from users where telegram_user_id = $1', [uid]);
    return { season: { id: s.id, number: s.number }, items, titles, active: titles.find(t => t.code === u?.active_title && t.unlocked)?.code || null,
      cats: CATEGORIES, earned: earnedCodes.size, total: defs.length, unseen: unseenOf(rows) };
  }

  async function unlockedTitles(uid) {
    const codes = new Set((await loadEarned(uid)).map(r => r.code));
    return new Set(defs.filter(d => d.title && codes.has(d.code)).map(d => d.title));
  }

  // ── Маршруты ──
  function mount() {
    if (!enabled) return;
    const off = res => res.status(503).json({ error: 'Достижения временно отключены' });
    app.get('/api/achievements', auth, h(async (req, res) => res.json({ ok: true, ...(await catalog(req.tg.id)) })));

    app.post('/api/achievements/seen', auth, h(async (req, res) => {
      const keys = Array.isArray(req.body.keys) ? req.body.keys.map(String).filter(k => /^[a-z0-9_]+:\d+$/.test(k)).slice(0, 100) : [];
      if (keys.length) await pool.query(`update achievements_earned set seen = true where uid = $1 and (code || ':' || season_id::text) = any($2::text[])`, [req.tg.id, keys]);
      res.json({ ok: true });
    }));

    // Выбор активного титула: code = null снимает титул
    app.post('/api/title', auth, h(async (req, res) => {
      const code = req.body.code == null || req.body.code === '' ? null : String(req.body.code);
      if (code && !TITLES[code]) return res.status(400).json({ error: 'Такого титула нет' });
      if (code && !(await unlockedTitles(req.tg.id)).has(code)) return res.status(403).json({ error: 'Этот титул ещё не открыт' });
      const r = await pool.query('update users set active_title = $2 where telegram_user_id = $1', [req.tg.id, code]);
      if (!r.rowCount) return res.status(404).json({ error: 'Сначала открой профиль и привяжи аккаунт' });
      onChange();
      res.json({ ok: true, active: code, activeName: titleName(code) });
    }));

    // Админ: событие (турнир, команда). Один и тот же ref не засчитывается дважды.
    app.post('/api/admin/achievements/event', auth, need('award'), h(async (req, res) => {
      const event = String(req.body.event || ''), ref = String(req.body.ref || '').trim().slice(0, 60);
      const uids = [...new Set((Array.isArray(req.body.uids) ? req.body.uids : [req.body.uid]).filter(x => x != null).map(String))].slice(0, 50);
      if (!EVENTS[event]) return res.status(400).json({ error: `Событие неизвестно. Доступны: ${Object.keys(EVENTS).join(', ')}` });
      if (!ref) return res.status(400).json({ error: 'Нужен ref: название или номер турнира, чтобы не засчитать дважды' });
      if (!uids.length || uids.some(u => !/^\d{1,18}$/.test(u))) return res.status(400).json({ error: 'Нужны Telegram id игроков (uid или uids)' });
      const { rows: known } = await pool.query('select telegram_user_id::text as uid from users where telegram_user_id = any($1::bigint[])', [uids]);
      const ok = known.map(r => r.uid), missing = uids.filter(u => !ok.includes(u));
      if (ok.length) {
        const s = await season(), evs = eventsFor(event);
        await pool.query(
          `insert into achievement_events (uid, event, ref, season_id, by_id)
           select u, e, $3, $4, $5 from unnest($1::bigint[]) as u cross join unnest($2::text[]) as e on conflict do nothing`, [ok, evs, ref, s.id, req.tg.id]);
      }
      const earned = await evaluateUsers(ok);
      notifyMap(earned);
      res.json({ ok: true, missing, earned: [...earned].map(([uid, l]) => ({ uid, codes: l.map(n => n.code) })) });
    }));

    // Админ: выдать конкретное достижение вручную (в том числе секретное или type: 'manual')
    app.post('/api/admin/achievements/grant', auth, need('award'), h(async (req, res) => {
      const uid = String(req.body.uid || ''), d = byCode.get(String(req.body.code || ''));
      if (!/^\d{1,18}$/.test(uid) || !d) return res.status(400).json({ error: 'Нужны uid и существующий code достижения' });
      const { rows: [u] } = await pool.query('select 1 as x from users where telegram_user_id = $1', [uid]);
      if (!u) return res.status(404).json({ error: 'Игрок не найден' });
      const s = await season();
      const fresh = await insertEarned([{ uid, code: d.code, seasonId: d.scope === 'season' ? s.id : 0, at: new Date() }], { source: 'manual' });
      if (fresh.length) { notifyMap(new Map([[uid, fresh]])); onChange(); }
      res.json({ ok: true, granted: fresh.length > 0 });
    }));
  }

  return { init, mount, evaluateUsers, onMatchFinished, telegramBlock, finalizeSeasons, summary, catalog, titleName, enabled };
}
