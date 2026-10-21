// Схема и валидация карточек героев MLBB
import { SNAPSHOT_HEROES } from '../meta-data.js';

export const normName = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

const knownNames = new Set((SNAPSHOT_HEROES || []).map(h => normName(h.name)));

export function heroNames() {
  return (SNAPSHOT_HEROES || []).map(h => h.name);
}

export function emptyCard(hero = '') {
  return {
    hero,
    status: 'todo',
    lanes: [],
    damage: 'физический',
    cc: 'средний',
    power: { early: 3, late: 3 },
    strong: [],
    weak: [],
    counters: [],
    synergy: [],
    patch: '2.2.16',
    checked: new Date().toISOString().slice(0, 7)
  };
}

export function validateCard(card) {
  const errs = [];
  if (!card || typeof card !== 'object') return ['карточка должна быть объектом'];
  if (!card.hero || typeof card.hero !== 'string') errs.push('поле hero обязательно');
  if (card.status === 'ready') {
    if (!Array.isArray(card.lanes) || !card.lanes.length) errs.push('ready требует lanes');
    if (!card.damage) errs.push('ready требует damage');
    if (!card.power || typeof card.power.early !== 'number' || typeof card.power.late !== 'number') {
      errs.push('ready требует power.early и power.late');
    }
  }
  return errs;
}

export function validateAll(cards) {
  if (!Array.isArray(cards)) return [];
  const errors = [];
  for (const c of cards) {
    const errs = validateCard(c);
    if (errs.length) errors.push({ hero: c?.hero || 'unknown', errors: errs });
  }
  return errors;
}
