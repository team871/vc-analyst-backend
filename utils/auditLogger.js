const AuditLog = require("../models/AuditLog");

/**
 * Log an action to the audit trail
 * @param {Object} params - Audit log parameters
 * @param {string} params.actionType - Type of action (from enum in AuditLog model)
 * @param {ObjectId} params.performedBy - User ID who performed the action
 * @param {ObjectId} params.organization - Organization ID
 * @param {string} params.description - Human-readable description
 * @param {ObjectId} params.pitchDeck - Optional pitch deck ID
 * @param {ObjectId} params.userId - Optional user ID (for user-related actions)
 * @param {ObjectId} params.commentId - Optional comment ID
 * @param {ObjectId} params.documentId - Optional document ID
 * @param {ObjectId} params.meetingId - Optional meeting ID
 * @param {Object} params.metadata - Optional additional metadata
 * @param {string} params.ipAddress - Optional IP address
 * @param {string} params.userAgent - Optional user agent
 */
async function logAction({
  actionType,
  performedBy,
  organization,
  description,
  pitchDeck = null,
  userId = null,
  commentId = null,
  documentId = null,
  meetingId = null,
  metadata = {},
  ipAddress = null,
  userAgent = null,
}) {
  try {
    const auditLog = new AuditLog({
      actionType,
      performedBy,
      organization,
      description,
      pitchDeck,
      userId,
      commentId,
      documentId,
      meetingId,
      metadata,
      ipAddress,
      userAgent,
    });

    await auditLog.save();
    return auditLog;
  } catch (error) {
    // Don't throw errors - audit logging should never break the main flow
    console.error("Audit logging error:", error);
    return null;
  }
}

/**
 * Helper function to extract IP address from Express request
 */
function getIpAddress(req) {
  return (
    req.ip ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    null
  );
}

/**
 * Helper function to get user agent from Express request
 */
function getUserAgent(req) {
  return req.headers["user-agent"] || null;
}

/**
 * Convenience functions for common actions
 */

async function logPitchDeckUpload(pitchDeckId, userId, organizationId, title, req = null) {
  return logAction({
    actionType: "PITCH_DECK_UPLOADED",
    performedBy: userId,
    organization: organizationId,
    pitchDeck: pitchDeckId,
    description: `Uploaded pitch deck: "${title}"`,
    metadata: { pitchDeckTitle: title },
    ipAddress: req ? getIpAddress(req) : null,
    userAgent: req ? getUserAgent(req) : null,
  });
}

async function logPitchDeckStatusChange(pitchDeckId, userId, organizationId, oldStatus, newStatus, req = null) {
  return logAction({
    actionType: "PITCH_DECK_STATUS_CHANGED",
    performedBy: userId,
    organization: organizationId,
    pitchDeck: pitchDeckId,
    description: `Changed pitch deck status from "${oldStatus}" to "${newStatus}"`,
    metadata: { oldStatus, newStatus },
    ipAddress: req ? getIpAddress(req) : null,
    userAgent: req ? getUserAgent(req) : null,
  });
}

async function logAnalystCreated(analystId, createdBy, organizationId, analystName, req = null) {
  return logAction({
    actionType: "ANALYST_CREATED",
    performedBy: createdBy,
    organization: organizationId,
    userId: analystId,
    description: `Added analyst: ${analystName}`,
    metadata: { analystName, analystId: analystId.toString() },
    ipAddress: req ? getIpAddress(req) : null,
    userAgent: req ? getUserAgent(req) : null,
  });
}

async function logAnalystDeactivated(analystId, deactivatedBy, organizationId, analystName, req = null) {
  return logAction({
    actionType: "ANALYST_DEACTIVATED",
    performedBy: deactivatedBy,
    organization: organizationId,
    userId: analystId,
    description: `Deactivated analyst: ${analystName}`,
    metadata: { analystName, analystId: analystId.toString() },
    ipAddress: req ? getIpAddress(req) : null,
    userAgent: req ? getUserAgent(req) : null,
  });
}

