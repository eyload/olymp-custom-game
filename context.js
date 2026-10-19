// Умная подача контекста для OLYMP AI: вместо всего тир-листа в запрос идут только
// карточки упомянутых героев, мета-статистика по ним, топ-10 кандидатов для роли и короткие правила приложения.
// Модуль чистый (кроме loadCards): данные передаются параметрами, поэтому проверяется офлайн.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT, SNAPSHOT_HEROES, BUILDS, ITEMS } from '../meta-data.js';
import { validateAll, normName } from './heroes-schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Другие написания имён (не игровые данные). Нужны, потому что игрок пишет «Попол», а в мете «Пополь и Купа».
const NAME_EXTRA = { 'Пополь и Купа': ['Попол', 'Пополь', 'Popol', 'Kupa', 'Купа'] };
const TIERS = 'SABCD';

// ── Карточки: читаем heroes.json, берём только status=ready без ошибок формата. Кэш до перезапуска или reloadCards() ──
let cardsCache = null;
export function loadCards(file = path.join(HERE, 'heroes.json')) {
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('[ai] heroes.json не прочитан:', e.code || e.name); }
  const bad = new Set(validateAll(raw).map(x => x.hero));
  const cards = (Array.isArray(raw) ? raw : []).filter(c => c?.status === 'ready' && !bad.has(c.hero));
  if (bad.size) console.error('[ai] карточки с ошибками формата пропущены:', bad.size);
  return { cards, skipped: bad.size };
}
export const reloadCards = () => (cardsCache = loadCards());
const cachedCards = () => (cardsCache ??= loadCards());

