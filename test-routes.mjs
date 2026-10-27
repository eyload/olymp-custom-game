import assert from 'node:assert/strict';
import { createAchievements } from '../achievements.js';

// Фейковая база: хранит награды/события в памяти и отвечает на запросы движка
const earned = [], events = [], users = new Map([['7', { active_title: null }], ['8', { active_title: null }]]);
const T = d => new Date(Date.UTC(2026, 9, d, 12));
const history = Array.from({ length: 10 }, (_, i) => ({ uid: '7', match_id: i + 1, season_id: 1, finished_at: T(1 + i), winner: 1, mvp: null, team: 1, role: 'jungle' }));
const pool = {
  async query(sql, p) {
    if (/from match_players mp join matches m/.test(sql)) return { rows: history.filter(x => p[0].includes(x.uid)) };
    if (/from achievement_events/.test(sql)) {
      const by = {}; for (const e of events) if (p[0].includes(e.uid)) (by[e.uid + '|' + e.event] ||= { uid: e.uid, event: e.event, ats: [] }).ats.push(e.at);
      return { rows: Object.values(by) };
    }
    if (/insert into achievement_events/.test(sql)) {
      const [uids, evs, ref] = p;
      for (const u of uids) for (const e of evs) if (!events.some(x => x.uid === String(u) && x.event === e && x.ref === ref)) events.push({ uid: String(u), event: e, ref, at: new Date() });
      return { rows: [] };
    }
    if (/insert into achievements_earned/.test(sql)) {
      const [uids, cs, ss, ats, , src, silent] = p, rows = [];
      uids.forEach((u, i) => { if (!earned.some(e => e.uid === String(u) && e.code === cs[i] && e.season_id === ss[i])) { earned.push({ uid: String(u), code: cs[i], season_id: ss[i], earned_at: ats[i], seen: silent, source: src }); rows.push({ uid: String(u), code: cs[i], season_id: ss[i] }); } });
      return { rows };
    }
    if (/from achievements_earned e left join seasons/.test(sql)) return { rows: earned.filter(e => e.uid === String(p[0])).map(e => ({ ...e, season_number: e.season_id ? 42 : null })) };
    if (/select active_title from users/.test(sql)) return { rows: [users.get(String(p[0]))].filter(Boolean) };
    if (/update users set active_title/.test(sql)) { const u = users.get(String(p[0])); if (u) u.active_title = p[1]; return { rows: [], rowCount: u ? 1 : 0 }; }
    if (/update achievements_earned set seen = true/.test(sql)) { for (const e of earned) if (e.uid === String(p[0]) && p[1].includes(e.code + ':' + e.season_id)) e.seen = true; return { rows: [] }; }
    if (/select telegram_user_id::text as uid from users where/.test(sql)) return { rows: p[0].filter(u => users.has(u)).map(uid => ({ uid })) };
    if (/select 1 as x from users where telegram_user_id/.test(sql)) return { rows: users.has(String(p[0])) ? [{ x: 1 }] : [] };
    return { rows: [], rowCount: 0 };
  },
};
const routes = {}, sent = [];
const app = { get: (path, ...f) => routes['GET ' + path] = f.at(-1), post: (path, ...f) => routes['POST ' + path] = f.at(-1) };
const pass = (req, res, next) => next();
const a = createAchievements({ pool, season: async () => ({ id: 1, number: 42 }), tgSend: async (u, t) => sent.push([u, t]), auth: pass, need: () => pass, h: fn => (req, res) => fn(req, res).catch(e => { throw e; }), app, onChange() {} });
a.mount();
const call = async (route, tg, body = {}) => {
  let out = { status: 200 }; const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; return this; } };
  await routes[route]({ tg: { id: Number(tg) }, body }, res); return out;
};

