const mongoose = require("mongoose");

const liveConversationSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
    },
    pitchDeck: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PitchDeck",
      required: true,
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["ACTIVE", "ENDED", "FAILED"],
      default: "ACTIVE",
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    endedAt: {
      type: Date,
    },
    totalDuration: {
      type: Number, // Duration in seconds
    },
    transcriptCount: {
      type: Number,
      default: 0,
    },
    suggestionCount: {
      type: Number,
      default: 0,
    },
    metadata: {
      audioFormat: String,
      sampleRate: Number,
      channels: Number,
      detectedLanguages: [String], // Languages detected during the meeting
      audioFileKey: String, // S3 key for the audio file
      audioFileUrl: String, // S3 URL for the audio file
      summaryRetryCount: {
        type: Number,
        default: 0,
      },
      summaryRetryAttempts: [
        {
          attemptedAt: Date,
          success: Boolean,
          error: String,
        },
      ],
    },
    summary: {
      generatedAt: Date,
      content: String,
      keyTopics: [String],
      participants: [String], // Speaker IDs or names
      duration: Number, // Duration in seconds
    },
    summaryState: {
      type: String,
      enum: ["pending", "generating", "completed", "failed"],
      default: "pending",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    suggestedQuestions: [
      {
        question: {
          type: String,
          required: true,
        },
        answered: {
          type: Boolean,
          default: false,
        },
        deleted: {
          type: Boolean,
          default: false,
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
        answeredAt: {
          type: Date,
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
liveConversationSchema.index({ pitchDeck: 1, isActive: 1 });
liveConversationSchema.index({ organization: 1, status: 1 });
liveConversationSchema.index({ createdBy: 1, createdAt: -1 });

module.exports = mongoose.model("LiveConversation", liveConversationSchema);
