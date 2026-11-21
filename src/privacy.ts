// Public privacy policy at GET /privacy (Meta requires a Privacy Policy URL to
// publish the WhatsApp app "holler"). Keep it in line with what the code
// actually stores and who processes it; update the date when it changes.
const UPDATED = '21 November 2026'
const CONTACT = 'hardhaven4@gmail.com'

export const privacyPolicyHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Holler – Privacy Policy</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #5f6368; --bg: #ffffff; --line: #e3e3e3; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececec; --muted: #a0a0a0; --bg: #161616; --line: #2c2c2c; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 40px 16px 64px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  h2 { font-size: 19px; margin: 32px 0 8px; padding-top: 16px; border-top: 1px solid var(--line); }
  p, li { margin: 6px 0; }
  .muted { color: var(--muted); }
  a { color: inherit; }
</style>
</head>
<body>
<main>
<h1>Holler – Privacy Policy</h1>
<p class="muted">Last updated: ${UPDATED}</p>

<p>Holler is a personal assistant you chat with on WhatsApp, Telegram and iMessage. This policy explains what information we keep when you use it, why, who helps us process it, and how you can have it deleted.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Your phone number</strong> and your account ID on each chat app you use (for example your Telegram user ID or WhatsApp ID). Your phone number is your account: the same number on WhatsApp, Telegram and iMessage is one account.</li>
  <li><strong>Your messages and our replies</strong>, so the assistant can remember the conversation.</li>
  <li><strong>Files you send</strong> (documents, photos, audio, video) and files the assistant makes for you.</li>
  <li><strong>Payment records</strong> for Pro: the M-Pesa number you paid from, amount, date, status and M-Pesa receipt number. We never see or store your M-Pesa PIN.</li>
  <li><strong>Technical logs</strong>: message IDs, timings and error details, used to keep the service running. These do not contain your message text, files or phone number.</li>
</ul>

<h2>How we use it</h2>
<ul>
  <li>To answer your messages, including looking things up on the web for you when a question needs current information.</li>
  <li>To work with the files you send and send files back to you.</li>
  <li>To give you access to Pro and record your payments.</li>
  <li>To fix problems and prevent abuse.</li>
</ul>
<p>We do not sell your information and do not use it for advertising.</p>

<h2>Who processes it for us</h2>
<p>We use these services to run Holler. Each receives only what it needs:</p>
<ul>
  <li><strong>Anthropic</strong> (Claude): generates the assistant's replies, so it receives your messages and recent conversation.</li>
  <li><strong>Meta</strong> (WhatsApp), <strong>Telegram</strong> and <strong>Linq</strong> (iMessage): deliver messages between you and Holler.</li>
  <li><strong>Paystack</strong> and <strong>Safaricom M-Pesa</strong>: process payments.</li>
  <li><strong>Clerk</strong>: stores your account (phone number and account ID).</li>
  <li><strong>Neon</strong> (database), <strong>Railway</strong> (servers and conversation storage) and <strong>Inngest</strong> (runs the steps that answer each message).</li>
  <li><strong>Daytona</strong>: a private workspace where your files are opened, converted and created.</li>
  <li><strong>Firecrawl</strong>: fetches web pages and live data when the assistant looks something up; it receives the search or page, not your conversation.</li>
  <li><strong>Sentry</strong>: error monitoring; receives technical logs only, without message text, files or phone numbers.</li>
</ul>
<p>Some of these services are outside Kenya, so your information may be processed in other countries.</p>

<h2>How long we keep it</h2>
<ul>
  <li>Your conversation history is kept until you ask us to delete it. The assistant only reads the most recent part of it when replying.</li>
  <li>Files in your workspace are deleted automatically about three days after your last use.</li>
  <li>Payment records are kept as long as needed for accounting and to resolve disputes.</li>
  <li>Your account is kept until you ask us to delete it.</li>
</ul>

<h2>Your rights</h2>
<p>You can ask us to show you, correct, or delete your information, or to stop using it. Email <a href="mailto:${CONTACT}">${CONTACT}</a> from the email address you want us to reply to, and tell us the phone number you use with Holler. We may ask you to confirm the request from that number. We will reply within 30 days.</p>
<p>If you are in Kenya, you also have rights under the Data Protection Act, 2019, and can complain to the Office of the Data Protection Commissioner.</p>

<h2>Children</h2>
<p>Holler is not intended for children under 18.</p>

<h2>Changes</h2>
<p>If we change this policy, we will update the date above. For significant changes, we will tell you in the chat.</p>

<h2>Contact</h2>
<p><a href="mailto:${CONTACT}">${CONTACT}</a></p>
</main>
</body>
</html>`
