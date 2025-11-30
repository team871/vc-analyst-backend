# Complete Meeting Integration Guide

## Overview

This guide covers the complete integration for live pitch meeting sessions, including:
- Session management (start/stop)
- WebSocket real-time communication
- Audio capture and streaming
- Live transcription
- Live question generation
- Session summary and analysis

---

## Table of Contents

1. [HTTP API Endpoints](#http-api-endpoints)
2. [WebSocket Connection](#websocket-connection)
3. [WebSocket Events](#websocket-events)
4. [Audio Capture & Streaming](#audio-capture--streaming)
5. [Complete Integration Flow](#complete-integration-flow)
6. [Error Handling](#error-handling)
7. [Complete Examples](#complete-examples)

---

## HTTP API Endpoints

### 1. Start a Meeting Session

**Endpoint**: `POST /api/live-conversations/start`

**Headers**:
```
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

**Request Body**:
```json
{
  "pitchDeckId": "507f1f77bcf86cd799439011",
  "title": "Optional session title"
}
```

**Response** (201 Created):
```json
{
  "sessionId": "507f1f77bcf86cd799439012",
  "wsToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "message": "Session started successfully"
}
```

**Example**:
```javascript
async function startSession(pitchDeckId, title = null) {
  const response = await fetch("/api/live-conversations/start", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getAuthToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pitchDeckId,
      title,
    }),
  });

  if (response.ok) {
    const data = await response.json();
    return {
      sessionId: data.sessionId,
      wsToken: data.wsToken, // Use this for WebSocket authentication
    };
  }
  throw new Error("Failed to start session");
}
```

---

### 2. Get Session Details

**Endpoint**: `GET /api/live-conversations/:sessionId`

**Headers**:
```
Authorization: Bearer <JWT_TOKEN>
```

**Response** (200 OK):
```json
{
  "sessionId": "507f1f77bcf86cd799439012",
  "title": "Live conversation - Pitch Deck Title",
  "pitchDeck": {
    "_id": "507f1f77bcf86cd799439011",
    "title": "Pitch Deck Title"
  },
  "status": "ACTIVE",
  "createdAt": "2024-01-15T10:00:00.000Z",
  "endedAt": null,
  "totalDuration": 3600,
  "transcriptCount": 150,
  "suggestionCount": 12,
  "summary": null,
  "detectedLanguages": ["en"]
}
```

---

### 3. Stop a Meeting Session

**Endpoint**: `POST /api/live-conversations/:sessionId/stop`

**Headers**:
```
Authorization: Bearer <JWT_TOKEN>
```

**Response** (200 OK):
```json
{
  "sessionId": "507f1f77bcf86cd799439012",
  "endedAt": "2024-01-15T11:00:00.000Z",
  "totalDuration": 3600,
  "transcriptCount": 150,
  "summary": {
    "content": "Meeting summary text...",
    "keyPoints": ["Point 1", "Point 2"],
    "actionItems": ["Action 1", "Action 2"],
    "generatedAt": "2024-01-15T11:00:05.000Z"
  },
  "detectedLanguages": ["en"]
}
```

**Note**: This endpoint:
- Stops the session
- Transcribes the complete audio with speaker diarization
- Generates a meeting summary
- Returns the final session data

**Example**:
```javascript
async function stopSession(sessionId) {
  const response = await fetch(
    `/api/live-conversations/${sessionId}/stop`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getAuthToken()}`,
      },
    }
  );

  if (response.ok) {
    const data = await response.json();
    console.log("Session stopped:", data);
    console.log("Summary:", data.summary);
    return data;
  }
  throw new Error("Failed to stop session");
}
```

---

### 4. Mark Question as Answered

**Endpoint**: `PATCH /api/live-conversations/:sessionId/questions/:questionId/answered`

**Headers**:
```
Authorization: Bearer <JWT_TOKEN>
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Question marked as answered",
  "session": {
    "suggestedQuestions": [...]
  }
}
```

---

### 5. Delete Question

**Endpoint**: `DELETE /api/live-conversations/:sessionId/questions/:questionId`

**Headers**:
```
Authorization: Bearer <JWT_TOKEN>
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Question deleted"
}
```

---

## WebSocket Connection

### Connection Setup

```javascript
import { io } from "socket.io-client";

// Connect to WebSocket server
const socket = io(API_BASE_URL, {
  auth: {
    token: wsToken, // Token from start session endpoint
  },
  transports: ["websocket", "polling"], // Fallback to polling if websocket fails
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: 5,
});

// Connection events
socket.on("connect", () => {
  console.log("WebSocket connected:", socket.id);
});

socket.on("disconnect", (reason) => {
  console.log("WebSocket disconnected:", reason);
  // Handle reconnection logic
});

socket.on("connect_error", (error) => {
  console.error("WebSocket connection error:", error);
});
```

---

## WebSocket Events

### Client → Server Events

#### 1. `join-session`

**Purpose**: Join a meeting session and initialize connection

**Payload**:
```typescript
{
  sessionId: string; // Session ID from start endpoint
}
```

**Example**:
```javascript
socket.emit("join-session", {
  sessionId: "507f1f77bcf86cd799439012",
});
```

---

#### 2. `audio-chunk`

**Purpose**: Send audio data chunks for transcription

**Payload**:
```typescript
{
  sessionId: string;
  audioData: ArrayBuffer | Uint8Array | Buffer; // PCM audio data
}
```

**Audio Format Requirements**:
- **Sample Rate**: 16000 Hz
- **Channels**: 1 (mono)
- **Bit Depth**: 16-bit
- **Format**: PCM (raw audio data)

**Example**:
```javascript
// Send audio chunk
socket.emit("audio-chunk", {
  sessionId: currentSessionId,
  audioData: audioBuffer, // ArrayBuffer or Uint8Array
});
```

---

#### 3. `ping`

**Purpose**: Keep connection alive (optional)

**Example**:
```javascript
// Server responds with "pong"
socket.emit("ping");
```

---

### Server → Client Events

#### 1. `session-status`

**When**: Emitted after joining a session

**Payload**:
```typescript
{
  status: "connected" | "error";
  message: string;
  sessionId: string;
}
```

**Example**:
```javascript
socket.on("session-status", (data) => {
  console.log("Session status:", data.status);
  console.log("Message:", data.message);
  // "Ready to record. Start microphone to begin."
});
```

---

#### 2. `recording-status`

**When**: Emitted every 5 seconds during recording

**Payload**:
```typescript
{
  status: "recording";
  audioSizeMB: number;
  audioChunks: number;
  estimatedDurationSeconds: number;
  message: string;
}
```

**Example**:
```javascript
socket.on("recording-status", (data) => {
  console.log(`Recording: ${data.audioSizeMB}MB (${data.estimatedDurationSeconds}s)`);
  updateRecordingUI(data);
});
```

---

#### 3. `transcription`

**When**: Emitted when live transcription is available

**Payload**:
```typescript
{
  text: string;
  isFinal: boolean;
  timestamp: number;
  speaker: string | null;
  speakerId: number | null;
  languageCode: string | null;
}
```

**Example**:
```javascript
socket.on("transcription", (data) => {
  console.log("Transcript:", data.text);
  console.log("Final:", data.isFinal);
  console.log("Speaker:", data.speaker);
  
  // Display transcript in UI
  displayTranscript(data);
});
```

---

#### 4. `suggestion`

**When**: Emitted when initial questions are generated

**Payload**:
```typescript
{
  questions: Array<{
    id: string;
    question: string;
    answered: boolean;
    createdAt: Date;
    answeredAt: Date | null;
  }>;
  context: string;
  topics: string[];
  timestamp: number;
}
```

**Example**:
```javascript
socket.on("suggestion", (data) => {
  console.log("Initial questions:", data.questions);
  updateQuestionsList(data.questions);
});
```

---

#### 5. `suggested-questions-updated`

**When**: 
- Emitted when new questions are generated (every 60 seconds)
- Emitted when a question is marked as answered/deleted

**Payload**:
```typescript
{
  questions: Array<{
    id: string;
    question: string;
    answered: boolean;
    createdAt: Date;
    answeredAt: Date | null;
  }>;
}
```

**Important**: This contains the **complete list** of all active questions (newest first)

**Example**:
```javascript
socket.on("suggested-questions-updated", (data) => {
  // Replace entire questions list
  updateQuestionsList(data.questions);
});
```

---

#### 6. `error`

**When**: Emitted on errors

**Payload**:
```typescript
{
  message: string;
  code: string;
}
```

**Error Codes**:
- `SESSION_NOT_FOUND` - Session doesn't exist
- `SESSION_INACTIVE` - Session is not active
- `INVALID_SESSION` - Invalid session ID
- `OPENAI_API_KEY_MISSING` - OpenAI API key not configured
- `TRANSCRIPTION_ERROR` - Transcription failed
- `TRANSCRIPTION_DISCONNECTED` - Transcription connection lost

**Example**:
```javascript
socket.on("error", (error) => {
  console.error("Error:", error.message, error.code);
  handleError(error);
});
```

---

#### 7. `pong`

**When**: Response to `ping` event

**Payload**:
```typescript
{
  timestamp: number;
}
```

---

## Audio Capture & Streaming

### Browser Audio Capture

```javascript
class AudioCapture {
  constructor(sessionId, socket) {
    this.sessionId = sessionId;
    this.socket = socket;
    this.mediaStream = null;
    this.audioContext = null;
    this.processor = null;
    this.isRecording = false;
  }

  async start() {
    try {
      // Get user media
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      // Create audio context
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000,
      });

      const source = this.audioContext.createMediaStreamSource(this.mediaStream);

      // Create script processor for audio chunks
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (e) => {
        if (!this.isRecording) return;

        const inputData = e.inputBuffer.getChannelData(0);
        
        // Convert Float32Array to Int16Array (PCM)
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          // Clamp and convert to 16-bit integer
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Send audio chunk via WebSocket
        this.socket.emit("audio-chunk", {
          sessionId: this.sessionId,
          audioData: pcmData.buffer, // ArrayBuffer
        });
      };

      source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this.isRecording = true;
      console.log("Recording started");
    } catch (error) {
      console.error("Error starting audio capture:", error);
      throw error;
    }
  }

  stop() {
    this.isRecording = false;

    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    console.log("Recording stopped");
  }
}
```

### Alternative: MediaRecorder API

```javascript
class MediaRecorderCapture {
  constructor(sessionId, socket) {
    this.sessionId = sessionId;
    this.socket = socket;
    this.mediaRecorder = null;
    this.isRecording = false;
  }

  async start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
        },
      });

      // Note: MediaRecorder may not support PCM directly
      // You may need to convert the recorded audio
      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
      });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          // Convert to PCM format before sending
          // This requires additional processing
          this.sendAudioChunk(event.data);
        }
      };

      this.mediaRecorder.start(100); // Collect data every 100ms
      this.isRecording = true;
    } catch (error) {
      console.error("Error starting recording:", error);
      throw error;
    }
  }

  stop() {
    if (this.mediaRecorder) {
      this.mediaRecorder.stop();
      this.mediaRecorder.stream.getTracks().forEach((track) => track.stop());
      this.mediaRecorder = null;
    }
    this.isRecording = false;
  }
}
```

---

## Complete Integration Flow

### Step-by-Step Flow

```
1. Start Session
   ↓
   POST /api/live-conversations/start
   ↓
   Receive: { sessionId, wsToken }
   ↓
2. Connect WebSocket
   ↓
   io(API_URL, { auth: { token: wsToken } })
   ↓
3. Join Session
   ↓
   socket.emit("join-session", { sessionId })
   ↓
   Receive: "session-status" → "connected"
   ↓
4. Start Audio Capture
   ↓
   navigator.mediaDevices.getUserMedia()
   ↓
5. Stream Audio Chunks
   ↓
   socket.emit("audio-chunk", { sessionId, audioData })
   ↓
   Receive: "transcription" (live transcripts)
   ↓
   Receive: "recording-status" (every 5 seconds)
   ↓
   Receive: "suggestion" (initial questions)
   ↓
   Receive: "suggested-questions-updated" (every 60 seconds)
   ↓
6. Stop Session
   ↓
   POST /api/live-conversations/:sessionId/stop
   ↓
   Receive: { summary, transcriptCount, ... }
   ↓
7. Disconnect WebSocket
   ↓
   socket.disconnect()
```

---

## Complete Examples

### React/TypeScript Complete Example

```typescript
import { useEffect, useState, useRef } from "react";
import { io, Socket } from "socket.io-client";

interface Question {
  id: string;
  question: string;
  answered: boolean;
  createdAt: Date;
  answeredAt: Date | null;
}

interface Transcript {
  text: string;
  isFinal: boolean;
  timestamp: number;
  speaker: string | null;
}

export function LiveMeetingComponent({ pitchDeckId }: { pitchDeckId: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [wsToken, setWsToken] = useState<string | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [recordingStatus, setRecordingStatus] = useState<any>(null);
  const [sessionStatus, setSessionStatus] = useState<string>("");
  
  const audioCaptureRef = useRef<any>(null);

  // Start session
  const startSession = async () => {
    try {
      const response = await fetch("/api/live-conversations/start", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getAuthToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ pitchDeckId }),
      });

      if (response.ok) {
        const data = await response.json();
        setSessionId(data.sessionId);
        setWsToken(data.wsToken);
        return data;
      }
      throw new Error("Failed to start session");
    } catch (error) {
      console.error("Error starting session:", error);
    }
  };

  // Initialize WebSocket
  useEffect(() => {
    if (!wsToken || !sessionId) return;

    const newSocket = io(API_BASE_URL, {
      auth: { token: wsToken },
      transports: ["websocket", "polling"],
    });

    // Connection events
    newSocket.on("connect", () => {
      console.log("WebSocket connected");
      newSocket.emit("join-session", { sessionId });
    });

    newSocket.on("disconnect", () => {
      console.log("WebSocket disconnected");
    });

    // Session status
    newSocket.on("session-status", (data) => {
      console.log("Session status:", data);
      setSessionStatus(data.message);
    });

    // Recording status
    newSocket.on("recording-status", (data) => {
      setRecordingStatus(data);
    });

    // Live transcription
    newSocket.on("transcription", (data) => {
      setTranscripts((prev) => [...prev, data]);
    });

    // Initial questions
    newSocket.on("suggestion", (data) => {
      console.log("Initial questions:", data);
      setQuestions(data.questions);
    });

    // Live question updates
    newSocket.on("suggested-questions-updated", (data) => {
      console.log("Questions updated:", data.questions.length);
      setQuestions(data.questions);
    });

    // Error handling
    newSocket.on("error", (error) => {
      console.error("WebSocket error:", error);
      alert(`Error: ${error.message}`);
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, [wsToken, sessionId]);

  // Start recording
  const startRecording = async () => {
    if (!sessionId || !socket) return;

    try {
      const capture = new AudioCapture(sessionId, socket);
      await capture.start();
      audioCaptureRef.current = capture;
      setIsRecording(true);
    } catch (error) {
      console.error("Error starting recording:", error);
      alert("Failed to start recording. Please check microphone permissions.");
    }
  };

  // Stop recording
  const stopRecording = () => {
    if (audioCaptureRef.current) {
      audioCaptureRef.current.stop();
      audioCaptureRef.current = null;
      setIsRecording(false);
    }
  };

  // Stop session
  const stopSession = async () => {
    if (!sessionId) return;

    stopRecording();

    try {
      const response = await fetch(
        `/api/live-conversations/${sessionId}/stop`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${getAuthToken()}`,
          },
        }
      );

      if (response.ok) {
        const data = await response.json();
        console.log("Session stopped:", data);
        console.log("Summary:", data.summary);
        alert("Session stopped. Summary generated.");
      }
    } catch (error) {
      console.error("Error stopping session:", error);
    }
  };

  // Mark question as answered
  const markAsAnswered = async (questionId: string) => {
    if (!sessionId) return;

    try {
      const response = await fetch(
        `/api/live-conversations/${sessionId}/questions/${questionId}/answered`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${getAuthToken()}`,
          },
        }
      );

      if (response.ok) {
        console.log("Question marked as answered");
      }
    } catch (error) {
      console.error("Error:", error);
    }
  };

  // Delete question
  const deleteQuestion = async (questionId: string) => {
    if (!sessionId) return;

    try {
      const response = await fetch(
        `/api/live-conversations/${sessionId}/questions/${questionId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${getAuthToken()}`,
          },
        }
      );

      if (response.ok) {
        console.log("Question deleted");
      }
    } catch (error) {
      console.error("Error:", error);
    }
  };

  return (
    <div className="live-meeting">
      <h1>Live Meeting</h1>

      {!sessionId ? (
        <button onClick={startSession}>Start Session</button>
      ) : (
        <>
          <div className="controls">
            <button onClick={startRecording} disabled={isRecording}>
              Start Recording
            </button>
            <button onClick={stopRecording} disabled={!isRecording}>
              Stop Recording
            </button>
            <button onClick={stopSession}>End Session</button>
          </div>

          <div className="status">
            <p>Status: {sessionStatus}</p>
            {recordingStatus && (
              <p>
                Recording: {recordingStatus.audioSizeMB}MB (
                {recordingStatus.estimatedDurationSeconds}s)
              </p>
            )}
          </div>

          <div className="transcripts">
            <h2>Live Transcript</h2>
            {transcripts.map((t, i) => (
              <div key={i} className={t.isFinal ? "final" : "interim"}>
                {t.speaker && <strong>{t.speaker}:</strong>} {t.text}
              </div>
            ))}
          </div>

          <div className="questions">
            <h2>Suggested Questions ({questions.length})</h2>
            {questions.map((q) => (
              <div key={q.id} className={q.answered ? "answered" : ""}>
                <p>{q.question}</p>
                <button
                  onClick={() => markAsAnswered(q.id)}
                  disabled={q.answered}
                >
                  Mark as Answered
                </button>
                <button onClick={() => deleteQuestion(q.id)}>Delete</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

---

## Error Handling

### Common Errors and Solutions

#### 1. Microphone Permission Denied

```javascript
try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
} catch (error) {
  if (error.name === "NotAllowedError") {
    alert("Microphone permission denied. Please enable it in browser settings.");
  }
}
```

#### 2. WebSocket Connection Failed

```javascript
socket.on("connect_error", (error) => {
  console.error("Connection failed:", error);
  // Retry connection or show error to user
});
```

#### 3. Session Not Found

```javascript
socket.on("error", (error) => {
  if (error.code === "SESSION_NOT_FOUND") {
    // Session was deleted or doesn't exist
    // Redirect or create new session
  }
});
```

#### 4. Transcription Errors

```javascript
socket.on("error", (error) => {
  if (error.code === "TRANSCRIPTION_ERROR") {
    // Transcription service failed
    // Stop recording and notify user
    stopRecording();
    alert("Transcription error. Please try again.");
  }
});
```

---

## Best Practices

### 1. Audio Quality

- Use 16kHz sample rate for optimal transcription
- Enable noise suppression and echo cancellation
- Test microphone quality before starting session

### 2. Network Handling

- Handle WebSocket reconnections gracefully
- Buffer audio chunks if connection is temporarily lost
- Show connection status to user

### 3. Performance

- Send audio chunks in reasonable sizes (4096 samples recommended)
- Don't send empty or very small chunks
- Monitor memory usage for long sessions

### 4. User Experience

- Show clear recording status
- Display live transcripts in real-time
- Highlight new questions when they arrive
- Provide visual feedback for all actions

### 5. Error Recovery

- Implement retry logic for failed API calls
- Handle WebSocket disconnections
- Save session state locally if needed

---

## Testing Checklist

- [ ] Session starts successfully
- [ ] WebSocket connects and joins session
- [ ] Audio capture works (check browser console for errors)
- [ ] Audio chunks are being sent (check network tab)
- [ ] Live transcripts appear in real-time
- [ ] Recording status updates every 5 seconds
- [ ] Initial questions appear after session start
- [ ] New questions appear every 60 seconds
- [ ] Questions can be marked as answered
- [ ] Questions can be deleted
- [ ] Session stops successfully
- [ ] Summary is generated after stopping
- [ ] Error handling works for all error codes
- [ ] WebSocket reconnection works
- [ ] Works on different browsers (Chrome, Firefox, Safari)

---

## Support

For questions or issues:
- Backend code: `routes/liveConversation.js`
- Question generation: `utils/liveQuestionGenerator.js`
- Transcription: `utils/speechToText.js`

