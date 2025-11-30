const PitchDeck = require("../models/PitchDeck");
const Thesis = require("../models/Thesis");
const PitchDeckMessage = require("../models/PitchDeckMessage");
const SupportingDocument = require("../models/SupportingDocument");

/**
 * Retrieve complete knowledge base context for a pitch deck
 * @param {string} pitchDeckId - The pitch deck ID
 * @returns {Promise<Object>} Complete context object
 */
async function getPitchDeckContext(pitchDeckId) {
  try {
    // Fetch pitch deck with analysis
    const pitchDeck = await PitchDeck.findById(pitchDeckId)
      .populate("uploadedBy", "firstName lastName email")
      .lean();

    if (!pitchDeck) {
      throw new Error("Pitch deck not found");
    }

    // Fetch latest active thesis for the organization
    const thesis = await Thesis.findOne({
      organization: pitchDeck.organization,
      isActive: true,
    })
      .sort({ updatedAt: -1 })
      .lean();

    // Fetch all conversation messages
    const messages = await PitchDeckMessage.find({
      pitchDeck: pitchDeckId,
      isActive: true,
    })
      .populate("author", "firstName lastName email")
      .sort({ createdAt: 1 })
      .lean();

    // Fetch supporting documents
    const supportingDocs = await SupportingDocument.find({
      pitchDeck: pitchDeckId,
      isActive: true,
    })
      .populate("uploadedBy", "firstName lastName email")
      .sort({ createdAt: -1 })
      .lean();

    // Build conversation history text
    const conversationHistory = messages
      .map((msg) => {
        const author = msg.author
          ? `${msg.author.firstName} ${msg.author.lastName}`
          : "Analyst";
        const attachments =
          msg.attachments && msg.attachments.length > 0
            ? ` [Attachments: ${msg.attachments.map((a) => a.fileName).join(", ")}]`
            : "";

        const userPart = `${author}: ${msg.userQuery}${attachments}`;
        const aiPart = msg.aiResponse
          ? `AI Assistant: ${
              typeof msg.aiResponse === "string"
                ? msg.aiResponse
                : JSON.stringify(msg.aiResponse)
            }`
          : "";

        return `${userPart}\n${aiPart}`;
      })
      .join("\n\n");

    // Build supporting documents context
    const supportingDocsContext =
      supportingDocs.length > 0
        ? supportingDocs
            .map(
              (doc) =>
                `- ${doc.title}: ${doc.description || "No description"}`
            )
            .join("\n")
        : "";

    return {
      pitchDeck: {
        id: pitchDeck._id.toString(),
        title: pitchDeck.title,
        description: pitchDeck.description,
        analysis: pitchDeck.analysis || {},
        analysisVersion: pitchDeck.analysisVersion || 1,
        status: pitchDeck.status,
      },
      thesis: thesis
        ? {
            id: thesis._id.toString(),
            title: thesis.title,
            profile: thesis.profile || {},
            content: thesis.content || "",
          }
        : null,
      conversationHistory: conversationHistory || "",
      supportingDocuments: supportingDocsContext || "",
      messageCount: messages.length,
      supportingDocCount: supportingDocs.length,
    };
  } catch (error) {
    console.error("Error retrieving pitch deck context:", error);
    throw error;
  }
}

/**
 * Get a formatted context string for AI prompts
 * @param {string} pitchDeckId - The pitch deck ID
 * @returns {Promise<string>} Formatted context string
 */
async function getFormattedContext(pitchDeckId) {
  const context = await getPitchDeckContext(pitchDeckId);

  let formatted = `PITCH DECK CONTEXT:\n`;
  formatted += `Title: ${context.pitchDeck.title}\n`;
  formatted += `Status: ${context.pitchDeck.status}\n`;
  formatted += `Analysis Version: ${context.pitchDeck.analysisVersion}\n\n`;

  formatted += `PITCH DECK ANALYSIS:\n`;
  formatted += JSON.stringify(context.pitchDeck.analysis, null, 2);
  formatted += `\n\n`;

  if (context.thesis) {
    formatted += `FIRM INVESTMENT THESIS:\n`;
    formatted += `Title: ${context.thesis.title}\n`;
    if (context.thesis.profile && Object.keys(context.thesis.profile).length > 0) {
      formatted += JSON.stringify(context.thesis.profile, null, 2);
    } else if (context.thesis.content) {
      formatted += context.thesis.content;
    }
    formatted += `\n\n`;
  } else {
    formatted += `FIRM INVESTMENT THESIS: Not available\n\n`;
  }

  if (context.conversationHistory) {
    formatted += `PREVIOUS CONVERSATION HISTORY:\n`;
    formatted += context.conversationHistory;
    formatted += `\n\n`;
  }

  if (context.supportingDocuments) {
    formatted += `SUPPORTING DOCUMENTS:\n`;
    formatted += context.supportingDocuments;
    formatted += `\n\n`;
  }

  return formatted;
}

module.exports = {
  getPitchDeckContext,
  getFormattedContext,
};

