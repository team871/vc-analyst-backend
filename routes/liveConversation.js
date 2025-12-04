const express = require("express");
const { body, validationResult } = require("express-validator");
const LiveConversation = require("../models/LiveConversation");
const ConversationTranscript = require("../models/ConversationTranscript");
const PitchDeck = require("../models/PitchDeck");
const { authMiddleware, requireSAOrAnalyst } = require("../middleware/auth");
const {
  transcribeCompleteAudio,
  createLiveTranscription,
} = require("../utils/speechToText");
const {
  generateQuestionSuggestions,
} = require("../utils/liveQuestionGenerator");
const { getFormattedContext } = require("../utils/contextRetrieval");
const OpenAI = require("openai");
const { tryParseJson, stripCodeFences } = require("../utils/helpers");

// Initialize OpenAI client
let openaiClient = null;
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set. AI features will not work.");
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return openaiClient;
}

const router = express.Router();

// Store active sessions and their connections
const activeSessions = new Map(); // sessionId -> { socket, audioBuffer, conversationBuffer, lastQuestionGeneration, initialQuestionsGenerated, lastAudioReceived }

/**
 * Background processing for stopping a live conversation session.
 * Handles full-audio transcription, summary generation, and history logging
 * without blocking the HTTP response of the /:id/stop route.
 * @param {string} sessionId - The live conversation session ID
 */
async function processSessionStop(sessionId) {
  try {
    const session = await LiveConversation.findById(sessionId);
    if (!session) {
      console.warn(
        `[STOP-BG] Session ${sessionId} not found in background processor`
      );
      return;
    }

    const sessionIdString = session._id.toString();
    console.log(`[STOP-BG] Processing stop for session ${sessionIdString}`);

    // Get active session and audio buffer
    const activeSession = activeSessions.get(sessionIdString);
    let completeAudioRecording = null;

    console.log(
      `[STOP-BG] Session ${
        session._id
      }: Active session exists: ${!!activeSession}`
    );

    if (activeSession) {
      console.log(
        `[STOP-BG] Audio buffer size: ${
          activeSession.audioBuffer?.length || 0
        } bytes, Chunks received: ${activeSession.audioChunkCount || 0}`
      );

      // Close transcription connection if it exists
      if (activeSession.transcription?.close) {
        activeSession.transcription.close();
      }

      // Get complete audio from our buffer (always maintained)
      if (activeSession.audioBuffer && activeSession.audioBuffer.length > 0) {
        completeAudioRecording = activeSession.audioBuffer;
        console.log(
          `[STOP-BG] Retrieved complete audio recording: ${(
            completeAudioRecording.length /
            1024 /
            1024
          ).toFixed(2)}MB (${completeAudioRecording.length} bytes)`
        );
      } else {
        console.warn(
          `[STOP-BG] No audio recording available for session ${
            session._id
          }. Audio buffer: ${
            activeSession.audioBuffer?.length || 0
          } bytes, Chunks: ${activeSession.audioChunkCount || 0}`
        );
      }
    } else {
      console.warn(
        `[STOP-BG] No active session found for session ${session._id}. This may happen if WebSocket disconnected before stop endpoint was called.`
      );
      console.warn(
        `[STOP-BG] Available active sessions: ${Array.from(
          activeSessions.keys()
        ).join(", ")}`
      );
    }

    // Calculate duration (if not already set)
    const endedAt = session.endedAt ? session.endedAt : new Date();
    const totalDuration = session.totalDuration
      ? session.totalDuration
      : Math.floor((endedAt - session.startedAt) / 1000);

    let summary = null;
    let completeTranscripts = [];
    let detectedLanguages = session.metadata?.detectedLanguages || [];

    try {
      // Transcribe complete audio with OpenAI
      if (!process.env.OPENAI_API_KEY) {
        console.error(
          "[STOP-BG] OPENAI_API_KEY not set - cannot transcribe complete audio"
        );
      } else if (completeAudioRecording && completeAudioRecording.length > 0) {
        console.log(
          `[STOP-BG] Transcribing complete audio recording for session ${session._id}...`
        );

        try {
          const completeTranscription = await transcribeCompleteAudio(
            completeAudioRecording,
            {
              model: "gpt-4o-transcribe-diarize",
              language: null,
              sample_rate: 16000,
            }
          );

          // Extract detected language
          if (completeTranscription.language) {
            detectedLanguages = [completeTranscription.language];
          }

          // Convert OpenAI transcription to transcript format and save to database
          if (completeTranscription && completeTranscription.segments) {
            completeTranscripts = await Promise.all(
              completeTranscription.segments.map(async (segment) => {
                let speakerId = null;
                if (segment.speaker) {
                  const parsed = parseInt(
                    segment.speaker.replace("SPEAKER_", ""),
                    10
                  );
                  if (!isNaN(parsed) && isFinite(parsed)) {
                    speakerId = parsed;
                  }
                }

                const transcriptData = {
                  text: segment.text || "",
                  timestamp: segment.start
                    ? new Date(
                        session.startedAt.getTime() + segment.start * 1000
                      )
                    : new Date(),
                  speaker: speakerId !== null ? `Speaker ${speakerId}` : null,
                  speakerId: speakerId,
                  isFinal: true,
                  metadata: {
                    confidence: 1.0,
                    languageCode: completeTranscription.language || null,
                  },
                };

                // Save transcript to database
                const transcriptEntry = new ConversationTranscript({
                  liveConversation: session._id,
                  pitchDeck: session.pitchDeck,
                  timestamp: transcriptData.timestamp,
                  text: transcriptData.text,
                  speaker: transcriptData.speaker,
                  speakerId: transcriptData.speakerId,
                  isFinal: transcriptData.isFinal,
                  metadata: transcriptData.metadata,
                });

                await transcriptEntry.save();
                return transcriptData;
              })
            );

            console.log(
              `[STOP-BG] Complete audio transcription: ${completeTranscripts.length} segments saved`
            );
          } else if (completeTranscription && completeTranscription.text) {
            // Fallback: single text response
            const transcriptEntry = new ConversationTranscript({
              liveConversation: session._id,
              pitchDeck: session.pitchDeck,
              timestamp: session.startedAt,
              text: completeTranscription.text,
              speaker: null,
              speakerId: null,
              isFinal: true,
              metadata: {
                confidence: 1.0,
                languageCode: completeTranscription.language || null,
              },
            });

            await transcriptEntry.save();

            completeTranscripts = [
              {
                text: completeTranscription.text,
                timestamp: session.startedAt,
                speaker: null,
                speakerId: null,
                isFinal: true,
                metadata: {
                  confidence: 1.0,
                  languageCode: completeTranscription.language || null,
                },
              },
            ];
          }

          // Generate summary from complete audio transcription
          if (completeTranscripts.length > 0) {
            console.log(
              "[STOP-BG] Generating meeting summary from complete audio..."
            );
            summary = await generateMeetingSummary(
              session._id.toString(),
              session.pitchDeck.toString(),
              completeTranscripts,
              totalDuration,
              detectedLanguages
            );
            console.log(
              "[STOP-BG] Meeting summary generated from complete audio."
            );
          }
        } catch (audioError) {
          console.error(
            "[STOP-BG] Error transcribing complete audio:",
            audioError
          );
          throw audioError;
        }
      } else {
        console.warn(
          "[STOP-BG] No audio recording available for transcription"
        );
      }
    } catch (error) {
      console.error("[STOP-BG] Error generating meeting summary:", error);
      // Continue even if summary generation fails
    }

    // Get transcript count
    const transcriptCount = await ConversationTranscript.countDocuments({
      liveConversation: session._id,
    });

    // Clean up active session
    if (activeSession) {
      // Clear auto-stop interval if it exists
      if (activeSession.autoStopCheckInterval) {
        clearInterval(activeSession.autoStopCheckInterval);
        activeSession.autoStopCheckInterval = null;
      }
      activeSessions.delete(session._id.toString());
    }

    // Update session with summary and metadata
    const updatedSession = await LiveConversation.findById(session._id);
    if (!updatedSession) {
      return;
    }

    updatedSession.status = "ENDED";
    updatedSession.endedAt = endedAt;
    updatedSession.totalDuration = totalDuration;
    updatedSession.transcriptCount = transcriptCount;

    if (summary) {
      updatedSession.summary = {
        generatedAt: new Date(),
        content: summary.content,
        keyTopics: summary.keyTopics || [],
        participants: summary.participants || [],
        duration: totalDuration,
      };
    }

    if (detectedLanguages.length > 0) {
      if (!updatedSession.metadata) {
        updatedSession.metadata = {};
      }
      updatedSession.metadata.detectedLanguages = detectedLanguages;
    }

    await updatedSession.save();

    // Save transcript summary to conversation history
    try {
      if (transcriptCount > 0) {
        const PitchDeckMessage = require("../models/PitchDeckMessage");
        await PitchDeckMessage.create({
          pitchDeck: updatedSession.pitchDeck,
          author: updatedSession.createdBy,
          organization: updatedSession.organization,
          userQuery: `[Live Conversation Session: ${
            updatedSession.title || "Untitled"
          }]`,
          attachments: [],
          aiResponse: {
            responseType: "conversational",
            response: {
              answer: summary
                ? `Meeting Summary:\n\n${summary.content}\n\nFull transcript available in session details.`
                : `Live conversation transcript (${transcriptCount} entries, ${totalDuration}s duration). See full transcript for details.`,
              reference: "live_conversation",
            },
          },
          responseType: "conversational",
          requiresAnalysisUpdate: false,
          analysisVersion: 1,
          metadata: {
            liveSessionId: updatedSession._id.toString(),
            transcriptCount: transcriptCount,
            duration: totalDuration,
            summaryGenerated: !!summary,
          },
        });
      }
    } catch (error) {
      console.error(
        "[STOP-BG] Error saving transcript to conversation history:",
        error
      );
    }

    console.log(
      `[STOP-BG] Finished background processing for session ${sessionIdString}`
    );
  } catch (error) {
    console.error("[STOP-BG] Unexpected error in processSessionStop:", error);
  }
}

