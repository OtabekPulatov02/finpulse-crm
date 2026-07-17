/* ============================================================
   Finpulse CRM — ретраи для OData-запросов к Clobus (1С:Фреш).

   Зачем: Clobus.uz часто отвечает медленно и имеет жёсткий лимит
   одновременных сеансов на приложение (сами столкнулись на PRESTIGE
   CLUB — сессии из прошлых прогонов не закрылись и блокировали вход).
   Транзитные сетевые сбои (timeout, ECONNRESET, 502/503/504) не должны
   сразу превращаться в ошибку для пользователя/AI — один-два повтора
   с растущей паузой решают почти всё.

   ВАЖНО про запись (POST/PUT): повторяем ТОЛЬКО если сбой произошёл
   ДО получения HTTP-ответа (сетевая ошибка/timeout) — если 1С успела
   ответить (даже 500), значит запрос дошёл, и слепой повтор рискует
   создать документ дважды. Поэтому ретраи не заменяют существующую
   проверку дублей в execute_task (см. api/1c.js), а дополняют её на
   уровне транспорта.
   ============================================================ */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* fetchFn — функция () => Promise<Response>, вызывается заново на
   каждой попытке (нельзя переиспользовать уже прочитанный Response). */
async function fetchWithRetry(fetchFn, { retries = 2, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchFn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      await sleep(baseDelayMs * Math.pow(2, attempt) + Math.random() * 200);
    }
  }
  throw lastErr;
}

module.exports = { fetchWithRetry, sleep };
