// Данные раздела «Мета». Положи этот файл рядом с server.js.
// Источники (открытые): mlbbhub.com (тир-лист и сборки), playnews.gg (предметы по ролям).
// Это срез на дату ниже. Живая статистика подтягивается из Rone Arena, этот файл включается, когда она недоступна.

export const SNAPSHOT = {
  patch: '2.2.16', season: 42, date: '2026-10-12',
  source: 'mlbbhub.com', url: 'https://mlbbhub.com/tier-list',
  note: 'Винрейт по всем рангам, патч 2.2.16',
};

// Тир → «Герой винрейт%». Бан% указан там, где источник его показывает.
const TIERS = {
  S: 'Aulus 59.8, Masha 59.7, Rafaela 59.0, Marcel 58.1, Argus 55.8, Minotaur 55.1, Khufra 54.6, Floryn 54.1, Gloo 54.0, Obsidia 53.8, Carmilla 53.8, Hirara 53.4',
  A: 'Popol and Kupa 54.4, Lolita 54.0, Valir 53.5, Diggie 53.4, Bruno 53.1, Gord 52.9, Lukas 52.8, Estes 52.8, Edith 52.7, Benedetta 52.5, Irithel 52.4, Ling 52.4, Zhask 52.2, Sun 52.2, Belerick 52.1, Hanabi 52.1, Barats 52.0, Kagura 51.9, Atlas 51.9, Eudora 51.4, Kadita 51.4, Guinevere 51.4, Minsitthar 51.4, Zetian 50.9',
  B: 'Yve 51.7, Cyclops 51.4, Natan 51.3, Faramis 51.3, Fredrinn 51.3, Beatrix 51.3, Bane 51.1, Cecilion 51.0, Natalia 51.0, Alice 50.9, Silvanna 50.9, Brody 50.8, Terizla 50.8, Clint 50.8, Khaleed 50.8, Leomord 50.6, Akai 50.5, Aldous 50.5, Hilda 50.5, Paquito 50.4, Zhuxin 50.4, Badang 50.2, Moskov 50.0, Julian 49.9, Ixia 49.9, Vale 49.9, Xavier 49.8, Aamon 49.8, Sora 49.7, X.Borg 49.7, Yi Sun-shin 49.7, Novaria 49.6, Suyou 49.6, Saber 49.6, Kaja 49.6, Ruby 49.6, Lylia 49.6, Hanzo 49.5, Miya 49.5, Odette 49.5, Vexana 49.4, Angela 49.3, Claude 49.2, Selena 49.1, Layla 49.1, Nolan 48.9, Lesley 48.2',
  C: 'Cici 49.2, Uranus 49.2, Yu Zhong 49.1, Joy 48.9, Yin 48.7, Roger 48.7, Kimmy 48.7, Hylos 48.7, Lapu-Lapu 48.6, Thamuz 48.6, Karrie 48.5, Melissa 48.5, Lunox 48.5, Aurora 48.5, Phoveus 48.3, Wanwan 48.2, Dyrroth 48.2, Johnson 48.2, Hayabusa 48.1, Gusion 48.0, Freya 48.0, Arlott 48.0, Alpha 47.9, Chang\'e 47.9, Luo Yi 47.8, Harley 47.6, Karina 47.6, Jawhead 47.6, Alucard 47.5, Nana 47.3, Martis 47.3, Pharsa 47.2, Esmeralda 47.2, Helcurt 46.9',
  D: 'Chip 47.3, Baxia 47.1, Grock 46.8, Balmond 46.3, Harith 46.1, Valentina 45.8, Zilong 45.6, Kalea 45.1, Mathilda 45.0, Chou 44.9, Gatotkaca 44.8, Tigreal 44.5, Granger 43.0, Lancelot 42.7, Fanny 41.7, Franco 41.3',
};
const BANS = { Aulus: 34.9, Masha: 32.0, Rafaela: 18.2, Marcel: 33.1, Gloo: 38.9, Obsidia: 16.1, Hirara: 68.2, Lukas: 35.6, Estes: 40.6, Sun: 21.4,
  Belerick: 56.4, Eudora: 58.9, Paquito: 38.7, Saber: 22.1, Kaja: 18.1 };

