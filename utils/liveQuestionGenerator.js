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

// Rate limiting: Generate suggestions every 1 minute
const SUGGESTION_INTERVAL_MS = 60000; // 60 seconds (1 per minute)
const MIN_CONTEXT_WORDS = 50; // Minimum words needed before generating suggestions

/**
 * Normalize a question for comparison (lowercase, remove punctuation, trim)
 * @param {string} question - The question to normalize
 * @returns {string} Normalized question
 */
function normalizeQuestion(question) {
  if (!question || typeof question !== "string") return "";
  return question
    .toLowerCase()
    .replace(/[^\w\s]/g, " ") // Replace punctuation with spaces
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
}

/**
 * Calculate similarity between two questions using word overlap
 * @param {string} q1 - First question
 * @param {string} q2 - Second question
 * @returns {number} Similarity score between 0 and 1
 */
function calculateQuestionSimilarity(q1, q2) {
  const normalized1 = normalizeQuestion(q1);
  const normalized2 = normalizeQuestion(q2);

  // Exact match after normalization
  if (normalized1 === normalized2) return 1.0;

  // Extract words (excluding common stop words)
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "as",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "should",
    "could",
    "can",
    "may",
    "might",
    "must",
    "this",
    "that",
    "these",
    "those",
    "what",
    "which",
    "who",
    "whom",
    "whose",
    "where",
    "when",
    "why",
    "how",
    "if",
    "then",
    "than",
    "so",
    "about",
    "into",
    "onto",
    "upon",
    "over",
    "under",
    "above",
    "below",
    "between",
    "among",
  ]);

  const words1 = normalized1
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
  const words2 = normalized2
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  if (words1.length === 0 || words2.length === 0) return 0;

  // Calculate Jaccard similarity (intersection over union)
  const set1 = new Set(words1);
  const set2 = new Set(words2);

  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  const union = new Set([...set1, ...set2]);

  return intersection.size / union.size;
}

/**
 * Check if a question is too similar to existing questions
 * @param {string} newQuestion - The new question to check
 * @param {Array<string>} existingQuestions - Array of existing question texts
 * @param {number} similarityThreshold - Threshold for similarity (default 0.7)
 * @returns {boolean} True if question is too similar to existing ones
 */
function isQuestionDuplicate(
  newQuestion,
  existingQuestions,
  similarityThreshold = 0.7
) {
  if (!newQuestion || !existingQuestions || existingQuestions.length === 0) {
    return false;
  }

  for (const existingQ of existingQuestions) {
    const similarity = calculateQuestionSimilarity(newQuestion, existingQ);
    if (similarity >= similarityThreshold) {
      return true;
    }
  }

  return false;
}

/**
 * Filter out duplicate questions from a list
 * @param {Array<string>} questions - Array of questions to filter
 * @param {Array<string>} existingQuestions - Array of existing questions to compare against
 * @param {number} similarityThreshold - Threshold for similarity (default 0.7)
 * @returns {Array<string>} Filtered array of unique questions
 */
function filterDuplicateQuestions(
  questions,
  existingQuestions = [],
  similarityThreshold = 0.7
) {
  if (!questions || questions.length === 0) return [];

  const filtered = [];
  const seen = new Set();

  for (const question of questions) {
    const normalized = normalizeQuestion(question);

    // Skip if already seen in this batch
    if (seen.has(normalized)) {
      continue;
    }

    // Skip if too similar to existing questions
    if (isQuestionDuplicate(question, existingQuestions, similarityThreshold)) {
      console.log(
        `[QUESTION-DEDUP] Filtered duplicate question: "${question.substring(
          0,
          60
        )}..."`
      );
      continue;
    }

    filtered.push(question);
    seen.add(normalized);
  }

  return filtered;
}

/**
 * Generate question suggestions based on live conversation and knowledge base
 * @param {string} pitchDeckId - The pitch deck ID
 * @param {Array<Object>} recentTranscripts - Array of recent transcript entries with {text, timestamp}
 * @param {Date} lastSuggestionTime - Timestamp of last suggestion generation
 * @param {Array<string>} existingQuestions - Array of existing question texts to avoid duplicates
 * @returns {Promise<Object>} Question suggestions with context
 */
async function generateQuestionSuggestions(
  pitchDeckId,
  recentTranscripts = [],
  lastSuggestionTime = null,
  existingQuestions = []
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
}${
      existingQuestions && existingQuestions.length > 0
        ? `- CRITICAL: Do NOT generate questions that are similar or duplicate to these existing questions:\n${existingQuestions
            .map((q, i) => `  ${i + 1}. "${q}"`)
            .join(
              "\n"
            )}\n- Ensure all generated questions are meaningfully different from the existing ones\n`
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
      // Filter out duplicate questions
      const filteredQuestions = filterDuplicateQuestions(
        parsed.questions || [],
        existingQuestions,
        0.7 // 70% similarity threshold
      );

      if (filteredQuestions.length === 0) {
        console.log(
          "[QUESTION-DEDUP] All generated questions were filtered as duplicates. Returning null."
        );
        return null;
      }

      return {
        questions: filteredQuestions,
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
  filterDuplicateQuestions,
  isQuestionDuplicate,
  calculateQuestionSimilarity,
  SUGGESTION_INTERVAL_MS,
  MIN_CONTEXT_WORDS,
};
