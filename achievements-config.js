// ════════════════════════════════════════════════════════════════════════
//  OLYMP CUSTOM — конфигурация достижений и титулов
//  Менять названия, описания, пороги, редкость, иконки и добавлять новые
//  достижения можно ТОЛЬКО здесь. Логику (achievements.js) трогать не нужно.
//  После правки перезапусти сервер: новые достижения сами выдадутся тем, кто
//  их уже заслужил по истории матчей (тихо, без уведомлений).
//  Уже выданные награды никогда не отбираются, даже если порог потом подняли.
// ════════════════════════════════════════════════════════════════════════
//
//  Описание достижения:
//    code      — уникальный код (латиница). Менять после запуска нельзя: по нему хранятся награды.
//    name,desc — название и условие, как увидит игрок
//    icon      — эмодзи
//    cat       — категория из CATEGORIES
//    rarity    — common | rare | epic | legendary (см. RARITY)
//    scope     — 'permanent' (выдаётся один раз навсегда) или 'season' (выдаётся заново в каждом сезоне)
//    secret    — true: пока не получено, в списке показывается как «???»
//    title     — (необязательно) код титула из TITLES, который открывается вместе с достижением
//    rule      — условие, один из видов:
//      { type: 'stat', metric, gte, role? }  — считается автоматически по истории матчей
//             metric: games | wins | losses | winStreak | mvp | mvpStreak | roles |
//                     roleWins (нужен role) | roleGames (нужен role) | comebackWins | nightWins
//      { type: 'event', event, gte }         — по событию из EVENTS (турниры, команды), см. админ-API
//      { type: 'season_end', maxRank }       — по итогам сезона: место в рейтинге не ниже maxRank
//      { type: 'manual' }                    — только ручная выдача администратором
//
//  Для scope: 'season' счётчики считаются только по матчам этого сезона.

// Часовой пояс для «ночных» достижений (Ереван, UTC+4)
export const TZ_OFFSET_H = 4;
export const NIGHT_FROM = 2, NIGHT_TO = 5; // ночь: с 02:00 до 04:59 по местному времени

// Сколько побед на одной роли открывают титул этой роли
const ROLE_WINS = 10;

export const RARITY = {
  common:    { label: 'Обычное',     color: '#a6939b' },
  rare:      { label: 'Редкое',      color: '#4cc9f0' },
  epic:      { label: 'Эпическое',   color: '#b86bff' },
  legendary: { label: 'Легендарное', color: '#ffc259' },
};

// Порядок и названия разделов в списке достижений
export const CATEGORIES = {
  matches:   'Матчи',
  wins:      'Победы',
  skill:     'Мастерство',
  roles:     'Роли',
  community: 'Сообщество',
  season:    'Сезон',
  secret:    'Секретные',
};

// События, которые приходят снаружи (когда появится модуль турниров, он вызывает их сам).
// implies — какие события засчитываются автоматически вместе с этим.
export const EVENTS = {
  team_founded:      { label: 'Основал команду' },
  tournament_played: { label: 'Сыграл в турнире' },
  tournament_final:  { label: 'Дошёл до финала турнира', implies: ['tournament_played'] },
  tournament_win:    { label: 'Выиграл турнир',          implies: ['tournament_final', 'tournament_played'] },
};

// Титулы: уникальные звания. Игрок выбирает один активный, он показывается рядом с ником.
// Открывается титул достижением, у которого указан title: 'КОД'.
export const TITLES = {
  JUNGLE_KING:     { name: 'КОРОЛЬ ЛЕСА',      icon: '🌲', rarity: 'epic' },
  MID_MASTER:      { name: 'МАСТЕР МИДА',      icon: '🔮', rarity: 'epic' },
  IRON_ROAM:       { name: 'ЖЕЛЕЗНЫЙ ROAM',    icon: '🛡️', rarity: 'epic' },
  EXP_TITAN:       { name: 'ТИТАН ЭКСП',       icon: '⚔️', rarity: 'epic' },
  GOLD_SNIPER:     { name: 'СНАЙПЕР GOLD',     icon: '🎯', rarity: 'epic' },
  OLYMP_LEGEND:    { name: 'ЛЕГЕНДА OLYMP',    icon: '🏛️', rarity: 'legendary' },
  SEASON_CHAMPION: { name: 'ЧЕМПИОН СЕЗОНА',   icon: '👑', rarity: 'legendary' },
};