const SNAPSHOT_HEROES_EN = Object.entries(TIERS).flatMap(([tier, s]) => s.split(/,\s*/).map(x => {
  const i = x.lastIndexOf(' '), name = x.slice(0, i);
  return { name, img: null, wr: +x.slice(i + 1), pick: null, ban: BANS[name] ?? null, tier };
}));

// Популярные сборки. kind: curated = подборка редакторов mlbbhub, community = сборка игроков.
// Порядок предметов как на карточках источника (первый слот — ботинки).
const B = (name, kind, items, emblem, spell) => ({ name, kind, items: items.split(', '), emblem, spell });
const BUILDS_EN = [
  { hero: 'Aulus', lane: 'Jungle', tier: 'S', builds: [
    B('Jungle Bruiser', 'curated', 'Tough Boots, War Axe, Brute Force Breastplate, Rose Gold Meteor, Queen\'s Wings, Malefic Roar', 'Fighter', 'Retribution'),
    B('EXP Sustain', 'community', 'Tough Boots, War Axe, Rose Gold Meteor, Golden Staff, Queen\'s Wings, Oracle', 'Fighter', 'Vengeance')] },
  { hero: 'Hirara', lane: 'Jungle', tier: 'S', builds: [
    B('Sustainability', 'community', 'Magic Boots, Hunter Strike, War Axe, Brute Force Breastplate, Blade of Despair, Malefic Roar', 'Assassin', 'Retribution')] },
  { hero: 'Obsidia', lane: 'Gold', tier: 'S', builds: [
    B('Front-to-Back Anti-Tank', 'curated', 'Swift Boots, Corrosion Scythe, Demon Hunter Sword, Golden Staff, Sea Halberd, Malefic Roar', 'Marksman', 'Inspire'),
    B('Attack Effects', 'curated', 'Swift Boots, Corrosion Scythe, Demon Hunter Sword, Golden Staff, Malefic Gun, Rose Gold Meteor', 'Marksman', 'Flicker')] },
  { hero: 'Gloo', lane: 'EXP', tier: 'S', builds: [
    B('Anti-Physical Wall', 'curated', 'Warrior Boots, Cursed Helmet, Glowing Wand, Chastise Pauldron, Antique Cuirass, Immortality', 'Tank', 'Vengeance'),
    B('Burn Attach', 'curated', 'Tough Boots, Cursed Helmet, Glowing Wand, Oracle, Antique Cuirass, Immortality', 'Common', 'Flicker')] },
  { hero: 'Rafaela', lane: 'Roam', tier: 'S', builds: [
    B('Sprint Chase Control', 'curated', 'Rapid Boots, Enchanted Talisman, Flask of the Oasis, Ice Queen Wand, Fleeting Time, Immortality', 'Support', 'Sprint'),
    B('Anti-Sustain Aura', 'curated', 'Tough Boots, Enchanted Talisman, Flask of the Oasis, Dominance Ice, Radiant Armor, Immortality', 'Support', 'Purify')] },
  { hero: 'Marcel', lane: 'Roam', tier: 'S', builds: [
    B('Anti-Basic Frontline', 'curated', 'Warrior Boots, Thunder Belt, Dominance Ice, Chastise Pauldron, Blade Armor, Immortality', 'Tank', 'Vengeance'),
    B('Favor Control', 'curated', 'Tough Boots, Thunder Belt, Dominance Ice, Oracle, Athena\'s Shield, Immortality', 'Support', 'Petrify')] },
  { hero: 'Minotaur', lane: 'Roam', tier: 'S', builds: [
    B('Favor Sustain Initiate', 'curated', 'Tough Boots, Dominance Ice, Flask of the Oasis, Oracle, Antique Cuirass, Immortality', 'Support', 'Flicker'),
    B('Vengeance Anti-Physical', 'curated', 'Warrior Boots, Dominance Ice, Blade Armor, Antique Cuirass, Oracle, Immortality', 'Tank', 'Vengeance')] },
  { hero: 'Khufra', lane: 'Roam', tier: 'S', builds: [
    B('Frontline Encourage', 'curated', 'Warrior Boots, Cursed Helmet, Dominance Ice, Antique Cuirass, Radiant Armor, Immortality', 'Tank', 'Flicker'),
    B('Vengeance Anti-Physical', 'curated', 'Warrior Boots, Dominance Ice, Blade Armor, Antique Cuirass, Oracle, Immortality', 'Tank', 'Vengeance')] },
  { hero: 'Floryn', lane: 'Roam', tier: 'S', builds: [
    B('Favor Tempo', 'curated', 'Demon Boots, Flask of the Oasis, Fleeting Time, Glowing Wand, Oracle, Immortality', 'Support', 'Flicker'),
    B('Anti-Sustain Defense', 'curated', 'Tough Boots, Flask of the Oasis, Dominance Ice, Oracle, Fleeting Time, Immortality', 'Support', 'Flicker')] },
  { hero: 'Carmilla', lane: 'Roam', tier: 'S', builds: [
    B('Favor CC Link', 'curated', 'Tough Boots, Flask of the Oasis, Fleeting Time, Dominance Ice, Oracle, Immortality', 'Support', 'Flicker'),
    B('Purify Sustain', 'curated', 'Demon Boots, Flask of the Oasis, Fleeting Time, Cursed Helmet, Oracle, Immortality', 'Support', 'Purify')] },
];
export const BUILDS_SRC = { name: 'mlbbhub.com', url: 'https://mlbbhub.com/builds', note: 'Часть сборок на источнике помечена как «прошлый патч», сверяйся с обновлениями.' };

