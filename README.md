# Discord Activity: Getting Started Guide

This template is used in the [Building An Activity](https://discord.com/developers/docs/activities/building-an-activity) tutorial in the Discord Developer Docs.

Read more about building Discord Activities with the Embedded App SDK at [https://discord.com/developers/docs/activities/overview](https://discord.com/developers/docs/activities/overview).

## Deploy на Vercel

### Підготовка
- Створи Discord Application та Activity у Discord Developer Portal. Візьми `Client ID` і створи `Client Secret`.
- Заповни локально `.env` на основі `example.env`.

### Змінні середовища у Vercel
У проекті на Vercel додай Environment Variables:
- `VITE_DISCORD_CLIENT_ID` — значення Client ID
- `DISCORD_CLIENT_SECRET` — значення Client Secret

Рекомендується зберігати їх як Encrypted (Vercel Secret) і прив’язати у розділі Project Settings → Environment Variables.

### Структура деплою
- Фронтенд (Vite) будується як статичний сайт у `client/dist` через `@vercel/static-build`.
- Серверна частина — функція `api/token.js` (Node on Vercel) для обміну OAuth `code` на `access_token`.

### Локальна розробка
```
cd client
npm i
npm run dev
```

Сервер Vercel functions локально не потрібен — у продакшені виклики йдуть на `/api/token`.

### Деплой
1. Встанови Vercel CLI (опційно):
```
npm i -g vercel
```
2. Залогінься та зв’яжи проект:
```
vercel login
vercel
```
3. Пропиши змінні середовища у Dashboard або через CLI:
```
vercel env add VITE_DISCORD_CLIENT_ID
vercel env add DISCORD_CLIENT_SECRET
```
4. Зроби продакшен деплой:
```
vercel deploy --prod
```

### CSP/вбудовування в Discord
`vercel.json` додає заголовки:
- `Content-Security-Policy: frame-ancestors https://discord.com https://*.discord.com;`
- `X-Frame-Options: ALLOW-FROM https://discord.com`

Це дозволяє відкривати Activity в iframe Discord.

