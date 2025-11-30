# Live Conversation Test UI

A simple frontend UI to test the live conversation backend functionality.

## How to Use

1. **Start your server:**

   ```bash
   npm run dev
   ```

2. **Open the test UI:**

   - Navigate to: `http://localhost:5000/test-live-conversation.html`
   - Or open the file directly in your browser

3. **Get your JWT Token:**

   - Login via your auth endpoint:
     ```bash
     curl -X POST http://localhost:5000/api/auth/login \
       -H "Content-Type: application/json" \
       -d '{"email":"your@email.com","password":"yourpassword"}'
     ```
   - Copy the `token` from the response

4. **Test the Backend:**
   - Enter your JWT token in the "JWT Token" field
   - Enter a valid Pitch Deck ID
   - Click "1. Login / Verify Token" to verify your token
   - Click "2. Start Session" to create a new live conversation session
   - Click "3. Connect WebSocket" to establish WebSocket connection
   - Use "Send Mock Audio" or "Start Mic" to test audio streaming
   - Watch transcriptions and suggestions appear in real-time
   - Click "4. Stop Session" when done

## Features

- ✅ **REST API Testing**: Start, stop, and manage sessions
- ✅ **WebSocket Testing**: Real-time connection and event handling
- ✅ **Audio Testing**: Mock audio or real microphone capture
- ✅ **Live Transcripts**: See transcriptions appear in real-time
- ✅ **AI Suggestions**: View question suggestions as they're generated
- ✅ **Session Management**: View session details and full transcripts

## Testing Flow

1. **Login** → Verify your JWT token is valid
2. **Start Session** → Creates a new live conversation session
3. **Connect WebSocket** → Establishes real-time connection
4. **Send Audio** → Test with mock audio or real microphone
5. **View Results** → See transcriptions and suggestions
6. **Stop Session** → Cleanly end the session

## Notes

- **Mock Audio**: Sends empty audio buffers (won't produce real transcriptions)
- **Real Audio**: Requires microphone permissions and will send actual audio to Deepgram
- **Suggestions**: Generated every 45 seconds when there's enough conversation context
- **Deepgram**: Requires valid `DEEPGRAM_API_KEY` in your `.env` file

## Troubleshooting

- **"Token invalid"**: Make sure you're using a fresh JWT token from login
- **"Session not found"**: Ensure you've started a session before connecting WebSocket
- **No transcriptions**: Check that `DEEPGRAM_API_KEY` is set and valid
- **WebSocket connection fails**: Check CORS settings and server URL