// ── Поиск героев в тексте ──
// exact: ключ (имя без пробелов и знаков, нижний регистр) → каноническое русское имя;
// stems: основа для падежей («Хуфру», «Хуфры»): имя без последней буквы, только имена от 5 букв.
export function buildIndex(heroes, cards = []) {
  const exact = new Map(), stems = [];
  const add = (k, name) => { const n = normName(k); if (n && !exact.has(n)) exact.set(n, name); };
  for (const h of heroes) {
    add(h.name, h.name); if (h.en) add(h.en, h.name);
    for (const a of NAME_EXTRA[h.name] || []) add(a, h.name);
  }
  for (const c of cards) for (const a of c.aliases || []) if ([...exact.values()].includes(c.hero)) add(a, c.hero);
  for (const [k, name] of exact) if (k.length >= 5) stems.push([k.slice(0, -1), name, k.length]);
  return { exact, stems };
}
const words = t => String(t || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
// Герои, упомянутые в текстах (строка или массив строк). Имена из нескольких слов («Yu Zhong») ищутся по 1–3 словам подряд.
export function findHeroes(texts, idx) {
  const found = new Set();
  for (const t of [].concat(texts)) {
    const w = words(t);
    for (let i = 0; i < w.length; i++) for (let n = 1; n <= 3 && i + n <= w.length; n++) {
      const key = w.slice(i, i + n).join(''), hit = idx.exact.get(key);
      if (hit) { found.add(hit); continue; }
      if (n === 1) for (const [stem, name, len] of idx.stems) if (key.startsWith(stem) && key.length <= len + 2) found.add(name);
    }
  }
  return [...found];
}

// ── Форматирование ──
const num = v => v == null ? null : v;
function metaLine(name, byName) {
  const h = byName.get(name);
  if (!h) return `${name}: в мета-статистике нет`;
  return `${name}: тир ${h.tier || '?'}, винрейт ${h.wr}%${num(h.pick) != null ? `, пик ${h.pick}%` : ''}${num(h.ban) != null ? `, бан ${h.ban}%` : ''}`;
}
function cardLine(c, snapPatch) {
  const stale = snapPatch && c.patch !== snapPatch ? ` ВНИМАНИЕ: патч карточки отличается от патча среза ${snapPatch}` : '';
  return `${c.hero} [карточка, патч ${c.patch}, проверено ${c.checked}]${stale}: роли ${c.lanes.join('/')}; урон ${c.damage}; контроль ${c.cc}; ` +
    `сила early ${c.power.early}/5, late ${c.power.late}/5; сильные стороны: ${c.strong.join('; ')}; слабые стороны: ${c.weak.join('; ')}; ` +
    `контрпики: ${c.counters.join(', ')}; синергия: ${c.synergy.join(', ')}`;
}

// ── Кандидаты для роли: герои, у которых роль известна (карточка или сборка), без занятых и забаненных, лучшие по мете ──
export function candidates(role, heroes, cards, exclude = new Set(), builds = BUILDS, limit = 10) {
  const r = String(role || '').toLowerCase(), pool = new Map(), byName = new Map(heroes.map(h => [h.name, h]));
  const put = (name, src) => { if (!exclude.has(name)) (pool.get(name) || pool.set(name, new Set()).get(name)).add(src); };
  for (const c of cards) if (c.lanes.some(l => l.toLowerCase() === r)) put(c.hero, 'карточка');
  for (const b of builds) if (String(b.lane).toLowerCase() === r) put(b.hero, 'сборка');
  const rank = h => (h ? TIERS.indexOf(h.tier) : 9) * 1000 - (h?.wr || 0);
  const list = [...pool].map(([name, src]) => ({ name, src: [...src].join('+'), h: byName.get(name) })).sort((a, b) => rank(a.h) - rank(b.h));
  return { total: list.length, top: list.slice(0, limit) };
}

export const appRules = (mvpRp, seasonDays = 90) => `ПРАВИЛА ПРИЛОЖЕНИЯ OLYMP CUSTOM:
— Лобби: 10 мест, две команды по 5 (Jungle, EXP, Mid, Gold, Roam). Занять роль можно после привязки аккаунта MLBB (ID и Zone ID) и подтверждения кодом из игровой почты. За 20 и 10 минут до старта приходят напоминания, нужно нажать «Я на месте».
— Рейтинг: за MVP матча даётся ${mvpRp} очков (RP) рейтинга сезона; сезон длится ${seasonDays} дн., потом рейтинг начинается с нуля.
— Репутация: после матча 48 часов можно поставить игрокам плюс или минус, оценки анонимны, видны только общий процент и число оценок.`;

// ── Сборка контекста ──
// mode: 'draft' | 'chat'; role: роль игрока (для кандидатов); texts: вопрос и введённые герои; exclude: занятые и забаненные имена;
// meta: { heroes, live } — живая мета или срез. Возвращает текст для system-промпта и сводку для логов/тестов (без текстов диалога).
// Сборки показываются только для упомянутых героев (до 2 на героя), базовые предметы: для роли драфта или для всех ролей в чате.
const buildLines = (name, builds) => (builds.find(b => b.hero === name)?.builds || []).slice(0, 2)
  .map(x => `  сборка «${x.name}»: ${x.items.join(' > ')}; ${x.emblem}; заклинание ${x.spell}`).join('\n');
function itemsBlock(items, role) {
  const rs = (items?.roles || []).filter(r => !role || r.role === String(role).toLowerCase());
  return rs.length ? `БАЗОВЫЕ ПРЕДМЕТЫ ПО РОЛЯМ (${items.src?.name}, ${items.src?.note}):\n` + rs.map(r => `${r.name}: ${r.core}. ${r.tip}`).join('\n') : '';
}
export function buildContext({ mode, role, texts = [], exclude = [], meta, builds = BUILDS, items = ITEMS, snapshot = SNAPSHOT, cards, mvpRp = 25, seasonDays = 90 }) {
  cards ??= cachedCards().cards;
  const heroes = meta?.heroes?.length ? meta.heroes : SNAPSHOT_HEROES, live = !!meta?.live;
  const byName = new Map(heroes.map(h => [h.name, h])), idx = buildIndex(heroes, cards), cardBy = new Map(cards.map(c => [c.hero, c]));
  const mentioned = findHeroes(texts, idx), exSet = new Set(findHeroes(exclude, idx)), out = [];
  out.push(`МЕТА: ${live ? 'живая статистика mobilelegends.com (версия патча не указана)' : `сохранённый срез ${snapshot.source}, патч ${snapshot.patch}, ${snapshot.date}`}. Числа можно брать только из блоков МЕТА и КАРТОЧКИ.`);
  const missingCards = [];
  if (mentioned.length) {
    out.push('УПОМЯНУТЫЕ ГЕРОИ:\n' + mentioned.map(n => {
      const c = cardBy.get(n); if (!c) missingCards.push(n);
      const bl = buildLines(n, builds);
      return '— ' + metaLine(n, byName) + (c ? '\n  ' + cardLine(c, live ? null : snapshot.patch) : '\n  карточки героя нет: умения, тип урона, контрпики и синергию не знаем; такие советы помечай «(общие знания)»') + (bl ? '\n' + bl : '');
    }).join('\n'));
  }
  let cand = null;
  if (mode === 'draft' && role) {
    cand = candidates(role, heroes, cards, exSet, builds);
    out.push(`КАНДИДАТЫ НА РОЛЬ ${String(role).toUpperCase()} (занятые и забаненные исключены; роль героя известна из карточки или сборки):\n` +
      (cand.top.length ? cand.top.map((x, i) => `${i + 1}. ${x.name} [${x.src}]${x.h ? `, тир ${x.h.tier || '?'}, винрейт ${x.h.wr}%` : ''}`).join('\n') : 'нет героев с известной ролью') +
      `\nГероев с известной ролью: ${cand.total} из ${heroes.length}. Остальные герои по ролям в данных не размечены: если предлагаешь не из списка, пометь «(общие знания)».`);
  }
  if (!cards.length) out.push('КАРТОЧКИ: готовых карточек героев пока нет (умения, урон, контрпики недоступны). Такие советы помечай «(общие знания)».');
  const ib = itemsBlock(items, mode === 'draft' ? role : null); if (ib) out.push(ib);
  if (mode === 'chat') out.push(appRules(mvpRp, seasonDays));
  const text = out.join('\n\n');
  return { text, mentioned, missingCards, candidates: cand?.top.map(x => x.name) || [], stats: { cards: cards.length, mentioned: mentioned.length, chars: text.length } };
}
