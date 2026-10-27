import assert from 'node:assert/strict';
import { replay, validateConfig, createAchievements } from '../achievements.js';
import { ACHIEVEMENTS } from '../achievements-config.js';

assert.deepEqual(validateConfig(), [], 'конфиг должен быть валидным');
// проверка валидатора на ошибках
const bad = validateConfig([
  { code: 'A', name: 'x', desc: 'y', icon: 'z', cat: 'nope', rarity: 'meh', scope: 'forever', rule: { type: 'stat', metric: 'zzz', gte: 0 } },
  { code: 'dup', name: 'x', desc: 'y', icon: 'z', cat: 'wins', rarity: 'rare', scope: 'permanent', title: 'GHOST', rule: { type: 'stat', metric: 'roleWins', gte: 3 } },
  { code: 'dup', name: 'x', desc: 'y', icon: 'z', cat: 'wins', rarity: 'rare', scope: 'permanent', rule: { type: 'event', event: 'nope', gte: 1 } },
]);
assert.ok(bad.length >= 8, 'ошибки конфига должны находиться: ' + bad.length);

// ── helper для матчей ──
let id = 0;
const T = (day, hour = 12) => new Date(Date.UTC(2026, 9, day, hour));
const m = (o) => ({ match_id: ++id, season_id: 1, finished_at: T(1), winner: 1, mvp: null, team: 1, role: 'mid', ...o });
const codes = (r) => r.hits.map(h => h.code + (h.seasonId ? '@' + h.seasonId : ''));

// 1) Первый матч: дебютант + первая победа, дата = дата матча
let r = replay([m({ finished_at: T(3) })], '7');
assert.deepEqual(codes(r).sort(), ['debut', 'first_blood']);
assert.equal(r.hits[0].at.getTime(), T(3).getTime());

// 2) Серии побед: 10 побед подряд даёт 3/5/10; поражение рвёт, матч без победителя не рвёт
id = 0;
const rows = [];
for (let i = 0; i < 4; i++) rows.push(m({ finished_at: T(1 + i) }));
rows.push(m({ winner: null }));            // без победителя
rows.push(m({ finished_at: T(10) }));      // 5-я победа
r = replay(rows, '7');
const c1 = codes(r);
assert.ok(c1.includes('streak3') && c1.includes('streak5') && !c1.includes('streak10'));
assert.equal(r.hits.find(h => h.code === 'streak5').matchId, rows[5].match_id, 'streak5 получен на 6-м матче (5-я победа)');
rows.push(m({ winner: 2 }));               // поражение
for (let i = 0; i < 9; i++) rows.push(m());
assert.ok(!codes(replay(rows, '7')).includes('streak10'), 'после поражения серия начинается заново: 9 побед < 10');
rows.push(m());
assert.ok(codes(replay(rows, '7')).includes('streak10'));

// 3) Количество матчей
id = 0;
const many = Array.from({ length: 100 }, (_, i) => m({ winner: i % 2 ? 1 : 2, finished_at: T(1 + (i % 25)) }));
r = replay(many, '7');
for (const c of ['debut', 'regular', 'veteran', 'arena_legend']) assert.ok(codes(r).includes(c), c);
assert.equal(r.hits.find(h => h.code === 'arena_legend').matchId, many[99].match_id);

// 4) Универсал: нужны все 5 ролей
id = 0;
r = replay(['jungle', 'exp', 'mid', 'gold'].map(role => m({ role })), '7');
assert.ok(!codes(r).includes('universal'));
r = replay(['jungle', 'exp', 'mid', 'gold', 'roam'].map(role => m({ role })), '7');
assert.ok(codes(r).includes('universal'));

// 5) Роли и титулы: 10 побед на jungle
id = 0;
r = replay(Array.from({ length: 10 }, () => m({ role: 'jungle' })), '7');
assert.ok(codes(r).includes('jungle_king') && !codes(r).includes('mid_master'));

// 6) MVP: первый, пять, хет-трик; mvp другого игрока не считается
id = 0;
r = replay([m({ mvp: '8' }), m({ mvp: '7' }), m({ mvp: '7' }), m({ mvp: '7' })], '7');
assert.ok(codes(r).includes('mvp1') && codes(r).includes('mvp_hat') && !codes(r).includes('mvp5'));
r = replay([m({ mvp: '7' }), m({ mvp: '8' }), m({ mvp: '7' }), m({ mvp: '7' })], '7');
assert.ok(!codes(r).includes('mvp_hat'), 'MVP не подряд');

