import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Load hero-images.json
const images = JSON.parse(fs.readFileSync(path.join(root, 'hero-images.json'), 'utf8'));

// Import SNAPSHOT_HEROES from meta-data.js
const { SNAPSHOT_HEROES } = await import(path.join(root, 'meta-data.js'));

// Lanes mapping
const LANES = {
  jungle: ['Aulus', 'Hirara', 'Fanny', 'Ling', 'Hayabusa', 'Lancelot', 'Gusion', 'Helcurt', 'Saber', 'Karina', 'Nolan', 'Suyou', 'Harley', 'Yin', 'Roger', 'Hanzo', 'Yi Sun-shin', 'Baxia', 'Martis', 'Julian', 'Alucard', 'Barats', 'Aamon', 'Joy'],
  exp: ['Gloo', 'Masha', 'Argus', 'Benedetta', 'Sun', 'Guinevere', 'Terizla', 'Khaleed', 'Leomord', 'Hilda', 'Paquito', 'Badang', 'X.Borg', 'Ruby', 'Cici', 'Uranus', 'Yu Zhong', 'Lapu-Lapu', 'Thamuz', 'Phoveus', 'Dyrroth', 'Freya', 'Arlott', 'Alpha', 'Jawhead', 'Chou', 'Gatotkaca', 'Zilong', 'Balmond', 'Silvanna', 'Aldous'],
  mid: ['Valir', 'Gord', 'Zhask', 'Kagura', 'Eudora', 'Kadita', 'Zetian', 'Yve', 'Cyclops', 'Faramis', 'Cecilion', 'Alice', 'Zhuxin', 'Vale', 'Xavier', 'Novaria', 'Lylia', 'Odette', 'Vexana', 'Nana', 'Pharsa', 'Luo Yi', 'Lunox', 'Aurora', 'Harith', 'Valentina', 'Chang\'e'],
  gold: ['Obsidia', 'Popol and Kupa', 'Bruno', 'Lukas', 'Irithel', 'Hanabi', 'Natan', 'Beatrix', 'Brody', 'Clint', 'Moskov', 'Ixia', 'Miya', 'Claude', 'Layla', 'Lesley', 'Karrie', 'Melissa', 'Wanwan', 'Kimmy', 'Granger'],
  roam: ['Rafaela', 'Marcel', 'Minotaur', 'Khufra', 'Floryn', 'Carmilla', 'Lolita', 'Diggie', 'Estes', 'Edith', 'Belerick', 'Atlas', 'Minsitthar', 'Fredrinn', 'Bane', 'Natalia', 'Akai', 'Sora', 'Kaja', 'Selena', 'Hylos', 'Johnson', 'Chip', 'Grock', 'Kalea', 'Mathilda', 'Tigreal', 'Franco', 'Angela']
};

const LANE_NAMES = {
  jungle: 'Лес',
  exp: 'Опыт',
  mid: 'Мид',
  gold: 'Золото',
  roam: 'Роум'
};

const CLASSES = {
  jungle: { en: 'Assassin / Fighter', ru: 'Убийца / Лес' },
  exp: { en: 'Fighter / Tank', ru: 'Боец / Передовая' },
  mid: { en: 'Mage', ru: 'Маг / Контроль' },
  gold: { en: 'Marksman', ru: 'Стрелок / Урон' },
  roam: { en: 'Tank / Support', ru: 'Танк / Поддержка' }
};

