// Public homepage at GET / . Meta checks the business website when setting up
// a production WhatsApp number (display name review, business profile), so the
// root URL has to open and describe the service. Keep it factual.
const CONTACT = 'hardhaven4@gmail.com'

export const homepageHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Holler – your assistant on WhatsApp, Telegram and iMessage</title>
<meta name="description" content="Holler is a Kenyan assistant you chat with on WhatsApp, Telegram and iMessage: travel, local services, reminders and everyday tasks, paid with M-Pesa.">
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #5f6368; --bg: #ffffff; --card: #f5f5f7; --accent: #128c4a; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececec; --muted: #a0a0a0; --bg: #141414; --card: #1f1f1f; --accent: #3ccf7d; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 56px 16px 64px; }
  h1 { font-size: 40px; line-height: 1.15; margin: 0 0 12px; }
  .lead { font-size: 20px; color: var(--muted); margin: 0 0 32px; }
  h2 { font-size: 20px; margin: 40px 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
  .card { background: var(--card); border-radius: 12px; padding: 16px; }
  .card strong { display: block; margin-bottom: 4px; }
  ol { padding-left: 20px; }
  a { color: var(--accent); }
  footer { margin-top: 56px; font-size: 14px; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>Holler</h1>
<p class="lead">Your assistant in the chat apps you already use – WhatsApp, Telegram and iMessage. Ask in plain words, get things done, pay with M-Pesa.</p>

<h2>What Holler helps with</h2>
<div class="grid">
  <div class="card"><strong>Travel</strong>Bus and train departures, fares and seats, and booking help across Kenya.</div>
  <div class="card"><strong>Local services</strong>Find businesses near you with ratings, opening hours and phone numbers.</div>
  <div class="card"><strong>Documents</strong>Send a PDF, photo or spreadsheet; get it read, edited or converted and sent back.</div>
  <div class="card"><strong>Everyday questions</strong>Prices, opening hours, news and what's available right now.</div>
</div>

<h2>How it works</h2>
<ol>
  <li>Send a message to Holler on WhatsApp, Telegram or iMessage.</li>
  <li>Your phone number is your account – the same on every app.</li>
  <li>Subscribe to Pro with an M-Pesa payment request sent straight to your phone.</li>
</ol>

<h2>Contact</h2>
<p>Questions or support: <a href="mailto:${CONTACT}">${CONTACT}</a></p>

<footer>
  <a href="/privacy">Privacy policy</a> · © 2026 Holler
</footer>
</main>
</body>
</html>`