// Предметы по ролям (playnews.gg, патч 2.1.90, июль 2026)
const ITEMS_EN = {
  src: { name: 'playnews.gg', url: 'https://www.playnews.gg/en/guides/mlbb-the-best-items-by-role-in-july-2026', note: 'Патч 2.1.90, июль 2026' },
  roles: [
    { role: 'gold', name: 'Gold', core: 'Swift Boots, Windtalker, Berserker\'s Fury, Scarlet Phantom, Malefic Roar, Blade of Despair',
      tip: 'Против ассасинов Wind of Nature не позже третьего слота. Против танков с Antique Cuirass Malefic Roar обязателен. Против лечения (Estes) бери Sea Halberd вместо 4-го предмета.' },
    { role: 'exp', name: 'EXP', core: 'Warrior Boots, War Axe, Hunter Strike, Queen\'s Wings, Oracle, Immortality',
      tip: 'Против танковых бойцов Sea Halberd четвёртым. Против Paquito и Yu Zhong Blade Armor третьим.' },
    { role: 'mid', name: 'Mid', core: 'Arcane Boots, Clock of Destiny, Holy Crystal, Divine Glaive',
      tip: 'Holy Crystal во второй слот. Divine Glaive обязателен, когда враг купил Athena\'s Shield. Против ассасинов Winter Truncheon.' },
    { role: 'jungle', name: 'Jungle', core: 'Rapid Boots, Blade of the Heptaseas, Hunter Strike, Blade of Despair',
      tip: 'Первый предмет до 4-й минуты. Если после 8-й минуты нет преимущества по золоту, переходи на Malefic Roar + Immortality.' },
    { role: 'roam', name: 'Roam', core: 'Tough Boots, Antique Cuirass, Athena\'s Shield, Immortality',
      tip: 'Radiant Armor против Yve и Zhuxin. Dominance Ice против сильного лечения. Против двух источников лечения бери антихил до конца мидгейма.' },
  ],
};

