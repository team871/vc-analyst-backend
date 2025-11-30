const mongoose = require("mongoose");

const conversationTranscriptSchema = new mongoose.Schema(
  {
    liveConversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LiveConversation",
      required: true,
    },
    pitchDeck: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PitchDeck",
      required: true,
    },
    timestamp: {
      type: Date,
      required: true,
      default: Date.now,
    },
    text: {
      type: String,
      required: true,
    },
    speaker: {
      type: String,
      // Speaker name or ID (e.g., "Speaker 0", "Speaker 1", or actual name)
      default: "UNKNOWN",
    },
    speakerId: {
      type: Number,
      // Speaker diarization ID from OpenAI transcription (0, 1, 2, etc.)
    },
    isFinal: {
      type: Boolean,
      default: false,
    },
    suggestions: [
      {
        questions: [String],
        context: String,
        generatedAt: Date,
      },
    ],
    metadata: {
      confidence: Number,
      languageCode: String,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
conversationTranscriptSchema.index({ liveConversation: 1, timestamp: 1 });
conversationTranscriptSchema.index({ pitchDeck: 1, timestamp: 1 });
conversationTranscriptSchema.index({ liveConversation: 1, isFinal: 1 });

module.exports = mongoose.model(
  "ConversationTranscript",
  conversationTranscriptSchema
);