async function logCommentAdded(commentId, pitchDeckId, userId, organizationId, contentPreview, req = null) {
  const preview = contentPreview.length > 100 ? contentPreview.substring(0, 100) + "..." : contentPreview;
  return logAction({
    actionType: "COMMENT_ADDED",
    performedBy: userId,
    organization: organizationId,
    pitchDeck: pitchDeckId,
    commentId: commentId,
    description: `Added note: "${preview}"`,
    metadata: { contentPreview: preview },
    ipAddress: req ? getIpAddress(req) : null,
    userAgent: req ? getUserAgent(req) : null,
  });
}

async function logDataRoomDocumentUploaded(documentId, pitchDeckId, userId, organizationId, documentTitle, req = null) {
  return logAction({
    actionType: "DATA_ROOM_DOCUMENT_UPLOADED",
    performedBy: userId,
    organization: organizationId,
    pitchDeck: pitchDeckId,
    documentId: documentId,
    description: `Uploaded data room document: "${documentTitle}"`,
    metadata: { documentTitle },
    ipAddress: req ? getIpAddress(req) : null,
    userAgent: req ? getUserAgent(req) : null,
  });
}

async function logChatMessage(pitchDeckId, userId, organizationId, messagePreview, req = null) {
  const preview = messagePreview.length > 100 ? messagePreview.substring(0, 100) + "..." : messagePreview;
  return logAction({
    actionType: "CHAT_MESSAGE_SENT",
    performedBy: userId,
    organization: organizationId,
    pitchDeck: pitchDeckId,
    description: `Sent chat message: "${preview}"`,
    metadata: { messagePreview: preview },
    ipAddress: req ? getIpAddress(req) : null,
    userAgent: req ? getUserAgent(req) : null,
  });
}

async function logMeetingStarted(meetingId, pitchDeckId, userId, organizationId, meetingTitle, req = null) {
  return logAction({
    actionType: "MEETING_STARTED",
    performedBy: userId,
    organization: organizationId,
    pitchDeck: pitchDeckId,
    meetingId: meetingId,
    description: `Started meeting: "${meetingTitle}"`,
    metadata: { meetingTitle },
    ipAddress: req ? getIpAddress(req) : null,
    userAgent: req ? getUserAgent(req) : null,
  });
}

async function logMeetingEnded(meetingId, pitchDeckId, userId, organizationId, meetingTitle, duration, req = null) {
  return logAction({
    actionType: "MEETING_ENDED",
    performedBy: userId,
    organization: organizationId,
    pitchDeck: pitchDeckId,
    meetingId: meetingId,
    description: `Ended meeting: "${meetingTitle}" (Duration: ${duration} seconds)`,
    metadata: { meetingTitle, duration },
    ipAddress: req ? getIpAddress(req) : null,
    userAgent: req ? getUserAgent(req) : null,
  });
}

async function logPitchDeckDeleted(pitchDeckId, userId, organizationId, pitchDeckTitle, req = null) {
  return logAction({
    actionType: "PITCH_DECK_DELETED",
    performedBy: userId,
    organization: organizationId,
    pitchDeck: pitchDeckId,
    description: `Deleted pitch deck: "${pitchDeckTitle}"`,
    metadata: { pitchDeckTitle },
    ipAddress: req ? getIpAddress(req) : null,
    userAgent: req ? getUserAgent(req) : null,
  });
}

module.exports = {
  logAction,
  logPitchDeckUpload,
  logPitchDeckStatusChange,
  logAnalystCreated,
  logAnalystDeactivated,
  logCommentAdded,
  logDataRoomDocumentUploaded,
  logChatMessage,
  logMeetingStarted,
  logMeetingEnded,
  logPitchDeckDeleted,
  getIpAddress,
  getUserAgent,
};