// ═══ Русская локализация ═══
// Названия героев, предметов, эмблем и заклинаний взяты из русскоязычных источников по MLBB (esports.ru, sports.ru, taverna.gg, donatov.blog, offstage.ru).
// Если проверенного русского названия нет, остаётся английское: лучше английское, чем выдуманное. Чтобы заменить, допиши пару в ITEM_RU.
const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const HERO_RU_RAW = {
  'Aamon': 'Эймон', 'Akai': 'Акай', 'Aldous': 'Алдос', 'Alice': 'Алиса', 'Alpha': 'Альфа', 'Alucard': 'Алукард', 'Angela': 'Ангела', 'Argus': 'Аргус',
  'Arlott': 'Арлотт', 'Atlas': 'Атлас', 'Aulus': 'Аулус', 'Aurora': 'Аврора', 'Badang': 'Баданг', 'Balmond': 'Бальмонд', 'Bane': 'Бэйн', 'Barats': 'Бартс',
  'Baratz': 'Бартс', 'Baxia': 'Баксий', 'Beatrix': 'Беатрис', 'Belerick': 'Белерик', 'Benedetta': 'Бенедетта', 'Brody': 'Броуди', 'Bruno': 'Бруно',
  'Carmilla': 'Кармилла', 'Cecilion': 'Сесилион', "Chang'e": "Чан'Э", 'Chip': 'Чип', 'Chou': 'Чу', 'Cici': 'Чичи', 'Claude': 'Клауд', 'Clint': 'Клинт',
  'Cyclops': 'Циклоп', 'Diggie': 'Дигги', 'Dyrroth': 'Дариус', 'Edith': 'Эдит', 'Esmeralda': 'Эсмеральда', 'Estes': 'Эстес', 'Eudora': 'Эйдора',
  'Fanny': 'Фанни', 'Faramis': 'Фарамис', 'Floryn': 'Флорин', 'Franco': 'Франко', 'Fredrinn': 'Фредрин', 'Freya': 'Фрейя', 'Gatotkaca': 'Гатоткача',
  'Gloo': 'Глу', 'Gord': 'Горд', 'Granger': 'Грейнджер', 'Grock': 'Грок', 'Guinevere': 'Гвиневра', 'Gusion': 'Госсен', 'Hanabi': 'Ханаби', 'Hanzo': 'Ханзо',
  'Harith': 'Харит', 'Harley': 'Харли', 'Hayabusa': 'Хаябуса', 'Helcurt': 'Хелкарт', 'Hilda': 'Хильда', 'Hirara': 'Хирара', 'Hylos': 'Хилос',
  'Irithel': 'Иритель', 'Ixia': 'Иксия', 'Jawhead': 'Кусака', 'Johnson': 'Джонсон', 'Joy': 'Джой', 'Julian': 'Джулиан', 'Kadita': 'Кадита', 'Kagura': 'Кагура',
  'Kaja': 'Кайя', 'Kalea': 'Калеа', 'Karina': 'Карина', 'Karrie': 'Кэрри', 'Khaleed': 'Халид', 'Khufra': 'Хуфра', 'Kimmy': 'Кимми', 'Lancelot': 'Ланселот',
  'Lapu-Lapu': 'Лапу-Лапу', 'Layla': 'Лейла', 'Leomord': 'Леоморд', 'Lesley': 'Лесли', 'Ling': 'Линг', 'Lolita': 'Лолита', 'Lukas': 'Лукас', 'Lunox': 'Люнокс',
  'Luo Yi': 'Ло Йи', 'Lylia': 'Лилия', 'Marcel': 'Марсель', 'Martis': 'Мартис', 'Masha': 'Маша', 'Mathilda': 'Матильда', 'Melissa': 'Мелисса', 'Minotaur': 'Минотавр',
  'Minsitthar': 'Минситтар', 'Miya': 'Мия', 'Moskov': 'Москов', 'Nana': 'Нана', 'Natalia': 'Наталья', 'Natan': 'Натан', 'Nolan': 'Нолан', 'Novaria': 'Новария',
  'Obsidia': 'Обсидия', 'Odette': 'Одетта', 'Paquito': 'Пакито', 'Pharsa': 'Фаша', 'Phoveus': 'Фовиус', 'Popol and Kupa': 'Пополь и Купа', 'Rafaela': 'Рафаэль',
  'Roger': 'Роджер', 'Ruby': 'Руби', 'Saber': 'Сабер', 'Selena': 'Селена', 'Silvanna': 'Сильвана', 'Sora': 'Сора', 'Sun': 'Сан', 'Suyou': 'Су Ё',
  'Terizla': 'Тэризла', 'Thamuz': 'Тамуз', 'Tigreal': 'Тигрил', 'Uranus': 'Уранус', 'Valentina': 'Валентина', 'Vale': 'Вэйл', 'Valir': 'Валир', 'Vexana': 'Вексана',
  'Wanwan': 'Ванван', 'X.Borg': 'Икс.Борг', 'Xavier': 'Ксавьер', 'Yi Sun-shin': 'Ли Сун-Син', 'Yin': 'Инь', 'Yu Zhong': 'Чонг', 'Yve': 'Ив', 'Zetian': 'Цзэтянь',
  'Zhask': 'Заск', 'Zhuxin': 'Чжусинь', 'Zilong': 'Зилонг',
};
const HERO_RU = new Map(Object.entries(HERO_RU_RAW).map(([k, v]) => [norm(k), v]));
export const heroRu = n => HERO_RU.get(norm(n)) || n;

