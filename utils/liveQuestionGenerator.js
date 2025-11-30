const OpenAI = require("openai");
const { getFormattedContext } = require("./contextRetrieval");
const { tryParseJson, stripCodeFences } = require("./helpers");

// Initialize OpenAI client
let openaiClient = null;
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY not set. Question generation will not work."
    );
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return openaiClient;
}

// Rate limiting: Generate suggestions every 30-60 seconds
const SUGGESTION_INTERVAL_MS = 45000; // 45 seconds
const MIN_CONTEXT_WORDS = 50; // Minimum words needed before generating suggestions

/**
 * Generate question suggestions based on live conversation and knowledge base
 * @param {string} pitchDeckId - The pitch deck ID
 * @param {Array<Object>} recentTranscripts - Array of recent transcript entries with {text, timestamp}
 * @param {Date} lastSuggestionTime - Timestamp of last suggestion generation
 * @returns {Promise<Object>} Question suggestions with context
 */
async function generateQuestionSuggestions(
  pitchDeckId,
  recentTranscripts = [],
  lastSuggestionTime = null
) {
  try {
    // Check rate limiting (skip if lastSuggestionTime is null, e.g., for initial questions)
    if (lastSuggestionTime !== null) {
      const now = Date.now();
      if (now - lastSuggestionTime < SUGGESTION_INTERVAL_MS) {
        return null; // Too soon to generate new suggestions
      }
    }

    // Build conversation context from recent transcripts (last 2-3 minutes)
    const conversationText = recentTranscripts
      .map((t) => t.text)
      .join(" ")
      .trim();

    // Check if we have enough context (skip for initial questions when lastSuggestionTime is null)
    const wordCount = conversationText
      .split(/\s+/)
      .filter((w) => w.length > 0).length;

    const isInitialGeneration = lastSuggestionTime === null;

    // For non-initial generations, require minimum word count
    if (!isInitialGeneration && wordCount < MIN_CONTEXT_WORDS) {
      return null; // Not enough conversation yet
    }

    // Get complete knowledge base context
    const knowledgeBaseContext = await getFormattedContext(pitchDeckId);

    // Build prompt for OpenAI
    const conversationSection = conversationText
      ? `RECENT CONVERSATION (last 2-3 minutes):
${conversationText}`
      : `RECENT CONVERSATION:
The meeting has just started. No conversation transcript available yet.`;

    const prompt = `You are DealFlow AI — an AI assistant for Venture Capital analysts during live pitch meetings.

Your role: Suggest relevant questions the analyst should ask to gather critical information, validate assumptions, or explore important topics.

KNOWLEDGE BASE CONTEXT:
${knowledgeBaseContext}

${conversationSection}

TASK:
${
  isInitialGeneration
    ? "Generate 3-5 strategic opening questions the analyst should ask at the start of the meeting based on the pitch deck analysis and firm thesis."
    : "Based on the knowledge base (pitch deck analysis, firm thesis, previous conversations) and the recent conversation, generate 3-5 strategic questions the analyst should ask next."
}

Guidelines:
- Questions should be specific, actionable, and relevant${
      isInitialGeneration
        ? " to the pitch deck and investment thesis"
        : " to what's being discussed"
    }
- Focus on gaps in information, validation of claims, or deeper exploration of key topics
- Consider the firm's investment thesis and fit assessment
- Questions should help the analyst make a better investment decision
${
  !isInitialGeneration
    ? "- Avoid questions that have already been answered in the conversation\n"
    : ""
}- Make questions natural and conversational (not overly formal)

Return your response as a JSON object with this structure:
{
  "questions": [
    "Question 1 here",
    "Question 2 here",
    "Question 3 here"
  ],
  "context": "Brief explanation of why these questions are relevant (1-2 sentences)",
  "topics": ["topic1", "topic2"] // Key topics these questions address
}

Output valid JSON only.`;

    // Call OpenAI
    const client = getOpenAIClient();
    const completion = await client.chat.completions.create({
      model: "gpt-4o", // Using GPT-4o for high-quality question generation
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

    if (parsed && typeof parsed === "object" && parsed.questions) {
      return {
        questions: parsed.questions || [],
        context:
          parsed.context || "Based on recent conversation and knowledge base",
        topics: parsed.topics || [],
        generatedAt: new Date(),
        conversationWordCount: wordCount,
      };
    } else {
      // Fallback: extract questions from text
      const text = stripCodeFences(responseText) || "";
      const questionMatches = text.match(/\d+[\.\)]\s*([^\n?]+\?)/g) || [];
      const questions = questionMatches
        .map((q) => q.replace(/^\d+[\.\)]\s*/, "").trim())
        .filter((q) => q.length > 10);

      return {
        questions:
          questions.length > 0
            ? questions
            : ["Continue the conversation to gather more information."],
        context: "Generated from conversation analysis",
        topics: [],
        generatedAt: new Date(),
        conversationWordCount: wordCount,
      };
    }
  } catch (error) {
    console.error("Error generating question suggestions:", error);
    // Return fallback suggestions
    return {
      questions: [
        "Can you elaborate on that?",
        "What are the key metrics you're tracking?",
        "How does this compare to your competitors?",
      ],
      context: "Fallback suggestions due to AI error",
      topics: [],
      generatedAt: new Date(),
      conversationWordCount: 0,
    };
  }
}

/**
 * Determine if we should generate new suggestions based on conversation changes
 * @param {Array<Object>} recentTranscripts - Recent transcript entries
 * @param {Date} lastSuggestionTime - Last suggestion timestamp
 * @param {string} lastTopic - Last topic discussed
 * @returns {boolean} Whether to generate new suggestions
 */
function shouldGenerateSuggestions(
  recentTranscripts,
  lastSuggestionTime,
  lastTopic = null
) {
  // Check time interval
  const now = Date.now();
  if (lastSuggestionTime && now - lastSuggestionTime < SUGGESTION_INTERVAL_MS) {
    return false;
  }

  // Check if there's enough new conversation
  const recentText = recentTranscripts
    .map((t) => t.text)
    .join(" ")
    .trim();
  const wordCount = recentText.split(/\s+/).filter((w) => w.length > 0).length;

  if (wordCount < MIN_CONTEXT_WORDS) {
    return false;
  }

  // Could add topic change detection here in the future
  return true;
}

module.exports = {
  generateQuestionSuggestions,
  shouldGenerateSuggestions,
  SUGGESTION_INTERVAL_MS,
  MIN_CONTEXT_WORDS,
};