export const ACHIEVEMENTS = [
  // ── За количество матчей ──
  { code: 'debut',      name: 'Дебютант',           desc: 'Заверши первый матч',          icon: '🎮', cat: 'matches', rarity: 'common',    scope: 'permanent', rule: { type: 'stat', metric: 'games', gte: 1 } },
  { code: 'regular',    name: 'Постоянный участник', desc: 'Сыграй 10 матчей',            icon: '🔁', cat: 'matches', rarity: 'common',    scope: 'permanent', rule: { type: 'stat', metric: 'games', gte: 10 } },
  { code: 'veteran',    name: 'Ветеран OLYMP',      desc: 'Сыграй 50 матчей',             icon: '🎖️', cat: 'matches', rarity: 'rare',      scope: 'permanent', rule: { type: 'stat', metric: 'games', gte: 50 } },
  { code: 'arena_legend', name: 'Легенда арены',    desc: 'Сыграй 100 матчей',            icon: '🏛️', cat: 'matches', rarity: 'legendary', scope: 'permanent', title: 'OLYMP_LEGEND', rule: { type: 'stat', metric: 'games', gte: 100 } },

  // ── За победы ──
  { code: 'first_blood', name: 'Первая кровь',      desc: 'Одержи первую победу',         icon: '🩸', cat: 'wins', rarity: 'common',    scope: 'permanent', rule: { type: 'stat', metric: 'wins', gte: 1 } },
  { code: 'streak3',    name: 'Победная серия',     desc: '3 победы подряд',              icon: '🔥', cat: 'wins', rarity: 'common',    scope: 'permanent', rule: { type: 'stat', metric: 'winStreak', gte: 3 } },
  { code: 'streak5',    name: 'Неостановимый',      desc: '5 побед подряд',               icon: '⚡', cat: 'wins', rarity: 'rare',      scope: 'permanent', rule: { type: 'stat', metric: 'winStreak', gte: 5 } },
  { code: 'streak10',   name: 'Доминирование',      desc: '10 побед подряд',              icon: '💀', cat: 'wins', rarity: 'legendary', scope: 'permanent', rule: { type: 'stat', metric: 'winStreak', gte: 10 } },

  // ── За индивидуальные результаты ──
  { code: 'mvp1',       name: 'Первый MVP',         desc: 'Стань MVP матча',              icon: '⭐', cat: 'skill', rarity: 'common', scope: 'permanent', rule: { type: 'stat', metric: 'mvp', gte: 1 } },
  { code: 'mvp5',       name: 'Пятикратный MVP',    desc: 'Стань MVP 5 раз',              icon: '🌟', cat: 'skill', rarity: 'rare',   scope: 'permanent', rule: { type: 'stat', metric: 'mvp', gte: 5 } },
  { code: 'season_star', name: 'Звезда сезона',     desc: '10 MVP за один сезон',         icon: '💫', cat: 'skill', rarity: 'epic',   scope: 'season',    rule: { type: 'stat', metric: 'mvp', gte: 10 } },
  { code: 'universal',  name: 'Универсал',          desc: 'Сыграй матчи на всех пяти ролях', icon: '🧩', cat: 'skill', rarity: 'rare', scope: 'permanent', rule: { type: 'stat', metric: 'roles', gte: 5 } },

  // ── Мастерство по ролям (открывают титулы) ──
  { code: 'jungle_king', name: 'Король леса',       desc: `Выиграй ${ROLE_WINS} матчей на роли Jungle`, icon: '🌲', cat: 'roles', rarity: 'epic', scope: 'permanent', title: 'JUNGLE_KING', rule: { type: 'stat', metric: 'roleWins', role: 'jungle', gte: ROLE_WINS } },
  { code: 'mid_master',  name: 'Мастер мида',       desc: `Выиграй ${ROLE_WINS} матчей на роли Mid`,    icon: '🔮', cat: 'roles', rarity: 'epic', scope: 'permanent', title: 'MID_MASTER',  rule: { type: 'stat', metric: 'roleWins', role: 'mid',    gte: ROLE_WINS } },
  { code: 'iron_roam',   name: 'Железный Roam',     desc: `Выиграй ${ROLE_WINS} матчей на роли Roam`,   icon: '🛡️', cat: 'roles', rarity: 'epic', scope: 'permanent', title: 'IRON_ROAM',   rule: { type: 'stat', metric: 'roleWins', role: 'roam',   gte: ROLE_WINS } },
  { code: 'exp_titan',   name: 'Титан эксп-линии',  desc: `Выиграй ${ROLE_WINS} матчей на роли EXP`,    icon: '⚔️', cat: 'roles', rarity: 'epic', scope: 'permanent', title: 'EXP_TITAN',   rule: { type: 'stat', metric: 'roleWins', role: 'exp',    gte: ROLE_WINS } },
  { code: 'gold_sniper', name: 'Снайпер Gold',      desc: `Выиграй ${ROLE_WINS} матчей на роли Gold`,   icon: '🎯', cat: 'roles', rarity: 'epic', scope: 'permanent', title: 'GOLD_SNIPER', rule: { type: 'stat', metric: 'roleWins', role: 'gold',   gte: ROLE_WINS } },

  // ── Сообщество (по событиям; модуль турниров вызывает их сам, до этого их отмечает админ) ──
  { code: 'team_founder',        name: 'Основатель команды',    desc: 'Создай свою команду',            icon: '🚩', cat: 'community', rarity: 'rare',      scope: 'permanent', rule: { type: 'event', event: 'team_founded',      gte: 1 } },
  { code: 'tournament_debut',    name: 'Участник первого турнира', desc: 'Сыграй в турнире OLYMP',      icon: '🎪', cat: 'community', rarity: 'rare',      scope: 'permanent', rule: { type: 'event', event: 'tournament_played', gte: 1 } },
  { code: 'tournament_finalist', name: 'Финалист турнира',      desc: 'Дойди до финала турнира',        icon: '🥈', cat: 'community', rarity: 'epic',      scope: 'permanent', rule: { type: 'event', event: 'tournament_final',  gte: 1 } },
  { code: 'tournament_champion', name: 'Чемпион турнира',       desc: 'Выиграй турнир OLYMP',           icon: '🏆', cat: 'community', rarity: 'legendary', scope: 'permanent', rule: { type: 'event', event: 'tournament_win',    gte: 1 } },

  // ── Сезонные ──
  { code: 'season_grinder',  name: 'Боец сезона',      desc: 'Сыграй 30 матчей за сезон',      icon: '🗡️', cat: 'season', rarity: 'rare',      scope: 'season', rule: { type: 'stat', metric: 'games', gte: 30 } },
  { code: 'season_winner',   name: 'Победитель сезона', desc: 'Выиграй 20 матчей за сезон',    icon: '📈', cat: 'season', rarity: 'epic',      scope: 'season', rule: { type: 'stat', metric: 'wins', gte: 20 } },
  { code: 'season_podium',   name: 'Призёр сезона',    desc: 'Закончи сезон в топ-3 рейтинга', icon: '🥉', cat: 'season', rarity: 'epic',      scope: 'season', rule: { type: 'season_end', maxRank: 3 } },
  { code: 'season_champion', name: 'Чемпион сезона',   desc: 'Закончи сезон на 1-м месте рейтинга', icon: '👑', cat: 'season', rarity: 'legendary', scope: 'season', title: 'SEASON_CHAMPION', rule: { type: 'season_end', maxRank: 1 } },

  // ── Секретные (условия скрыты, пока не получены) ──
  { code: 'phoenix',   name: 'Феникс',        desc: 'Выиграй матч после трёх поражений подряд', icon: '🦅', cat: 'secret', rarity: 'epic', scope: 'permanent', secret: true, rule: { type: 'stat', metric: 'comebackWins', gte: 1 } },
  { code: 'night_owl', name: 'Ночная смена',  desc: 'Выиграй матч глубокой ночью (02:00–05:00)', icon: '🦉', cat: 'secret', rarity: 'rare', scope: 'permanent', secret: true, rule: { type: 'stat', metric: 'nightWins', gte: 1 } },
  { code: 'mvp_hat',   name: 'Хет-трик MVP',  desc: 'Стань MVP три матча подряд',                icon: '🎩', cat: 'secret', rarity: 'legendary', scope: 'permanent', secret: true, rule: { type: 'stat', metric: 'mvpStreak', gte: 3 } },
];