// Предметы. Нет проверенного русского названия у Winter Truncheon, оно остаётся английским.
const ITEM_RU = {
  'Tough Boots': 'Прочные сапоги', 'Swift Boots': 'Сапоги-скороходы', 'Magic Boots': 'Магические ботинки', 'Warrior Boots': 'Сапоги воина',
  'Rapid Boots': 'Сапоги спешки', 'Demon Boots': 'Ботинки демона', 'Arcane Boots': 'Сапоги заклинателя',
  'War Axe': 'Топор войны', 'Brute Force Breastplate': 'Кираса грубой силы', 'Rose Gold Meteor': 'Золотой метеор', "Queen's Wings": 'Крылья королевы',
  'Malefic Roar': 'Злобный рык', 'Hunter Strike': 'Удар охотника', 'Blade of Despair': 'Клинок отчаяния', 'Corrosion Scythe': 'Коса коррозии',
  'Demon Hunter Sword': 'Меч охотника на демонов', 'Golden Staff': 'Золотой посох', 'Cursed Helmet': 'Проклятый шлем', 'Glowing Wand': 'Пылающий жезл',
  'Antique Cuirass': 'Древняя кираса', 'Immortality': 'Бессмертие', 'Enchanted Talisman': 'Зачарованный талисман', 'Flask of the Oasis': 'Фляга Оазиса',
  'Ice Queen Wand': 'Жезл снежной королевы', 'Fleeting Time': 'Мимолетное время', 'Dominance Ice': 'Господство льда', 'Blade Armor': 'Шипованная броня',
  'Oracle': 'Оракул', "Athena's Shield": 'Щит Афины', 'Radiant Armor': 'Сияющая броня', 'Windtalker': 'Говорящий с ветром', "Berserker's Fury": 'Ярость берсерка',
  'Sea Halberd': 'Морская алебарда', 'Malefic Gun': 'Губительный пулемет', 'Chastise Pauldron': 'Наплечник наказания',
  'Thunder Belt': 'Штормовой пояс', 'Scarlet Phantom': 'Алый Призрак',
  'Clock of Destiny': 'Часы судьбы', 'Holy Crystal': 'Священный кристалл', 'Divine Glaive': 'Божественный меч', 'Blade of the Heptaseas': 'Клинок семи морей',
};
const itemRu = i => ITEM_RU[i] || i;
const EMBLEM_RU = { Fighter: 'Эмблемы Бойца', Assassin: 'Эмблемы Ассасина', Marksman: 'Эмблемы Стрелка', Tank: 'Эмблемы Танка', Support: 'Эмблемы Поддержки', Mage: 'Эмблемы Мага', Common: 'Базовые эмблемы' };
const SPELL_RU = { Retribution: 'Возмездие', Vengeance: 'Отмщение', Inspire: 'Вдохновение', Flicker: 'Вспышка', Sprint: 'Спринт', Purify: 'Очищение', Petrify: 'Оцепенение' };
const BUILD_RU = {
  'Jungle Bruiser': 'Лесной боец', 'EXP Sustain': 'Живучесть на линии опыта', 'Sustainability': 'Живучесть', 'Front-to-Back Anti-Tank': 'Против танков в затяжном бою',
  'Attack Effects': 'Эффекты атаки', 'Anti-Physical Wall': 'Стена против физического урона', 'Burn Attach': 'Поджог при атаках', 'Sprint Chase Control': 'Спринт, погоня, контроль',
  'Anti-Sustain Aura': 'Против лечения и аура', 'Anti-Basic Frontline': 'Против обычных атак на передовой', 'Favor Control': 'Благосклонность и контроль',
  'Favor Sustain Initiate': 'Благосклонность, живучесть и инициация', 'Vengeance Anti-Physical': 'Отмщение против физического урона', 'Frontline Encourage': 'Передовая и Поощрение',
  'Favor Tempo': 'Благосклонность и темп', 'Anti-Sustain Defense': 'Защита против лечения', 'Favor CC Link': 'Благосклонность, контроль и связка', 'Purify Sustain': 'Очищение и живучесть',
};
const tr = (m, k) => { if (!(k in m)) console.error('[meta-data] нет перевода:', k); return m[k] ?? k; };
const itemsRu = list => list.map(itemRu);

