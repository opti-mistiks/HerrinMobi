# Worts News — GitHub Actions

Автоматичне оновлення новин кожні 12 годин через GitHub Actions + Groq AI.
iOS-додаток читає готовий JSON прямо з GitHub.

## Налаштування (5 хвилин)

### 1. Додай API ключ
**Settings → Secrets and variables → Actions → New repository secret**
```
Name:  GROQ_API_KEY
Value: gsk_xxxxxxxxxxxxxxxxxxxxxxxx
```

### 2. Перший запуск
**Actions → Update News → Run workflow**
Перший раз займе ~10 хвилин (обробляє всі статті).

### 3. URL для iOS
Після першого запуску JSON доступний за адресою:
```
https://raw.githubusercontent.com/ТВІ_ЮЗЕРНЕЙМ/НАЗВА_РЕПО/main/data/articles.json
```

Або окремо по рівнях через API (якщо додаси сервер), або читай увесь JSON і фільтруй на клієнті.

## Розклад
- Кожен день о **6:00** і **18:00 UTC** (8:00 і 20:00 за Швейцарським часом)
- Або вручну: **Actions → Update News → Run workflow**

## Структура JSON
```json
{
  "A1": [
    {
      "id": "abc12345",
      "originalTitle": "Bundesrat beschliesst neue Massnahmen",
      "simplifiedText": "Der Bundesrat macht neue Regeln...",
      "vocabularyHints": ["die Massnahme, -n — захід", "beschliessen — вирішувати"],
      "category": "Politik",
      "imageUrl": "https://...",
      "publishedAt": "2024-06-21T08:30:00.000Z",
      "processedAt": "2024-06-21T06:05:00.000Z"
    }
  ],
  "A2": [...],
  "B1": [...],
  "updatedAt": "2024-06-21T06:10:00.000Z"
}
```
