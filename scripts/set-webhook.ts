// Usage: npm run set-webhook -- https://<app host>/telegram/webhook
// Points the Telegram bot at the given webhook URL (the app's Hono route),
// using TELEGRAM_WEBHOOK_SECRET as the secret token, then prints the result
// of getWebhookInfo so you can check it.
const url = process.argv[2]
if (!url) {
  console.error('Usage: npm run set-webhook -- https://<app host>/telegram/webhook')
  process.exit(1)
}

const token = process.env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOR_TOKEN
const secret = process.env.TELEGRAM_WEBHOOK_SECRET
if (!token || !secret) {
  console.error('TELEGRAM_BOR_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set in .env')
  process.exit(1)
}

const api = (method: string, body?: unknown) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json())

console.log(
  'setWebhook:',
  await api('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message'],
  })
)

console.log('getWebhookInfo:', (await api('getWebhookInfo') as { result?: unknown }).result)
