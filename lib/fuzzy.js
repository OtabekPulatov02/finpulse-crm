/* ============================================================
   Finpulse CRM — общая нечёткая оценка похожести названий
   (контрагенты, сотрудники и т.п.). Раньше существовала в двух
   местах с идентичным кодом (api/1c.js fuzzyScore, api/ai.js
   fuzzyScoreLocal) — вынесена сюда как единственный источник.

   Возвращает число от 0 до 1: 1 — точное совпадение, 0.85 —
   одна строка является подстрокой другой, иначе — доля общих
   "значимых" слов (длиннее 2 символов) от большего множества.
   ============================================================ */
function fuzzyScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const wa = new Set(a.split(" ").filter((w) => w.length > 2));
  const wb = new Set(b.split(" ").filter((w) => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size);
}

module.exports = { fuzzyScore };