await a.onMatchFinished(['7']);          // игрок 7: 10 побед на jungle → титул открыт
// 1. титул нельзя выбрать, пока не открыт
let r = await call('POST /api/title', '8', { code: 'JUNGLE_KING' });
assert.equal(r.status, 403);
r = await call('POST /api/title', '7', { code: 'NOPE' });
assert.equal(r.status, 400);
r = await call('POST /api/title', '7', { code: 'MID_MASTER' });
assert.equal(r.status, 403, 'титул мида ещё закрыт');
// 2. выбрать открытый, снять
r = await call('POST /api/title', '7', { code: 'JUNGLE_KING' });
assert.equal(r.status, 200); assert.equal(r.body.activeName, 'КОРОЛЬ ЛЕСА');
r = await call('GET /api/achievements', '7');
assert.equal(r.body.active, 'JUNGLE_KING');
assert.ok(r.body.unseen.length >= 5, 'новые награды ждут показа');
const jk = r.body.items.find(x => x.code === 'jungle_king'); assert.ok(jk.earned && jk.at);
const secret = r.body.items.filter(x => x.secret && x.hidden); assert.equal(secret.length, 3, 'три секретных скрыты');
assert.ok(secret.every(x => x.name === '???' && !x.code), 'код секретных не утекает');
const prog = r.body.items.find(x => x.code === 'mid_master'); assert.deepEqual(prog.progress, { cur: 0, goal: 10 });
assert.deepEqual(r.body.items.find(x => x.code === 'universal').progress, { cur: 1, goal: 5 }, 'прогресс считается по истории матчей (числовой Telegram id)');
// 3. отметка «показано»
await call('POST /api/achievements/seen', '7', { keys: r.body.unseen.map(x => x.k) });
r = await call('GET /api/achievements', '7'); assert.equal(r.body.unseen.length, 0);
r = await call('POST /api/title', '7', { code: null }); assert.equal(r.body.active, null);
// 4. админ: турнирное событие, повтор с тем же ref не дублирует
r = await call('POST /api/admin/achievements/event', '1', { event: 'tournament_win', ref: 'OLYMP Cup #1', uids: ['7', '8', '999'] });
assert.equal(r.status, 200); assert.deepEqual(r.body.missing, ['999']);
const got = id => earned.filter(e => e.uid === id && /^tournament/.test(e.code)).map(e => e.code).sort();
assert.deepEqual(got('7'), ['tournament_champion', 'tournament_debut', 'tournament_finalist'], 'победа подразумевает финал и участие');
assert.deepEqual(got('8'), ['tournament_champion', 'tournament_debut', 'tournament_finalist']);
const n = earned.length;
r = await call('POST /api/admin/achievements/event', '1', { event: 'tournament_win', ref: 'OLYMP Cup #1', uids: ['7'] });
assert.equal(earned.length, n, 'тот же турнир второй раз не засчитывается');
r = await call('POST /api/admin/achievements/event', '1', { event: 'tournament_win', uids: ['7'] });
assert.equal(r.status, 400, 'без ref нельзя');
r = await call('POST /api/admin/achievements/event', '1', { event: 'bogus', ref: 'x', uids: ['7'] });
assert.equal(r.status, 400);
// 5. ручная выдача секретного; повтор не дублирует
r = await call('POST /api/admin/achievements/grant', '1', { uid: '8', code: 'phoenix' }); assert.equal(r.body.granted, true);
r = await call('POST /api/admin/achievements/grant', '1', { uid: '8', code: 'phoenix' }); assert.equal(r.body.granted, false);
r = await call('POST /api/admin/achievements/grant', '1', { uid: '8', code: 'nope' }); assert.equal(r.status, 400);
// 6. после выдачи секретное открывается в каталоге
r = await call('GET /api/achievements', '8');
assert.equal(r.body.items.find(x => x.code === 'phoenix').name, 'Феникс');
await new Promise(r => setTimeout(r, 20));
assert.ok(sent.some(([u, t]) => u === '8' && t.includes('Феникс')), 'игрок получил сообщение в Telegram');
console.log('Маршруты и админ-API: все проверки пройдены, сообщений в Telegram:', sent.length);