// 7) Сезонность: 10 MVP в сезоне 1 и 3 в сезоне 2
id = 0;
const s1 = Array.from({ length: 10 }, () => m({ season_id: 1, mvp: '7' }));
const s2 = Array.from({ length: 3 }, () => m({ season_id: 2, mvp: '7' }));
r = replay([...s1, ...s2], '7');
assert.ok(codes(r).includes('season_star@1') && !codes(r).includes('season_star@2'));
assert.ok(codes(r).includes('mvp5'), 'постоянное mvp5 считается по всем сезонам');
// 10 MVP суммарно в двух сезонах (5+5) сезонную звезду НЕ даёт
id = 0;
r = replay([...Array.from({ length: 5 }, () => m({ season_id: 1, mvp: '7' })), ...Array.from({ length: 5 }, () => m({ season_id: 2, mvp: '7' }))], '7');
assert.ok(!codes(r).some(c => c.startsWith('season_star')));
// а во втором сезоне набралось 10 — выдаётся заново
id = 0;
r = replay([...s1, ...Array.from({ length: 10 }, () => m({ season_id: 2, mvp: '7' }))], '7');
assert.ok(codes(r).includes('season_star@1') && codes(r).includes('season_star@2'));

// 8) Секретные: феникс (победа после 3 поражений) и ночь (23:00 UTC = 03:00 в Ереване)
id = 0;
r = replay([m({ winner: 2 }), m({ winner: 2 }), m({ winner: 2 }), m({ finished_at: T(5, 23) })], '7');
assert.ok(codes(r).includes('phoenix') && codes(r).includes('night_owl'));
r = replay([m({ winner: 2 }), m({ winner: 2 }), m({ winner: 1 })], '7');
assert.ok(!codes(r).includes('phoenix'), 'две поражения — не камбэк');
r = replay([m({ finished_at: T(5, 12) })], '7');
assert.ok(!codes(r).includes('night_owl'), 'днём ночной победы нет');

// ── Движок целиком с фейковой базой: защита от дублей, уведомления ──
const store = new Set(), sent = [];
const history = Array.from({ length: 10 }, (_, i) => ({ uid: '7', match_id: i + 1, season_id: 1, finished_at: T(1 + i), winner: 1, mvp: i < 1 ? '7' : null, team: 1, role: 'jungle' }));
const pool = {
  async query(sql, p) {
    if (/from match_players mp join matches m/.test(sql)) return { rows: history.filter(x => p[0].includes(x.uid)) };
    if (/from achievement_events/.test(sql)) return { rows: [] };
    if (/insert into achievements_earned/.test(sql)) {
      const [uids, cs, ss, , , src, silent] = p, rows = [];
      uids.forEach((u, i) => { const k = `${u}|${cs[i]}|${ss[i]}`; if (!store.has(k)) { store.add(k); rows.push({ uid: String(u), code: cs[i], season_id: ss[i] }); } });
      assert.equal(typeof silent, 'boolean'); assert.ok(src);
      return { rows };
    }
    return { rows: [] };
  },
};
const ach = createAchievements({ pool, season: async () => ({ id: 1, number: 42 }), tgSend: async (u, t) => sent.push([u, t]), onChange() {} });
assert.ok(ach.enabled);
let first = await ach.onMatchFinished(['7', '7', '8']);
const names = first.get('7').map(n => n.code).sort();
assert.deepEqual(names, ['debut', 'first_blood', 'jungle_king', 'mvp1', 'regular', 'streak3', 'streak5', 'streak10'].sort());
assert.ok(!first.has('8'), 'у игрока без матчей наград нет');
const txt = ach.telegramBlock(first.get('7'));
assert.ok(txt.includes('Новые достижения') && txt.includes('👑 Открыт титул: КОРОЛЬ ЛЕСА'), txt);
// повторная проверка того же состояния ничего не выдаёт
const second = await ach.onMatchFinished(['7']);
assert.equal(second.size, 0, 'повторного начисления быть не должно');
console.log('Все проверки пройдены. Достижений в конфиге:', ACHIEVEMENTS.length);
console.log(txt);
