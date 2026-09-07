# Ava — Voice Personal Assistant

Hands-free assistant that takes natural voice requests, handles tasks, reminders and
questions, reads answers back aloud, and works against your Google Calendar and Gmail.

- **Brain:** Claude Haiku 4.5 (`claude-haiku-4-5`) via the Anthropic Messages API, in a
  server-side tool-use loop.
- **Ears / voice:** the browser's Web Speech API — speech recognition in, speech
  synthesis out. No audio leaves the device, and no extra API cost.
- **Hands:** Google Calendar + Gmail REST APIs, called with the signed-in user's OAuth
  token, plus a small local reminders store.

## Setup

1. **Anthropic key** — put yours in `.env.local`:

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```

2. **Google OAuth redirect URI** — in Google Cloud Console → APIs & Services →
   Credentials → your Web application client, add this to *Authorised redirect URIs*:

   ```
   http://localhost:3000/api/auth/google/callback
   ```

   While the consent screen is in *Testing*, also add your Google account under
   *OAuth consent screen → Test users*.

3. **Enable the APIs** in the same project: Gmail API and Google Calendar API.

4. Run it:

   ```bash
   npm run dev
   ```

   Open http://localhost:3000 in **Chrome or Edge** (Safari and Firefox do not ship the
   speech-recognition half of the Web Speech API — the typed input still works there),
   tap **Connect Google**, then talk.

## Using it

- **Tap to talk** — one utterance, then Ava answers aloud.
- **Hands-free** — Ava re-opens the mic after every reply, so you can keep talking while
  driving or cooking. Tap again to stop.
- **Voice on/off** — mutes the spoken reply without muting the mic.
- Every action Ava took appears as a chip under her reply ("read your calendar", "sent an
  email"), so nothing happens invisibly.

What it handles today:

| Ask | What happens |
| --- | --- |
| "What's on my calendar tomorrow?" | Reads your primary calendar for the range |
| "Book a dentist appointment Friday at 3." | Confirms the details, then creates the event |
| "Cancel my 4pm." | Finds the event and deletes it after you confirm |
| "Any unread mail from Priya this week?" | Gmail search, read back as a summary |
| "Read me the second one." | Fetches and reads the message body |
| "Reply that I'll be there." | Reads the draft back, sends only on an explicit yes |
| "Remind me to call mum tonight." | Saved to the local reminder list |
| "What are my reminders?" | Reads them back |

## How it's put together

```
app/
  page.tsx                       Renders the assistant
  api/chat/route.ts              Claude Haiku tool-use loop (max 8 iterations)
  api/auth/google/route.ts       Starts the OAuth consent flow
  api/auth/google/callback/      Exchanges the code, stores tokens in the session cookie
  api/session/route.ts           Connection status for the UI
lib/
  tools.ts                       Tool schemas + executors (Calendar, Gmail, reminders)
  google.ts                      OAuth URLs, token exchange/refresh, authorised fetch
  session.ts                     AES-256-GCM encrypted, httpOnly session cookie
  reminders.ts                   JSON-file reminder store (data/reminders.json)
components/VoiceAssistant.tsx    Mic, transcript, speech synthesis, hands-free loop
```

The chat route is stateless: the browser keeps the plain-text conversation and posts the
last 20 turns with each request. Tool calls run entirely server-side within one request,
so the Google access token never reaches the browser.

### Safety rails

- `send_email`, `delete_calendar_event` and calendar invites are described to the model as
  irreversible; the system prompt requires it to read the details back and get an explicit
  yes in a *previous* turn before calling them.
- `create_email_draft` is the offered fallback whenever the user hesitates.
- Google tokens live only in an encrypted `httpOnly` cookie keyed by `SESSION_SECRET`.

## Notes

- `data/reminders.json` is local to the machine and gitignored. Swap `lib/reminders.ts`
  for a real database when deploying for more than one user.
- Deploying: set `APP_URL` and `GOOGLE_REDIRECT_URI` to the production origin, and add
  that callback URL in Google Cloud Console as well.
- Cost: Haiku 4.5 is $1 / $5 per million input / output tokens — a typical exchange with
  one or two tool calls is a fraction of a cent.