// Skill templates per lane/class for authentic feeling
const SKILL_TEMPLATES = {
  jungle: [
    { type: 'passive', name: 'Охотничий инстинкт', desc: 'Увеличивает урон по лесным крипам и даёт вампиризм при добивании.' },
    { type: 'skill1', name: 'Смертельный рывок', desc: 'Мгновенный рывок сквозь врагов с нанесением взрывного физического урона.' },
    { type: 'skill2', name: 'Клинки тени', desc: 'Серия круговых ударов, замедляющих цель и накладывающих кровотечение.' },
    { type: 'ult', name: 'Удар бури', desc: 'Взрывное устранение ключевой цели с кратковременной неуязвимостью.' }
  ],
  exp: [
    { type: 'passive', name: 'Неукротимая ярость', desc: 'Увеличивает защиту и регенерацию здоровья при падении HP ниже 40%.' },
    { type: 'skill1', name: 'Сокрушительный выпад', desc: 'Удар по земле с оглушением первой цели и щитом от макс. здоровья.' },
    { type: 'skill2', name: 'Вихрь стали', desc: 'Круговая атака с кражей здоровья и снижением урона от врагов.' },
    { type: 'ult', name: 'Ярость титана', desc: 'Взрыв силы с иммунитетом к контролю и ускорением атаки на 8 секунд.' }
  ],
  mid: [
    { type: 'passive', name: 'Магический резонанс', desc: 'Каждое попадание заклинанием накладывает метку, снижающую маг. защиту.' },
    { type: 'skill1', name: 'Астральная волна', desc: 'Запуск пронзающего сгустка энергии, замедляющего врагов на пути.' },
    { type: 'skill2', name: 'Гравитационный разлом', desc: 'Создание области стягивания врагов с последующим взрывом.' },
    { type: 'ult', name: 'Апокалипсис', desc: 'Массированный залп метеоритов по большой области с оглушением.' }
  ],
  gold: [
    { type: 'passive', name: 'Точный прицел', desc: 'Каждая 4-я базовая атака наносит критический чистый урон.' },
    { type: 'skill1', name: 'Очередь выстрелов', desc: 'Быстрый шквал снарядов с дополнительным уроном от макс. HP цели.' },
    { type: 'skill2', name: 'Тактический откат', desc: 'Рывок назад со снятием замедления и ускорением передвижения.' },
    { type: 'ult', name: 'Смертельный калибр', desc: 'Дальнобойный снайперский выстрел через всю карту по раненым целям.' }
  ],
  roam: [
    { type: 'passive', name: 'Оберег защитника', desc: 'Дарует союзникам рядом постоянный бонус к защите и ауру лечения.' },
    { type: 'skill1', name: 'Цепи контроля', desc: 'Бросок хука или цепи, притягивающий врага и сбивающий касты.' },
    { type: 'skill2', name: 'Щит надежды', desc: 'Накладывает на команду массивный щит и ускоряет скорость бега на 40%.' },
    { type: 'ult', name: 'Командный тотем', desc: 'Глобальная инициация с подбрасыванием всей вражеской команды.' }
  ]
};

const catalog = SNAPSHOT_HEROES.map((h, idx) => {
  let lane = 'exp';
  for (const [l, list] of Object.entries(LANES)) {
    if (list.includes(h.en)) {
      lane = l;
      break;
    }
  }

  // Derive stats based on lane & tier
  const tierBonus = { S: 1.5, A: 1.0, B: 0.5, C: 0, D: -0.5 }[h.tier] || 0;
  const isJungle = lane === 'jungle', isGold = lane === 'gold', isMid = lane === 'mid', isRoam = lane === 'roam', isExp = lane === 'exp';

  const earlyPower = Math.min(10, Math.max(4, Math.round((isJungle ? 9 : isRoam ? 8 : isMid ? 7 : isExp ? 7 : 5) + (tierBonus * 0.5))));
  const latePower = Math.min(10, Math.max(4, Math.round((isGold ? 10 : isExp ? 8 : isMid ? 9 : isJungle ? 8 : 6) + (tierBonus * 0.5))));
  const difficulty = isJungle ? 8 : isMid ? 6 : isRoam ? 5 : isGold ? 7 : 6;
  const durability = isRoam ? 10 : isExp ? 9 : isJungle ? 5 : isMid ? 4 : 3;
  const offense = isGold ? 10 : isJungle ? 9 : isMid ? 9 : isExp ? 7 : 4;

  const skills = SKILL_TEMPLATES[lane].map(s => ({ ...s }));

  return {
    id: idx + 1,
    name: h.name,
    en: h.en,
    img: h.img || images[h.en] || null,
    tier: h.tier,
    wr: h.wr,
    ban: h.ban,
    lane,
    laneRu: LANE_NAMES[lane],
    role: CLASSES[lane].en,
    roleRu: CLASSES[lane].ru,
    title: `${CLASSES[lane].ru} · ${LANE_NAMES[lane]}`,
    stats: {
      earlyPower,
      latePower,
      difficulty,
      durability,
      offense
    },
    skills
  };
});

fs.writeFileSync(path.join(root, 'public', 'hero-catalog.json'), JSON.stringify(catalog, null, 2));
fs.writeFileSync(path.join(root, 'hero-catalog.json'), JSON.stringify(catalog, null, 2));
console.log(`Successfully generated hero-catalog.json with ${catalog.length} heroes!`);
