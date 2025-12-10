const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    // Action type (e.g., "PITCH_DECK_UPLOADED", "ANALYST_CREATED", "COMMENT_ADDED", etc.)
    actionType: {
      type: String,
      required: true,
      enum: [
        // Pitch Deck Actions
        "PITCH_DECK_UPLOADED",
        "PITCH_DECK_UPDATED",
        "PITCH_DECK_DELETED",
        "PITCH_DECK_STATUS_CHANGED",
        "PITCH_DECK_ANALYSIS_UPDATED",
        
        // User/Analyst Actions
        "ANALYST_CREATED",
        "ANALYST_DEACTIVATED",
        "ANALYST_ADDED_AS_COLLABORATOR",
        
        // Comments/Notes
        "COMMENT_ADDED",
        "COMMENT_EDITED",
        "COMMENT_DELETED",
        
        // Data Room
        "DATA_ROOM_DOCUMENT_UPLOADED",
        "DATA_ROOM_DOCUMENT_DELETED",
        "DATA_ROOM_DOCUMENT_SUMMARY_GENERATED",
        
        // Supporting Documents
        "SUPPORTING_DOCUMENT_UPLOADED",
        "SUPPORTING_DOCUMENT_DELETED",
        
        // Chat/Conversation
        "CHAT_MESSAGE_SENT",
        "CHAT_ATTACHMENT_UPLOADED",
        
        // Live Conversations/Meetings
        "MEETING_STARTED",
        "MEETING_ENDED",
        "MEETING_SUMMARY_GENERATED",
        
        // Thesis
        "THESIS_UPLOADED",
        "THESIS_UPDATED",
        "THESIS_DELETED",
        
        // Other
        "SETTINGS_UPDATED",
        "ACCESS_GRANTED",
        "ACCESS_REVOKED",
      ],
    },
    
    // Who performed the action
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    
    // Organization context
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    
    // Related entities (optional, for filtering)
    pitchDeck: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PitchDeck",
      default: null,
    },
    
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    
    commentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Comment",
      default: null,
    },
    
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    
    meetingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LiveConversation",
      default: null,
    },
    
    // Human-readable description of the action
    description: {
      type: String,
      required: true,
    },
    
    // Additional metadata (flexible for different action types)
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    
    // IP address for security tracking
    ipAddress: {
      type: String,
      default: null,
    },
    
    // User agent for browser/client tracking
    userAgent: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true, // createdAt and updatedAt
  }
);

// Indexes for efficient queries
auditLogSchema.index({ organization: 1, createdAt: -1 });
auditLogSchema.index({ pitchDeck: 1, createdAt: -1 });
auditLogSchema.index({ performedBy: 1, createdAt: -1 });
auditLogSchema.index({ actionType: 1, createdAt: -1 });
auditLogSchema.index({ organization: 1, pitchDeck: 1, createdAt: -1 }); // For pitch deck timeline

// Compound index for common queries
auditLogSchema.index({ organization: 1, actionType: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);

