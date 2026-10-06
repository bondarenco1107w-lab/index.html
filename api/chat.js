// Vercel serverless function: хранит ключ и общается с Gemini.
// Переменные окружения (Vercel → Settings → Environment Variables):
//   GEMINI_API_KEY  — обязательно
//   ACCESS_CODE     — необязательно: пароль, чтобы чужие не тратили ваш лимит
//   GEMINI_MODEL    — необязательно, по умолчанию gemini-flash-latest

const SYSTEM = `Ты помощник трейдера. Тебе присылают новость. Отвечай по-русски, простыми словами, коротко.
Сначала найди в Google, писали ли об этом надёжные источники. Не опирайся только на память.
Ответ строго по схеме:
1. Что произошло: 1-2 предложения.
2. Вердикт: ПОДТВЕРЖДЕНО / НЕ ПОДТВЕРЖДЕНО / ПОХОЖЕ НА ФЕЙК. Одной строкой объясни почему.
3. Источники: какие надёжные издания это подтверждают или почему подтверждение не нашлось.
4. Возможное влияние на рынок: это предположение, а не торговый сигнал. Если уместно, назови, какие активы затронуты.
5. Что проверить самому: 1-2 пункта.
Если подтверждения нет, прямо пиши «не подтверждено». Ничего не выдумывай. Не давай советов купить или продать.`;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });

  const { text, code, prompt } = req.body || {};
  const custom = typeof prompt === "string" ? prompt.trim() : "";
  if (custom.length > 3000) return res.status(400).json({ error: "Свой промт слишком длинный, максимум 3000 символов" });
  const today = new Date().toISOString().slice(0, 10);

  const need = process.env.ACCESS_CODE;
  if (need && code !== need) return res.status(401).json({ error: "Неверный код доступа" });
  if (!text || typeof text !== "string" || !text.trim())
    return res.status(400).json({ error: "Вставьте текст новости или ссылку" });
  if (text.length > 4000) return res.status(400).json({ error: "Слишком длинно, максимум 4000 символов" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "На сервере не задан GEMINI_API_KEY" });
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: (custom || SYSTEM) + "\nСегодняшняя дата: " + today + "." }] },
          contents: [{ role: "user", parts: [{ text: text.trim() }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.2 },
        }),
      }
    );

    if (r.status === 429)
      return res.status(429).json({ error: "Лимит запросов исчерпан. Подождите минуту или до завтра." });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data?.error?.message || "Ошибка модели" });

    const cand = data.candidates && data.candidates[0];
    const answer = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("").trim();
    const chunks = (cand && cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
    const seen = new Set();
    const sources = chunks
      .filter((c) => c.web && c.web.uri && !seen.has(c.web.uri) && seen.add(c.web.uri))
      .map((c) => ({ title: c.web.title || c.web.uri, uri: c.web.uri }))
      .slice(0, 8);

    if (!answer) return res.status(502).json({ error: "Модель не вернула ответ. Попробуйте ещё раз." });
    return res.status(200).json({ answer, sources });
  } catch (e) {
    return res.status(500).json({ error: "Сбой сервера: " + e.message });
  }
};
