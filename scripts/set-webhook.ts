// Usage: npm run set-webhook -- https://your-public-host
// Registers <host>/telegram/webhook with Telegram, using TELEGRAM_WEBHOOK_SECRET.
const base = process.argv[2]
if (!base) {
  console.error('Usage: npm run set-webhook -- https://your-public-host')
  process.exit(1)
}

const token = process.env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOR_TOKEN
const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: new URL('/telegram/webhook', base).toString(),
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message'],
  }),
})
console.log(await res.json())