export const SNAPSHOT_HEROES = SNAPSHOT_HEROES_EN.map(h => ({ ...h, en: h.name, name: heroRu(h.name) }));
export const BUILDS = BUILDS_EN.map(b => ({ ...b, en: b.hero, hero: heroRu(b.hero), builds: b.builds.map(x => ({
  ...x, name: tr(BUILD_RU, x.name), items: itemsRu(x.items), emblem: tr(EMBLEM_RU, x.emblem), spell: tr(SPELL_RU, x.spell) })) }));

const ROLE_RU = {
  gold: { name: 'Золото', tip: 'Против ассасинов Ветер природы не позже третьего слота. Против танков с Древней кирасой Злобный рык обязателен. Против лечения (Эстес) бери Морскую алебарду вместо 4-го предмета.' },
  exp: { name: 'Опыт', tip: 'Против танковых бойцов Морская алебарда четвёртым. Против Пакито и Чонга Шипованная броня третьим.' },
  mid: { name: 'Мид', tip: 'Священный кристалл во второй слот. Божественный меч обязателен, когда враг купил Щит Афины. Против ассасинов Winter Truncheon.' },
  jungle: { name: 'Лес', tip: 'Первый предмет до 4-й минуты. Если после 8-й минуты нет преимущества по золоту, переходи на Злобный рык + Бессмертие.' },
  roam: { name: 'Роум', tip: 'Сияющая броня против Ив и Чжусинь. Господство льда против сильного лечения. Против двух источников лечения бери антихил до конца мидгейма.' },
};
export const ITEMS = { ...ITEMS_EN, src: { ...ITEMS_EN.src, note: 'Патч 2.1.90, июль 2026' },
  roles: ITEMS_EN.roles.map(r => ({ ...r, name: ROLE_RU[r.role].name, core: itemsRu(r.core.split(', ')).join(', '), tip: ROLE_RU[r.role].tip })) };
