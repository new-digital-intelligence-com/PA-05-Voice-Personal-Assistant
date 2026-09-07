# Ava — Voice Personal Assistant

Hands-free assistant that takes natural voice requests, handles tasks, reminders and
questions, reads answers back aloud, and works against your Google Calendar and Gmail.

She has a face: a **photoreal person** streamed as live video, lip-synced to what she
says. A toggle in the header switches between **Face** and plain **Chat**.

- **Brain:** Claude Haiku 4.5 (`claude-haiku-4-5`) via the Anthropic Messages API, in a
  server-side tool-use loop.
- **Ears:** the browser's Web Speech API — speech recognition never leaves the device.
- **Face (Face mode):** [Simli](https://simli.com). Her voice is streamed to Simli as raw
  PCM and comes back as a WebRTC video of a real-looking person lip-syncing to it — one
  continuous stream, not a clip per sentence.
- **Voice:** ElevenLabs. Required for Face mode (Simli needs audio to animate); in Chat
  mode it falls back to the browser's own speech synthesis when no key is set.
- **Hands:** Google Calendar + Gmail REST APIs, called with the signed-in user's OAuth
  token, plus a small local reminders store.
- **Answers:** spoken as short prose, and shown as cards — calendar rows, inbox rows,
  reminders, confirmations — rather than a wall of text.

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

4. **Her face** — at [app.simli.com](https://app.simli.com): copy your **API key**, then
   click **Create Avatar** and upload a portrait to get a **face ID**. The photo should be
   front-facing with one face and eyes open, and must be your own, someone who agreed, or
   an AI-generated face. Put both in `.env.local`:

   ```
   SIMLI_API_KEY=...
   SIMLI_FACE_ID=...
   ```

   Without them, Face mode shows a note and Chat mode still works normally. The still
   portrait shown before the stream connects is `public/face.png` — replace it with the
   same photo you gave Simli.

5. **Her voice** — an [ElevenLabs](https://elevenlabs.io/app/settings/api-keys) key in
   `ELEVENLABS_API_KEY`. Face mode needs it: Simli animates audio, so without speech there
   is nothing to lip-sync. Chat mode falls back to the browser voice without it. The key
   only needs **Text to Speech** access.

6. Run it:

   ```bash
   npm run dev
   ```

   Open http://localhost:3000 in **Chrome or Edge** (Safari and Firefox do not ship the
   speech-recognition half of the Web Speech API — the typed input still works there),
   tap **Connect Google**, then talk.

## Using it

- **Face / Chat** — the header toggle. Face streams her as video; Chat is a plain
  voice-to-text transcript. The choice is remembered.
- **Tap to talk** — one utterance, then she answers aloud.
- **Hands-free** — the mic re-opens after every reply, so you can keep talking while
  driving or cooking. Tap it again to stop.
- **Voice on/off** — mutes her reply without muting the mic.
- Answers appear as cards beside her, so nothing important is spoken-only.

What she handles today:

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
  api/simli/route.ts             Simli session token + ICE servers (key stays server-side)
  api/tts/route.ts               ElevenLabs proxy — mp3 for Chat, PCM16 for Simli
  api/auth/google/…              OAuth start + callback; tokens go in the session cookie
  api/session/route.ts           Connection status for the UI
lib/
  tools.ts                       Tool schemas + executors (Calendar, Gmail, reminders)
  google.ts                      OAuth URLs, token exchange/refresh, authorised fetch
  simli.ts                       Simli session creation; the API key never leaves the server
  session.ts                     AES-256-GCM encrypted, httpOnly session cookie
  cards.ts                       Turns tool output into structured cards for the UI
  reminders.ts                   JSON-file reminder store (data/reminders.json)
components/
  VoiceAssistant.tsx             Mic, transcript, mode switching, hands-free loop
  useSimliStream.ts              Simli session, PCM streaming, speak/idle state
  FaceStage.tsx                  Video stage with the still portrait behind it
  Cards.tsx                      Calendar / inbox / reminder / confirmation cards
public/face.png                  Still portrait shown until the live face connects
```

The chat route is stateless: the browser keeps the plain-text conversation and posts the
last 20 turns with each request. Tool calls run entirely server-side within one request,
so the Google access token never reaches the browser. The Simli session is opened as
soon as Face mode loads and held open, so she is always ready to speak.

### Safety rails

- `send_email`, `delete_calendar_event` and calendar invites are described to the model as
  irreversible; the system prompt requires it to read the details back and get an explicit
  yes in a *previous* turn before calling them.
- `create_email_draft` is the offered fallback whenever the user hesitates.
- Google tokens live only in an encrypted `httpOnly` cookie keyed by `SESSION_SECRET`.
- The Simli and ElevenLabs keys stay server-side; the browser only ever receives a
  short-lived session token and the media stream.

## Notes

- `data/` holds local state (reminders, the cached D-ID portrait URL) and is gitignored.
  Swap `lib/reminders.ts` for a real database when deploying for more than one user.
- Deploying: set `APP_URL` and `GOOGLE_REDIRECT_URI` to the production origin, and add
  that callback URL in Google Cloud Console as well.
- Costs: Haiku 4.5 is $1 / $5 per million input / output tokens — a typical exchange is a
  fraction of a cent. Simli bills per minute of streamed video and ElevenLabs per
  character; Chat mode without an ElevenLabs key costs nothing beyond the model.
- `simli-client` 3.0.2 ships `dist/client.js` but its index re-exports `"./Client"`, which
  only resolves on case-insensitive filesystems. `useSimliStream.ts` imports the module
  directly to stay portable.
- Face mode needs WebRTC. If a network blocks it, Chat mode still works everywhere.
