import { loadCards } from './context.js';
console.log('Проверка карточек героев...');
const { cards, skipped } = loadCards();
console.log(`Готовых карточек: ${cards.length}, пропущено с ошибками: ${skipped}`);
