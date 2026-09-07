# Ava — Voice Personal Assistant

Hands-free assistant that takes natural voice requests, handles tasks, reminders and
questions, reads answers back aloud, and works against your Google Calendar and Gmail.

She has a face: a **photoreal person** streamed as live video, lip-synced to what she
says. A toggle in the header switches between **Face** and plain **Chat**.

- **Brain:** Claude Haiku 4.5 (`claude-haiku-4-5`) via the Anthropic Messages API, in a
  server-side tool-use loop.
- **Ears:** the browser's Web Speech API — speech recognition never leaves the device.
- **Face + voice (Face mode):** [D-ID](https://d-id.com) Talks Streams. A still portrait
  plus her reply text becomes a WebRTC video stream of a real-looking person speaking.
- **Voice (Chat mode):** ElevenLabs when `ELEVENLABS_API_KEY` is set, otherwise the
  browser's own speech synthesis.
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

4. **Her face** — get an API key at [studio.d-id.com](https://studio.d-id.com) (Account →
   API Key) and set it:

   ```
   DID_API_KEY=...
   ```

   Without it, Face mode shows a note and Chat mode still works normally.

   The portrait she wears ships at `public/face.png` and is uploaded to D-ID the first
   time she is needed. To change her, click **Change face** in the app and pick another
   photo — front-facing, one face, eyes open, cropped close to the head. It must be your
   own photo, someone who agreed, or an AI-generated face.

5. **Chat-mode voice (optional).** An [ElevenLabs](https://elevenlabs.io/app/settings/api-keys)
   key in `ELEVENLABS_API_KEY` gives a natural voice in Chat mode. Without it the app
   falls back to the browser voice — nothing breaks, it just sounds robotic. The key only
   needs **Text to Speech** access.

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
  api/did/route.ts               D-ID stream lifecycle: create, sdp, ice, talk, close
  api/did/face/route.ts          Portrait upload; caches the D-ID image URL
  api/tts/route.ts               ElevenLabs proxy for Chat mode (501 = fall back)
  api/auth/google/…              OAuth start + callback; tokens go in the session cookie
  api/session/route.ts           Connection status for the UI
lib/
  tools.ts                       Tool schemas + executors (Calendar, Gmail, reminders)
  google.ts                      OAuth URLs, token exchange/refresh, authorised fetch
  did.ts                         D-ID REST client; the API key never leaves the server
  session.ts                     AES-256-GCM encrypted, httpOnly session cookie
  cards.ts                       Turns tool output into structured cards for the UI
  reminders.ts                   JSON-file reminder store (data/reminders.json)
components/
  VoiceAssistant.tsx             Mic, transcript, mode switching, hands-free loop
  useDidStream.ts                WebRTC peer connection and speak/idle state
  FaceStage.tsx                  Video stage, portrait fallback, face upload
  Cards.tsx                      Calendar / inbox / reminder / confirmation cards
public/face.png                  The portrait she wears by default
```

The chat route is stateless: the browser keeps the plain-text conversation and posts the
last 20 turns with each request. Tool calls run entirely server-side within one request,
so the Google access token never reaches the browser. The D-ID stream is opened on her
first reply and reused, since an open stream is what costs credits.

### Safety rails

- `send_email`, `delete_calendar_event` and calendar invites are described to the model as
  irreversible; the system prompt requires it to read the details back and get an explicit
  yes in a *previous* turn before calling them.
- `create_email_draft` is the offered fallback whenever the user hesitates.
- Google tokens live only in an encrypted `httpOnly` cookie keyed by `SESSION_SECRET`.
- The D-ID and ElevenLabs keys stay server-side; the browser only ever sees SDP, ICE
  candidates and a video track.

## Notes

- `data/` holds local state (reminders, the cached D-ID portrait URL) and is gitignored.
  Swap `lib/reminders.ts` for a real database when deploying for more than one user.
- Deploying: set `APP_URL` and `GOOGLE_REDIRECT_URI` to the production origin, and add
  that callback URL in Google Cloud Console as well.
- Costs: Haiku 4.5 is $1 / $5 per million input / output tokens — a typical exchange is a
  fraction of a cent. D-ID bills per minute of streamed video and is the expensive part;
  Chat mode costs nothing beyond the model.
- Face mode needs WebRTC. If a network blocks it, Chat mode still works everywhere.