/**
 * Detect speaker name from introduction text
 * @param {string} text - The transcript text
 * @param {number} speakerId - The speaker ID
 * @returns {Promise<string|null>} Detected name or null
 */
async function detectSpeakerName(text, speakerId) {
  try {
    // Common introduction patterns
    const introPatterns = [
      /(?:hi|hello|hey)[,\s]+(?:i'?m|i am|my name is|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
      /(?:i'?m|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
      /(?:my name is|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
      /(?:i'?m|i am)\s+([A-Z][a-z]+)[,\s]+(?:the|and i'?m)/i,
    ];

    // Try pattern matching first
    for (const pattern of introPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        // Validate it looks like a name (2-30 chars, starts with capital)
        if (name.length >= 2 && name.length <= 30 && /^[A-Z]/.test(name)) {
          return name;
        }
      }
    }

    // Use AI for more complex introductions
    if (text.length > 20 && text.length < 200) {
      const prompt = `Extract the person's name from this introduction statement. Return ONLY the name, nothing else. If no name is found, return "null".

Examples:
"Hi, I'm John Smith" -> "John Smith"
"My name is Sarah" -> "Sarah"
"I'm the CEO, Mike Johnson" -> "Mike Johnson"
"Hello everyone, I'm Alex" -> "Alex"

Statement: "${text}"

Name:`;

      try {
        const client = getOpenAIClient();
        const completion = await client.chat.completions.create({
          model: "gpt-4o", // Using GPT-4o for name extraction
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.3, // Lower temperature for more consistent name extraction
        });

        const responseText = completion.choices[0].message.content.trim();
        // Clean up response
        const name = responseText
          .replace(/^["']|["']$/g, "")
          .replace(/^Name:\s*/i, "")
          .trim();

        // Validate it looks like a name
        if (
          name &&
          name !== "null" &&
          name.length >= 2 &&
          name.length <= 30 &&
          /^[A-Z][a-z]+/.test(name)
        ) {
          return name;
        }
      } catch (aiError) {
        console.error("Error detecting name with AI:", aiError);
      }
    }

    return null;
  } catch (error) {
    console.error("Error detecting speaker name:", error);
    return null;
  }
}

/**
 * Check if a question has been answered by analyzing recent transcripts
 * @param {string} question - The question to check
 * @param {Array} recentTranscripts - Recent transcript entries
 * @returns {boolean} Whether the question appears to be answered
 */
async function checkIfQuestionAnswered(question, recentTranscripts) {
  try {
    if (!question || !recentTranscripts || recentTranscripts.length === 0) {
      return false;
    }

    // Extract key terms from the question
    const questionLower = question.toLowerCase();
    const questionWords = questionLower
      .replace(/[?.,!]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3); // Filter out short words

    // Build recent conversation text (last 2-3 minutes)
    const recentText = recentTranscripts
      .slice(-10) // Last 10 transcript entries
      .map((t) => t.text)
      .join(" ")
      .toLowerCase();

    // Check if question keywords appear in recent conversation
    const matchingWords = questionWords.filter((word) =>
      recentText.includes(word)
    );

    // If at least 30% of question words appear, consider it potentially answered
    const matchRatio = matchingWords.length / questionWords.length;

    // Use AI to do a more sophisticated check if basic match is found
    if (matchRatio >= 0.3) {
      try {
        const prompt = `You are analyzing a live conversation transcript to determine if a suggested question has been answered.

SUGGESTED QUESTION: "${question}"

RECENT CONVERSATION TRANSCRIPT:
${recentTranscripts
  .slice(-10)
  .map((t) => `[${t.speaker || "Speaker"}]: ${t.text}`)
  .join("\n")}

Determine if the suggested question has been adequately answered in the recent conversation. Consider:
- Was the question asked (or a similar question)?
- Was a substantive answer provided?
- Does the conversation address the topic of the question?

Respond with ONLY a JSON object:
{
  "answered": true or false,
  "confidence": 0.0 to 1.0,
  "reason": "Brief explanation"
}`;

        const client = getOpenAIClient();
        const completion = await client.chat.completions.create({
          model: "gpt-4o", // Using GPT-4o for question analysis
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          response_format: { type: "json_object" }, // Request JSON response
          temperature: 0.5, // Moderate temperature for analysis
        });

        const responseText = completion.choices[0].message.content;
        const parsed = tryParseJson(responseText);

        if (parsed && parsed.answered && parsed.confidence > 0.6) {
          return true;
        }
      } catch (aiError) {
        console.error("Error checking question with AI:", aiError);
        // Fall back to basic matching
      }
    }

    return matchRatio >= 0.5; // High match ratio = likely answered
  } catch (error) {
    console.error("Error checking if question answered:", error);
    return false;
  }
}

/**
 * Generate a comprehensive meeting summary using AI
 * @param {string} sessionId - The session ID
 * @param {string} pitchDeckId - The pitch deck ID
 * @param {Array} transcripts - Array of transcript entries
 * @param {number} duration - Meeting duration in seconds
 * @param {Array} detectedLanguages - Array of detected language codes
 * @returns {Promise<Object>} Summary object with content, keyTopics, and participants
 */
async function generateMeetingSummary(
  sessionId,
  pitchDeckId,
  transcripts,
  duration,
  detectedLanguages = []
) {
  try {
    if (!transcripts || transcripts.length === 0) {
      return {
        content: "No transcript available for this meeting.",
        keyTopics: [],
        participants: [],
        duration,
      };
    }

    // Get pitch deck context for better summary
    const knowledgeBaseContext = await getFormattedContext(pitchDeckId);

    // Build conversation transcript with speaker information
    const conversationText = transcripts
      .map((t) => {
        const speakerLabel = t.speaker || "Unknown";
        const timestamp = new Date(t.timestamp).toLocaleTimeString();
        return `[${timestamp}] ${speakerLabel}: ${t.text}`;
      })
      .join("\n");

    // Extract unique speakers
    const speakers = new Set();
    transcripts.forEach((t) => {
      if (t.speaker && t.speaker !== "UNKNOWN") {
        speakers.add(t.speaker);
      }
    });
    const participants = Array.from(speakers);

    // Build prompt for OpenAI
    const prompt = `You are DealFlow AI — an AI assistant for Venture Capital firms.

Your task: Generate a comprehensive, professional summary of a live pitch meeting between a VC analyst and a startup founder/team.

MEETING TRANSCRIPT:
${conversationText}

MEETING METADATA:
- Duration: ${Math.floor(duration / 60)} minutes ${duration % 60} seconds
- Participants: ${
      participants.length > 0 ? participants.join(", ") : "Multiple speakers"
    }
- Languages detected: ${
      detectedLanguages.length > 0
        ? detectedLanguages.join(", ")
        : "Not specified"
    }

TASK:
Analyze the entire meeting transcript and generate a comprehensive summary that includes:

1. **Executive Summary**: A brief overview of what was discussed (2-3 sentences)
2. **Key Topics Discussed**: Main topics, themes, and areas covered
3. **Important Points**: Critical information shared by the startup (metrics, traction, business model details, etc.) - Include who said what
4. **Questions Asked**: Key questions the analyst asked and the responses received - Include who asked and who answered
5. **Concerns or Red Flags**: Any concerns, risks, or red flags mentioned - Include who raised them
6. **Next Steps**: Any action items, follow-ups, or next steps mentioned - Include who committed to what
7. **Overall Assessment**: Brief assessment of the meeting outcome and key takeaways

Guidelines:
- Be objective and factual, based only on what was said in the transcript
- IMPORTANT: Always attribute statements to the speaker using their actual names when available (e.g., "John said...", "Sarah mentioned...", "Mike stated...")
- CRITICAL: Check the transcript carefully for introductions where speakers may have introduced themselves (e.g., "Hi, I'm John Smith", "My name is Sarah", "I'm Mike, the CEO"). Extract and use these actual names throughout the summary instead of generic speaker IDs
- If speaker names are not available in the transcript, use speaker IDs (e.g., "Speaker 0", "Speaker 1") or roles (e.g., "Analyst", "Founder") as a fallback
- For questions and responses, clearly identify who asked and who answered using their actual names (extracted from introductions if available)
- Focus on actionable insights and important information
- Highlight both positive aspects and concerns
- Use professional, investor-grade language
- Keep the summary concise but comprehensive (aim for 300-500 words)
- When referencing specific information, include speaker attribution with their name (e.g., "According to John, the company has...")

Return your response as a JSON object with this structure:
{
  "executiveSummary": "Brief overview of the meeting",
  "keyTopics": ["topic1", "topic2", "topic3"],
  "importantPoints": [
    "Point 1 with details (Speaker X said...)",
    "Point 2 with details (Speaker Y mentioned...)"
  ],
  "questionsAsked": [
    "Analyst asked: 'Question 1' - Speaker Y responded: 'Response'",
    "Speaker X asked: 'Question 2' - Analyst responded: 'Response'"
  ],
  "concernsOrRedFlags": [
    "Concern 1 if any (raised by Speaker X)",
    "Concern 2 if any (mentioned by Analyst)"
  ],
  "nextSteps": [
    "Next step 1 if mentioned (Speaker X committed to...)",
    "Next step 2 if mentioned (Analyst will follow up on...)"
  ],
  "overallAssessment": "Brief assessment and key takeaways"
}

Output valid JSON only.`;

    // Call OpenAI
    const client = getOpenAIClient();
    const completion = await client.chat.completions.create({
      model: "gpt-4o", // Using GPT-4o for comprehensive meeting summaries
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      response_format: { type: "json_object" }, // Request JSON response
      temperature: 0.7, // Balance between creativity and consistency
    });

    const responseText = completion.choices[0].message.content;
    const parsed = tryParseJson(responseText);

    if (parsed && typeof parsed === "object") {
      // Combine all sections into a comprehensive summary
      const summaryContent = `
EXECUTIVE SUMMARY
${parsed.executiveSummary || "No summary available."}

KEY TOPICS DISCUSSED
${
  parsed.keyTopics && parsed.keyTopics.length > 0
    ? parsed.keyTopics.map((t, i) => `${i + 1}. ${t}`).join("\n")
    : "No specific topics identified."
}

IMPORTANT POINTS
${
  parsed.importantPoints && parsed.importantPoints.length > 0
    ? parsed.importantPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")
    : "No specific points highlighted."
}

QUESTIONS AND RESPONSES
${
  parsed.questionsAsked && parsed.questionsAsked.length > 0
    ? parsed.questionsAsked.map((q, i) => `${i + 1}. ${q}`).join("\n")
    : "No specific questions documented."
}

PARTICIPANTS
${
  participants.length > 0
    ? participants.map((p, i) => `${i + 1}. ${p}`).join("\n")
    : "Multiple speakers identified"
}

CONCERNS OR RED FLAGS
${
  parsed.concernsOrRedFlags && parsed.concernsOrRedFlags.length > 0
    ? parsed.concernsOrRedFlags.map((c, i) => `${i + 1}. ${c}`).join("\n")
    : "No major concerns identified."
}

NEXT STEPS
${
  parsed.nextSteps && parsed.nextSteps.length > 0
    ? parsed.nextSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")
    : "No specific next steps mentioned."
}

OVERALL ASSESSMENT
${parsed.overallAssessment || "Assessment not available."}
`.trim();

      return {
        content: summaryContent,
        keyTopics: parsed.keyTopics || [],
        participants: participants,
        duration: duration,
        executiveSummary: parsed.executiveSummary,
        importantPoints: parsed.importantPoints || [],
        questionsAsked: parsed.questionsAsked || [],
        concernsOrRedFlags: parsed.concernsOrRedFlags || [],
        nextSteps: parsed.nextSteps || [],
        overallAssessment: parsed.overallAssessment,
      };
    } else {
      // Fallback: create a basic summary from transcript
      const text = stripCodeFences(responseText) || "";
      const wordCount = transcripts.reduce(
        (sum, t) => sum + t.text.split(/\s+/).length,
        0
      );

      return {
        content:
          text ||
          `Meeting summary:\n\nDuration: ${Math.floor(
            duration / 60
          )} minutes\nParticipants: ${
            participants.join(", ") || "Multiple speakers"
          }\nTotal words transcribed: ${wordCount}\n\nFull transcript available in the session details.`,
        keyTopics: [],
        participants: participants,
        duration: duration,
      };
    }
  } catch (error) {
    console.error("Error generating meeting summary:", error);
    // Return a basic fallback summary
    const wordCount = transcripts.reduce(
      (sum, t) => sum + (t.text ? t.text.split(/\s+/).length : 0),
      0
    );
    const speakers = new Set();
    transcripts.forEach((t) => {
      if (t.speaker && t.speaker !== "UNKNOWN") {
        speakers.add(t.speaker);
      }
    });

    return {
      content: `Meeting Summary\n\nDuration: ${Math.floor(
        duration / 60
      )} minutes ${duration % 60} seconds\nParticipants: ${
        Array.from(speakers).join(", ") || "Multiple speakers"
      }\nTotal words transcribed: ${wordCount}\n\nNote: AI summary generation failed. Full transcript is available in the session details.`,
      keyTopics: [],
      participants: Array.from(speakers),
      duration: duration,
    };
  }
}

/**
 * Start a new live conversation session
 */
router.post(
  "/start",
  authMiddleware,
  requireSAOrAnalyst,
  [
    body("pitchDeckId")
      .notEmpty()
      .withMessage("Pitch deck ID is required")
      .isMongoId()
      .withMessage("Invalid pitch deck ID"),
    body("title").optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { pitchDeckId, title } = req.body;

      // Verify pitch deck exists and user has access
      const query = {
        _id: pitchDeckId,
        organization: req.user.organization._id,
        isActive: true,
      };

      if (req.user.role === "ANALYST") {
        query.uploadedBy = req.user._id;
      }

      const pitchDeck = await PitchDeck.findOne(query);
      if (!pitchDeck) {
        return res.status(404).json({ message: "Pitch deck not found" });
      }

      // Create new live conversation session
      const liveConversation = new LiveConversation({
        title: title || `Live conversation - ${pitchDeck.title}`,
        pitchDeck: pitchDeckId,
        organization: req.user.organization._id,
        createdBy: req.user._id,
        status: "ACTIVE",
        startedAt: new Date(),
      });

      await liveConversation.save();

      // Generate WebSocket token (JWT with session info)
      const jwt = require("jsonwebtoken");
      const wsToken = jwt.sign(
        {
          userId: req.user._id.toString(),
          sessionId: liveConversation._id.toString(),
          pitchDeckId: pitchDeckId,
        },
        process.env.JWT_SECRET,
        { expiresIn: "24h" }
      );

      res.status(201).json({
        sessionId: liveConversation._id.toString(),
        wsUrl: `/live-conversation`,
        token: wsToken,
        pitchDeck: {
          id: pitchDeck._id.toString(),
          title: pitchDeck.title,
        },
      });
    } catch (error) {
      console.error("Start live conversation error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * Get session details
 */
router.get("/:id", authMiddleware, requireSAOrAnalyst, async (req, res) => {
  try {
    const session = await LiveConversation.findOne({
      _id: req.params.id,
      organization: req.user.organization._id,
      isActive: true,
    })
      .populate("pitchDeck", "title")
      .populate("createdBy", "firstName lastName email")
      .lean();

    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }

    // Check access for analysts
    if (req.user.role === "ANALYST") {
      const pitchDeck = await PitchDeck.findById(session.pitchDeck);
      if (pitchDeck.uploadedBy.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Access denied" });
      }
    }

    res.json({
      sessionId: session._id.toString(),
      title: session.title,
      pitchDeck: session.pitchDeck,
      status: session.status,
      createdAt: session.startedAt,
      endedAt: session.endedAt,
      totalDuration: session.totalDuration,
      transcriptCount: session.transcriptCount,
      suggestionCount: session.suggestionCount,
      summary: session.summary || null,
      detectedLanguages: session.metadata?.detectedLanguages || [],
    });
  } catch (error) {
    console.error("Get session error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * Mark a suggested question as answered (triggers generation of new question)
 */
router.patch(
  "/:id/questions/:questionId/answered",
  authMiddleware,
  requireSAOrAnalyst,
  async (req, res) => {
    try {
      const session = await LiveConversation.findOne({
        _id: req.params.id,
        organization: req.user.organization._id,
        isActive: true,
      });

      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }

      // Check access for analysts
      if (req.user.role === "ANALYST") {
        const pitchDeck = await PitchDeck.findById(session.pitchDeck);
        if (pitchDeck.uploadedBy.toString() !== req.user._id.toString()) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      // Find and mark question as answered
      const question = session.suggestedQuestions?.id(req.params.questionId);
      if (!question) {
        return res.status(404).json({ message: "Question not found" });
      }

      if (question.answered) {
        return res.json({
          message: "Question already marked as answered",
          questionId: req.params.questionId,
        });
      }

      question.answered = true;
      question.answeredAt = new Date();
      await session.save();

      // Get recent transcripts for generating replacement question
      const recentTranscripts = await ConversationTranscript.find({
        liveConversation: session._id,
        isFinal: true,
      })
        .sort({ timestamp: -1 })
        .limit(20)
        .lean();

      const sessionTranscripts = recentTranscripts.reverse().map((t) => ({
        text: t.text,
        timestamp: t.timestamp,
        speaker: t.speaker,
      }));

      // Generate replacement question(s) asynchronously
      setImmediate(async () => {
        try {
          // Get existing questions to avoid duplicates
          const existingQuestionTexts = session.suggestedQuestions
            .filter(
              (q) => !q.deleted && q._id.toString() !== req.params.questionId
            )
            .map((q) => q.question);

          const suggestions = await generateQuestionSuggestions(
            session.pitchDeck.toString(),
            sessionTranscripts,
            null,
            existingQuestionTexts // Pass existing questions for deduplication
          );

          if (suggestions && suggestions.questions.length > 0) {
            // Reload session to get latest state
            const updatedSession = await LiveConversation.findById(
              req.params.id
            );
            if (!updatedSession) return;

            // Replace the answered question with a new one (keep same position)
            const allQuestions = [...updatedSession.suggestedQuestions];
            const questionIndex = allQuestions.findIndex(
              (q) => q._id.toString() === req.params.questionId
            );

            if (questionIndex !== -1) {
              // Replace with first new question
              allQuestions[questionIndex] = {
                question: suggestions.questions[0],
                answered: false,
                deleted: false,
                createdAt: new Date(),
              };

              // If we have more new questions, add them to the top
              if (suggestions.questions.length > 1) {
                const extraQuestions = suggestions.questions
                  .slice(1)
                  .map((q) => ({
                    question: q,
                    answered: false,
                    deleted: false,
                    createdAt: new Date(),
                  }));
                updatedSession.suggestedQuestions = [
                  ...extraQuestions,
                  ...allQuestions,
                ];
              } else {
                updatedSession.suggestedQuestions = allQuestions;
              }

              await updatedSession.save();

              // Reload to get IDs
              const finalSession = await LiveConversation.findById(
                req.params.id
              );

              // Emit updated questions via WebSocket if session is active
              const activeSession = activeSessions.get(req.params.id);
              if (activeSession && activeSession.socket) {
                activeSession.socket.emit("suggested-questions-updated", {
                  questions: finalSession.suggestedQuestions
                    .filter((q) => !q.deleted)
                    .map((q) => ({
                      id: q._id.toString(),
                      question: q.question,
                      answered: q.answered,
                      createdAt: q.createdAt,
                      answeredAt: q.answeredAt,
                    })),
                });
              }

              await LiveConversation.findByIdAndUpdate(req.params.id, {
                $inc: { suggestionCount: 1 },
              });
            }
          }
        } catch (error) {
          console.error("Error generating replacement question:", error);
        }
      });

      res.json({
        message: "Question marked as answered",
        questionId: req.params.questionId,
        replacementGenerating: true,
      });
    } catch (error) {
      console.error("Mark question answered error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * Delete a suggested question
 */
router.delete(
  "/:id/questions/:questionId",
  authMiddleware,
  requireSAOrAnalyst,
  async (req, res) => {
    try {
      const session = await LiveConversation.findOne({
        _id: req.params.id,
        organization: req.user.organization._id,
        isActive: true,
      });

      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }

      // Check access for analysts
      if (req.user.role === "ANALYST") {
        const pitchDeck = await PitchDeck.findById(session.pitchDeck);
        if (pitchDeck.uploadedBy.toString() !== req.user._id.toString()) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      // Find and mark question as deleted
      const question = session.suggestedQuestions?.id(req.params.questionId);
      if (!question) {
        return res.status(404).json({ message: "Question not found" });
      }

      question.deleted = true;
      await session.save();

      res.json({
        message: "Question deleted",
        questionId: req.params.questionId,
      });
    } catch (error) {
      console.error("Delete question error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * Get full transcript for a session
 */
router.get(
  "/:id/transcript",
  authMiddleware,
  requireSAOrAnalyst,
  async (req, res) => {
    try {
      const session = await LiveConversation.findOne({
        _id: req.params.id,
        organization: req.user.organization._id,
        isActive: true,
      });

      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }

      // Check access for analysts
      if (req.user.role === "ANALYST") {
        const pitchDeck = await PitchDeck.findById(session.pitchDeck);
        if (pitchDeck.uploadedBy.toString() !== req.user._id.toString()) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const transcripts = await ConversationTranscript.find({
        liveConversation: session._id,
      })
        .sort({ timestamp: 1 })
        .lean();

      res.json({
        sessionId: session._id.toString(),
        entries: transcripts.map((t) => ({
          timestamp: t.timestamp,
          text: t.text,
          speaker: t.speaker,
          speakerId: t.speakerId,
          isFinal: t.isFinal,
          suggestions: t.suggestions || [],
          confidence: t.metadata?.confidence,
          languageCode: t.metadata?.languageCode,
        })),
        summary: session.summary || null,
        detectedLanguages: session.metadata?.detectedLanguages || [],
      });
    } catch (error) {
      console.error("Get transcript error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * Get all live conversation meetings for a specific pitch deck (with summaries)
 */
router.get(
  "/pitch-deck/:pitchDeckId",
  authMiddleware,
  requireSAOrAnalyst,
  async (req, res) => {
    try {
      const { pitchDeckId } = req.params;

      // Verify pitch deck exists and user has access
      const query = {
        _id: pitchDeckId,
        organization: req.user.organization._id,
        isActive: true,
      };

      if (req.user.role === "ANALYST") {
        query.uploadedBy = req.user._id;
      }

      const pitchDeck = await PitchDeck.findOne(query).lean();
      if (!pitchDeck) {
        return res.status(404).json({ message: "Pitch deck not found" });
      }

      const sessions = await LiveConversation.find({
        pitchDeck: pitchDeckId,
        organization: req.user.organization._id,
        isActive: true,
      })
        .sort({ startedAt: -1 })
        .lean();

      res.json({
        pitchDeck: {
          id: pitchDeck._id.toString(),
          title: pitchDeck.title,
        },
        meetings: sessions.map((s) => ({
          id: s._id.toString(),
          title: s.title,
          status: s.status,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          totalDuration: s.totalDuration,
          transcriptCount: s.transcriptCount,
          suggestionCount: s.suggestionCount,
          summary: s.summary || null,
          detectedLanguages: s.metadata?.detectedLanguages || [],
        })),
      });
    } catch (error) {
      console.error("Get pitch deck meetings error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * Stop a live conversation session
 * Summary generation is handled in the background so this call returns quickly.
 */
router.post(
  "/:id/stop",
  authMiddleware,
  requireSAOrAnalyst,
  async (req, res) => {
    try {
      const session = await LiveConversation.findOne({
        _id: req.params.id,
        organization: req.user.organization._id,
        isActive: true,
      });

      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }

      // Check access for analysts
      if (req.user.role === "ANALYST") {
        const pitchDeck = await PitchDeck.findById(session.pitchDeck);
        if (pitchDeck.uploadedBy.toString() !== req.user._id.toString()) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const sessionIdString = session._id.toString();
      console.log(
        `[STOP] Queueing background processing for session ${sessionIdString}`
      );

      // Clean up auto-stop interval if it exists
      const activeSession = activeSessions.get(sessionIdString);
      if (activeSession && activeSession.autoStopCheckInterval) {
        clearInterval(activeSession.autoStopCheckInterval);
        activeSession.autoStopCheckInterval = null;
        console.log(
          `[STOP] Cleared auto-stop interval for session ${sessionIdString}`
        );
      }

      // Optimistically mark session as ended; background job will finalize details
      session.status = "ENDED";
      session.endedAt = new Date();
      session.totalDuration = Math.floor(
        (session.endedAt.getTime() - session.startedAt.getTime()) / 1000
      );
      await session.save();

      // Kick off background processing
      setImmediate(() => {
        processSessionStop(sessionIdString).catch((err) => {
          console.error("[STOP] Background processing error:", err);
        });
      });

      res.json({
        sessionId: session._id.toString(),
        endedAt: session.endedAt,
        totalDuration: session.totalDuration,
        summary: null,
        summaryPending: true,
      });
    } catch (error) {
      console.error("Stop session error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);
/**
 * Setup WebSocket handlers for live conversations
 */
function setupLiveConversationHandlers(io, socket) {
  let currentSessionId = null;
  let initialQuestionsGenerated = false;

  // Join session room
  socket.on("join-session", async (data) => {
    try {
      const { sessionId } = data;

      // Verify session exists and user has access
      const session = await LiveConversation.findById(sessionId);
      if (!session) {
        socket.emit("error", {
          message: "Session not found",
          code: "SESSION_NOT_FOUND",
        });
        return;
      }

      // Check if session is active
      if (session.status !== "ACTIVE") {
        socket.emit("error", {
          message: "Session is not active",
          code: "SESSION_INACTIVE",
        });
        return;
      }

      currentSessionId = sessionId;
      socket.join(`session:${sessionId}`);

      console.log(
        `[${
          socket.userId
        }] Joined session: ${sessionId} (type: ${typeof sessionId})`
      );

      // Initialize session in activeSessions map
      if (!activeSessions.has(sessionId)) {
        activeSessions.set(sessionId, {
          socket,
          audioBuffer: Buffer.alloc(0), // Buffer for complete audio recording
          transcription: null, // Live transcription connection
          lastQuestionGeneration: null,
          initialQuestionsGenerated: false,
          audioChunkCount: 0,
          lastAudioStatusUpdate: Date.now(),
          lastAudioReceived: Date.now(), // Track last audio received for auto-stop
          transcriptBuffer: [], // Store recent live transcripts for question generation
          autoStopCheckInterval: null, // Store interval ID for auto-stop checking
        });
      } else {
        // Update existing session with new socket and reset audio timestamp
        const existingSession = activeSessions.get(sessionId);
        existingSession.socket = socket;
        existingSession.lastAudioReceived = Date.now();
      }

      // Reset initial questions flag for this session
      initialQuestionsGenerated = false;

      // Start auto-stop check interval (check every 30 seconds for 4 minutes of silence)
      const activeSessionForAutoStop = activeSessions.get(sessionId);
      if (
        activeSessionForAutoStop &&
        !activeSessionForAutoStop.autoStopCheckInterval
      ) {
        const AUTO_STOP_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes
        const CHECK_INTERVAL_MS = 30 * 1000; // Check every 30 seconds

        activeSessionForAutoStop.autoStopCheckInterval = setInterval(
          async () => {
            try {
              const session = activeSessions.get(sessionId);
              if (!session) {
                // Session already cleaned up
                return;
              }

              const now = Date.now();
              const lastAudioTime =
                session.lastAudioReceived ||
                session.lastAudioStatusUpdate ||
                session.startedAt?.getTime() ||
                now;
              const timeSinceLastAudio = now - lastAudioTime;

              if (timeSinceLastAudio >= AUTO_STOP_TIMEOUT_MS) {
                console.log(
                  `[AUTO-STOP] Session ${sessionId} has been inactive for ${Math.round(
                    timeSinceLastAudio / 1000
                  )}s. Auto-stopping...`
                );

                // Clear the interval
                if (session.autoStopCheckInterval) {
                  clearInterval(session.autoStopCheckInterval);
                  session.autoStopCheckInterval = null;
                }

                // Stop the session
                const sessionDoc = await LiveConversation.findById(sessionId);
                if (sessionDoc && sessionDoc.status === "ACTIVE") {
                  sessionDoc.status = "ENDED";
                  sessionDoc.endedAt = new Date();
                  sessionDoc.totalDuration = Math.floor(
                    (sessionDoc.endedAt.getTime() -
                      sessionDoc.startedAt.getTime()) /
                      1000
                  );
                  await sessionDoc.save();

                  // Emit auto-stop event to client
                  const currentSession = activeSessions.get(sessionId);
                  if (
                    currentSession &&
                    currentSession.socket &&
                    currentSession.socket.connected
                  ) {
                    currentSession.socket.emit("session-auto-stopped", {
                      reason: "No audio received for 4 minutes",
                      endedAt: sessionDoc.endedAt,
                      totalDuration: sessionDoc.totalDuration,
                    });
                  }

                  // Process session stop in background
                  setImmediate(() => {
                    processSessionStop(sessionId).catch((err) => {
                      console.error(
                        "[AUTO-STOP] Background processing error:",
                        err
                      );
                    });
                  });
                }
              }
            } catch (error) {
              console.error("[AUTO-STOP] Error in auto-stop check:", error);
            }
          },
          CHECK_INTERVAL_MS
        );

        console.log(
          `[AUTO-STOP] Started auto-stop monitoring for session ${sessionId}`
        );
      } else if (activeSessionForAutoStop) {
        // Session exists, just update lastAudioReceived timestamp
        activeSessionForAutoStop.lastAudioReceived = Date.now();
      }

      // Generate initial questions based on pitch deck
      setImmediate(async () => {
        try {
          const activeSession = activeSessions.get(sessionId);
          if (!activeSession || activeSession.initialQuestionsGenerated) return;

          activeSession.initialQuestionsGenerated = true;
          console.log(
            `[${socket.userId}] Generating initial questions based on pitch deck`
          );

          const sessionDoc = await LiveConversation.findById(sessionId);
          if (!sessionDoc) return;

          // Get existing questions to avoid duplicates (for initial questions)
          const existingQuestionTexts = sessionDoc.suggestedQuestions
            ? sessionDoc.suggestedQuestions
                .filter((q) => !q.deleted && !q.answered)
                .map((q) => q.question)
            : [];

          const suggestions = await generateQuestionSuggestions(
            sessionDoc.pitchDeck.toString(),
            [],
            null,
            existingQuestionTexts // Pass existing questions for deduplication
          );

          if (suggestions && suggestions.questions.length > 0) {
            const newQuestions = suggestions.questions.map((question) => ({
              question: question,
              answered: false,
              deleted: false,
              createdAt: new Date(),
            }));

            sessionDoc.suggestedQuestions = newQuestions;
            await sessionDoc.save();

            const updatedSession = await LiveConversation.findById(sessionId);

            socket.emit("suggestion", {
              questions: updatedSession.suggestedQuestions
                .filter((q) => !q.deleted)
                .map((q) => ({
                  id: q._id.toString(),
                  question: q.question,
                  answered: q.answered,
                  createdAt: q.createdAt,
                  answeredAt: q.answeredAt,
                })),
              context:
                suggestions.context || "Initial questions based on pitch deck",
              topics: suggestions.topics || [],
              timestamp: Date.now(),
            });

            await LiveConversation.findByIdAndUpdate(sessionId, {
              $inc: { suggestionCount: 1 },
            });
          }
        } catch (error) {
          console.error("Error generating initial questions:", error);
        }
      });

      // Send existing suggested questions if any
      const sessionDoc = await LiveConversation.findById(sessionId);
      if (sessionDoc && sessionDoc.suggestedQuestions) {
        const activeQuestions = sessionDoc.suggestedQuestions
          .filter((q) => !q.deleted)
          .map((q) => ({
            id: q._id.toString(),
            question: q.question,
            answered: q.answered,
            createdAt: q.createdAt,
            answeredAt: q.answeredAt,
          }));

        if (activeQuestions.length > 0) {
          socket.emit("suggestion", {
            questions: activeQuestions,
            context: "Existing questions",
            topics: [],
            timestamp: Date.now(),
          });
        }
      }

      socket.emit("session-status", {
        status: "connected",
        message:
          "Session connected and ready for audio. Start microphone to begin recording.",
      });

      // Send initial recording status
      socket.emit("recording-status", {
        status: "ready",
        audioSizeMB: 0,
        audioChunks: 0,
        estimatedDurationSeconds: 0,
        message: "Ready to record. Start microphone to begin.",
      });
    } catch (error) {
      console.error("Join session error:", error);
      socket.emit("error", {
        message: "Failed to join session",
        code: "JOIN_ERROR",
      });
    }
  });

  // Handle audio chunks - buffer audio and provide live transcription
  socket.on("audio-chunk", (data) => {
    try {
      const { sessionId, audioData } = data;

      if (!currentSessionId || currentSessionId !== sessionId) {
        socket.emit("error", {
          message: "Invalid session",
          code: "INVALID_SESSION",
        });
        return;
      }

      const activeSession = activeSessions.get(sessionId);
      if (!activeSession) {
        socket.emit("error", {
          message: "Session not found",
          code: "SESSION_NOT_FOUND",
        });
        return;
      }

      // Initialize live transcription on first audio chunk
      if (!activeSession.transcription) {
        if (!process.env.OPENAI_API_KEY) {
          console.error(
            `[${socket.userId}] OPENAI_API_KEY not set - cannot transcribe`
          );
          socket.emit("error", {
            message:
              "OpenAI API key not configured. Please set OPENAI_API_KEY environment variable.",
            code: "OPENAI_API_KEY_MISSING",
          });
          return;
        }

        try {
          console.log(`[${socket.userId}] Initializing live transcription...`);
          activeSession.transcription = createLiveTranscription(
            {
              model: "whisper-1",
              language: null,
              sample_rate: 16000,
              channels: 1,
            },
            async (transcript) => {
              // Save transcript to database
              try {
                const sessionDoc = await LiveConversation.findById(sessionId);
                if (sessionDoc) {
                  const transcriptEntry = new ConversationTranscript({
                    liveConversation: sessionId,
                    pitchDeck: sessionDoc.pitchDeck,
                    timestamp: new Date(transcript.timestamp),
                    text: transcript.text,
                    speaker: transcript.speaker || null,
                    speakerId: transcript.speakerId || null,
                    isFinal: transcript.isFinal,
                    metadata: {
                      confidence: transcript.confidence,
                      languageCode: transcript.languageCode || null,
                    },
                  });

                  await transcriptEntry.save();

                  // Add to transcript buffer for question generation (only final transcripts)
                  if (transcript.isFinal && activeSession) {
                    if (!activeSession.transcriptBuffer) {
                      activeSession.transcriptBuffer = [];
                    }

                    activeSession.transcriptBuffer.push({
                      text: transcript.text,
                      timestamp: transcript.timestamp,
                      speaker: transcript.speaker,
                    });

                    // Keep only last 2-3 minutes of transcripts (for context)
                    const threeMinutesAgo = Date.now() - 3 * 60 * 1000;
                    activeSession.transcriptBuffer =
                      activeSession.transcriptBuffer.filter(
                        (t) => t.timestamp >= threeMinutesAgo
                      );
                  }

                  // Emit transcription to client for live display
                  socket.emit("transcription", {
                    text: transcript.text,
                    isFinal: transcript.isFinal,
                    timestamp: transcript.timestamp,
                    speaker: transcript.speaker,
                    speakerId: transcript.speakerId,
                    languageCode: transcript.languageCode,
                  });
                }
              } catch (error) {
                console.error("Error saving live transcript:", error);
              }
            },
            (error) => {
              console.error("Live transcription error:", error);
              socket.emit("error", {
                message:
                  "Transcription error: " + (error.message || "Unknown error"),
                code: "TRANSCRIPTION_ERROR",
              });
            }
          );
          console.log(`[${socket.userId}] Live transcription initialized`);
        } catch (error) {
          console.error(
            `[${socket.userId}] Failed to initialize transcription:`,
            error
          );
          socket.emit("error", {
            message:
              "Failed to initialize transcription: " +
              (error.message || "Unknown error"),
            code: "TRANSCRIPTION_INIT_ERROR",
          });
        }
      }

      // Convert audio data to buffer
      let audioBuffer;
      try {
        if (Buffer.isBuffer(audioData)) {
          audioBuffer = audioData;
        } else if (audioData instanceof ArrayBuffer) {
          audioBuffer = Buffer.from(audioData);
        } else if (audioData instanceof Uint8Array) {
          audioBuffer = Buffer.from(audioData);
        } else if (typeof audioData === "string") {
          audioBuffer = Buffer.from(audioData, "base64");
        } else {
          audioBuffer = Buffer.from(audioData);
        }
      } catch (bufferError) {
        console.error(
          `[${socket.userId}] Error converting audio data:`,
          bufferError
        );
        return;
      }

      // Validate buffer
      if (audioBuffer.length === 0 || audioBuffer.length > 1024 * 1024) {
        return;
      }

      // Send to live transcription if available
      if (
        activeSession.transcription &&
        activeSession.transcription.isConnected()
      ) {
        try {
          activeSession.transcription.send(audioBuffer);
        } catch (error) {
          console.error("Error sending to live transcription:", error);
        }
      }

      // Always maintain our own audio buffer for end-of-meeting analysis
      // This ensures we have the complete recording even if transcription fails
      activeSession.audioBuffer = Buffer.concat([
        activeSession.audioBuffer,
        audioBuffer,
      ]);

      // Track audio chunks received
      activeSession.audioChunkCount = (activeSession.audioChunkCount || 0) + 1;

      // Update last audio received timestamp for auto-stop functionality
      activeSession.lastAudioReceived = Date.now();

      // Log first few chunks for debugging
      if (activeSession.audioChunkCount <= 3) {
        console.log(
          `[${socket.userId}] Audio chunk ${activeSession.audioChunkCount}: ${audioBuffer.length} bytes, Total buffer: ${activeSession.audioBuffer.length} bytes`
        );
      }

      // Send periodic status updates to confirm recording (every 5 seconds)
      const now = Date.now();
      const lastUpdate = activeSession.lastAudioStatusUpdate || 0;
      if (now - lastUpdate > 5000) {
        activeSession.lastAudioStatusUpdate = now;
        const audioSizeMB = (
          activeSession.audioBuffer.length /
          1024 /
          1024
        ).toFixed(2);
        const estimatedDuration = Math.floor(
          activeSession.audioBuffer.length / (16000 * 2)
        ); // 16kHz, 16-bit = 2 bytes per sample

        socket.emit("recording-status", {
          status: "recording",
          audioSizeMB: parseFloat(audioSizeMB),
          audioChunks: activeSession.audioChunkCount,
          estimatedDurationSeconds: estimatedDuration,
          message: `Recording... ${audioSizeMB}MB (${estimatedDuration}s)`,
        });
      }

      // Periodically generate questions based on meeting progress
      // Questions are generated based on live transcripts and pitch deck context
      setImmediate(async () => {
        try {
          const sessionDoc = await LiveConversation.findById(sessionId);
          if (!sessionDoc) return;

          const now = Date.now();
          const lastQuestionGeneration =
            activeSession.lastQuestionGeneration || 0;
          const timeSinceLastGeneration = now - lastQuestionGeneration;
          const unansweredCount = sessionDoc.suggestedQuestions.filter(
            (q) => !q.answered && !q.deleted
          ).length;

          // Get recent transcripts from database (last 2-3 minutes)
          const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
          const recentTranscriptsFromDB = await ConversationTranscript.find({
            liveConversation: sessionId,
            isFinal: true,
            timestamp: { $gte: threeMinutesAgo },
          })
            .sort({ timestamp: 1 })
            .lean();

          const recentTranscripts = recentTranscriptsFromDB.map((t) => ({
            text: t.text,
            timestamp: t.timestamp,
            speaker: t.speaker,
          }));

          const wordCount = recentTranscripts
            .map((t) => t.text)
            .join(" ")
            .split(/\s+/)
            .filter((w) => w.length > 0).length;

          // Debug logging
          const shouldGenerate =
            activeSession.initialQuestionsGenerated &&
            timeSinceLastGeneration > 60000 && // 60 seconds (1 per minute)
            // unansweredCount > 0 &&
            // unansweredCount < 10 &&
            wordCount >= 50;

          if (!shouldGenerate && activeSession.initialQuestionsGenerated) {
            // Log why questions aren't being generated (only occasionally to avoid spam)
            if (Math.random() < 0.05) {
              // 5% chance to log (increased for debugging)
              const reasons = [];
              if (!activeSession.initialQuestionsGenerated)
                reasons.push("initial not generated");
              if (timeSinceLastGeneration <= 60000)
                reasons.push(
                  `only ${Math.round(
                    timeSinceLastGeneration / 1000
                  )}s since last (need 60s)`
                );
              if (unansweredCount === 0)
                reasons.push("no unanswered questions");
              if (unansweredCount >= 10)
                reasons.push(`${unansweredCount} unanswered (max 9)`);
              if (wordCount < 50)
                reasons.push(`only ${wordCount} words (need 50)`);

              console.log(
                `[${
                  socket.userId
                }] ⏸️ Question generation skipped: ${reasons.join(", ")}`
              );
            }
          }

          // Generate questions every 1 minute during active meeting
          // Use transcripts from database for context-aware questions
          if (shouldGenerate) {
            console.log(
              `[${socket.userId}] ✅ Generating live questions: ` +
                `${wordCount} words, ${recentTranscripts.length} transcripts from DB, ` +
                `${unansweredCount} unanswered questions, ` +
                `${Math.round(
                  timeSinceLastGeneration / 1000
                )}s since last generation`
            );

            activeSession.lastQuestionGeneration = now;

            // Get existing questions to avoid duplicates
            const existingQuestionTexts = sessionDoc.suggestedQuestions
              .filter((q) => !q.deleted && !q.answered)
              .map((q) => q.question);

            const suggestions = await generateQuestionSuggestions(
              sessionDoc.pitchDeck.toString(),
              recentTranscripts, // Use transcripts from database
              lastQuestionGeneration,
              existingQuestionTexts // Pass existing questions for deduplication
            );

            if (suggestions && suggestions.questions.length > 0) {
              console.log(
                `[${socket.userId}] Generated ${suggestions.questions.length} new questions`
              );
              const newQuestions = suggestions.questions.map((question) => ({
                question: question,
                answered: false,
                deleted: false,
                createdAt: new Date(),
              }));

              const existingActive = sessionDoc.suggestedQuestions.filter(
                (q) => !q.deleted
              );
              sessionDoc.suggestedQuestions = [
                ...newQuestions,
                ...existingActive,
              ];

              await sessionDoc.save();

              const updatedSession = await LiveConversation.findById(sessionId);
              const questionsToEmit = updatedSession.suggestedQuestions
                .filter((q) => !q.deleted)
                .map((q) => ({
                  id: q._id.toString(),
                  question: q.question,
                  answered: q.answered,
                  createdAt: q.createdAt,
                  answeredAt: q.answeredAt,
                }));

              console.log(
                `[${socket.userId}] Emitting ${questionsToEmit.length} questions via WebSocket`
              );

              // Use activeSession.socket to ensure we emit to the correct client
              const currentActiveSession = activeSessions.get(sessionId);
              if (
                currentActiveSession &&
                currentActiveSession.socket &&
                currentActiveSession.socket.connected
              ) {
                currentActiveSession.socket.emit(
                  "suggested-questions-updated",
                  {
                    questions: questionsToEmit,
                  }
                );
                console.log(
                  `[${socket.userId}] Successfully emitted questions to client`
                );
              } else {
                console.warn(
                  `[${socket.userId}] Cannot emit questions: socket not connected or session not found`
                );
                // Fallback to direct socket if activeSession socket is not available
                if (socket && socket.connected) {
                  socket.emit("suggested-questions-updated", {
                    questions: questionsToEmit,
                  });
                  console.log(
                    `[${socket.userId}] Emitted questions via fallback socket`
                  );
                }
              }

              await LiveConversation.findByIdAndUpdate(sessionId, {
                $inc: { suggestionCount: 1 },
              });
            } else {
              console.log(
                `[${socket.userId}] No questions generated from suggestions`
              );
            }
          }
        } catch (error) {
          console.error("Error generating questions during meeting:", error);
        }
      });
    } catch (error) {
      console.error("Audio chunk processing error:", error);
    }
  });

  // Handle ping/keepalive
  socket.on("ping", () => {
    socket.emit("pong", { timestamp: Date.now() });
  });

  // Handle disconnect
  socket.on("disconnect", async () => {
    try {
      if (currentSessionId) {
        const activeSession = activeSessions.get(currentSessionId);
        if (activeSession && activeSession.socket.id === socket.id) {
          // Mark socket as disconnected but KEEP the session data
          // The audio buffer needs to be preserved until stop endpoint is called
          activeSession.socket = null;

          // Clear auto-stop interval on disconnect (will be restarted if reconnected)
          if (activeSession.autoStopCheckInterval) {
            clearInterval(activeSession.autoStopCheckInterval);
            activeSession.autoStopCheckInterval = null;
          }

          console.log(
            `[${
              socket.userId
            }] WebSocket disconnected for session ${currentSessionId}, but keeping session data (audio buffer: ${
              activeSession.audioBuffer?.length || 0
            } bytes)`
          );
          // Don't delete the session - it will be cleaned up when stop endpoint is called
        }
      }
    } catch (error) {
      console.error("Error handling disconnect:", error);
    }
  });
}

module.exports = { router, setupLiveConversationHandlers };
