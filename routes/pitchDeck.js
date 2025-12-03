const express = require("express");
const { body, validationResult } = require("express-validator");
const PitchDeck = require("../models/PitchDeck");
const Thesis = require("../models/Thesis");
const Comment = require("../models/Comment");
const PitchDeckMessage = require("../models/PitchDeckMessage");
const SupportingDocument = require("../models/SupportingDocument");
const { authMiddleware, requireSAOrAnalyst } = require("../middleware/auth");
const {
  upload,
  uploadToS3,
  generateFileKey,
  generateSignedUrl,
} = require("../utils/s3Upload");
const Perplexity = require("@perplexity-ai/perplexity_ai");
const fs = require("fs");
const { tryParseJson, stripCodeFences } = require("../utils/helpers");

const router = express.Router();
const perplexity = new Perplexity({
  apiKey: process.env.PERPLEXITY_API_KEY, // if not already set
  timeout: 600000, // 10 minutes in ms; tweak lower/higher as you like
  maxRetries: 3,
});

// Helper: normalize opportunity/risk object to string
function normalizeOpportunityOrRisk(item) {
  if (typeof item === "string") {
    return item;
  }
  if (typeof item === "object" && item !== null) {
    // Convert structured object to readable string
    const parts = [];
    if (item.category) parts.push(`[${item.category}]`);
    if (item.opportunity) parts.push(item.opportunity);
    if (item.risk) parts.push(item.risk);
    if (item.description) parts.push(item.description);
    if (item.impact) parts.push(`Impact: ${item.impact}`);
    return parts.join(" - ");
  }
  return String(item);
}

// Helper: normalize analysis object (clean weird summary formatting, code fences, nested JSON, etc.)
function normalizeAnalysisObject(analysis) {
  if (!analysis || typeof analysis !== "object") return analysis;
  const normalized = { ...analysis };

  // Clean summary field if it's a string containing JSON or code fences
  if (typeof normalized.summary === "string") {
    let s = stripCodeFences(normalized.summary || "").trim();

    // If summary itself looks like JSON with a nested "summary", unwrap it
    const nested = tryParseJson(s);
    if (nested && typeof nested === "object") {
      if (typeof nested.summary === "string") {
        s = nested.summary;
      } else {
        // Fallback: if it's JSON but no nested summary, just stringify succinctly
        s = JSON.stringify(nested);
      }
    }

    // Final cleanup of any surrounding single or double quotes
    s = s.replace(/^['"]+|['"]+$/g, "").trim();
    normalized.summary = s;
  }

  // Normalize opportunities array (convert objects to strings)
  if (Array.isArray(normalized.opportunities)) {
    normalized.opportunities = normalized.opportunities.map(
      normalizeOpportunityOrRisk
    );
  }

  // Normalize risks array (convert objects to strings)
  if (Array.isArray(normalized.risks)) {
    normalized.risks = normalized.risks.map(normalizeOpportunityOrRisk);
  }

  return normalized;
}

// Helper: generate a detailed sector analysis using Perplexity based on the existing pitch deck analysis
async function generateSectorAnalysisForPitchDeck(pdRecord, baseAnalysis) {
  try {
    if (!pdRecord || !baseAnalysis) return null;

    const summary = baseAnalysis.summary || "";
    const keyPoints = Array.isArray(baseAnalysis.keyPoints)
      ? baseAnalysis.keyPoints
      : [];
    const businessModel = baseAnalysis.businessModel || "";
    const marketSize = baseAnalysis.marketSize || "";

    const sectorPrompt = `You are DealFlow AI — an AI assistant for Venture Capital analysts.

Your specific task now is to perform a **deep, standalone SECTOR / INDUSTRY ANALYSIS** for a given startup, using **live internet search**.

You are NOT re-analyzing the pitch deck itself. Instead, you are analyzing the broader market/sector in which this startup operates.

Startup context from the pitch deck analysis:
- Summary: ${summary}
- Key Points: ${keyPoints.join("; ")}
- Business Model: ${businessModel}
- Market Size (from deck): ${marketSize}

Using this context, infer the most relevant sector/subsector for this company and then perform a detailed sector analysis with web search.

Return STRICTLY a JSON object with this structure:
{
  "sectorAnalysis": {
    "sector": "High-level sector name (e.g., Fintech, Digital Health, Climate Tech).",
    "subSector": "More specific niche if possible (e.g., BNPL, telemedicine, carbon accounting).",
    "marketTrends": "2-4 paragraphs describing current trends, adoption curves, regulatory dynamics, and key structural shifts in this sector. Use recent data and web sources.",
    "recentNews": [
      "3-7 bullet points of very recent news or developments in the sector with 1-line explanation each."
    ],
    "competitorNews": [
      "3-7 bullet points of recent news or updates about notable competitors or comparable companies in this space (funding rounds, launches, exits, regulatory issues, etc.)."
    ],
    "regulatoryEnvironment": "Overview of relevant regulations, data privacy / safety rules, and any upcoming regulatory changes that matter for this sector.",
    "macroTailwinds": [
      "3-5 bullets on macro trends that help this sector (e.g., digitisation, demographic shifts, AI adoption, etc.)."
    ],
    "macroHeadwinds": [
      "3-5 bullets on macro risks or headwinds (e.g., funding slowdown, regulation, saturation, pricing pressure)."
    ],
    "investorSentiment": "Short overview (1-2 paragraphs) of how venture / growth investors currently view this sector (hot / cooling, typical valuation ranges, round dynamics).",
    "relevantInsights": "Any other important context that would help an investor evaluate this opportunity in the broader market.",
    "sources": [
      {
        "title": "Article or source title",
        "url": "https://example.com/article",
        "date": "Publication date if available",
        "summary": "Brief summary of key information from this source"
      }
    ]
  }
}

CRITICAL RULES:
- Use web search heavily to ground your analysis in **current** data.
- Prefer high-quality sources (consulting reports, industry publications, major tech/business media, regulatory bodies).
- Include at least 5 distinct sources if possible.
- Output **valid JSON only**. No markdown, no backticks, no commentary.`;

    const completion = await perplexity.chat.completions.create({
      model: "sonar-pro",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: sectorPrompt,
            },
          ],
        },
      ],
    });

    const sectorText = completion.choices[0].message.content;
    const parsed = tryParseJson(sectorText);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const sectorAnalysis = parsed.sectorAnalysis || parsed;
    return sectorAnalysis;
  } catch (error) {
    console.error("Sector analysis generation error:", error);
    return null;
  }
}

// Upload pitch deck
router.post(
  "/upload",
  authMiddleware,
  requireSAOrAnalyst,
  upload.single("pitchDeck"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const { title, description } = req.body;
      if (!title) {
        return res.status(400).json({ message: "Title is required" });
      }

      // Convert file to base64 for analysis
      const encodedFile = req.file.buffer.toString("base64");

      // Create pitch deck record first (without S3 URLs)
      const pitchDeck = new PitchDeck({
        title,
        description: description || "",
        originalFileUrl: "", // Will be set after S3 upload
        originalFileKey: "", // Will be set after S3 upload
        organization: req.user.organization._id,
        uploadedBy: req.user._id,
        status: "ANALYZING",
        metadata: {
          fileSize: req.file.size,
          fileType: req.file.mimetype,
          uploadDate: new Date(),
        },
      });

      await pitchDeck.save();

      // Fire-and-forget background AI analysis (with base64 file)
      const pitchDeckId = pitchDeck._id;
      const fileName = req.file.originalname;
      const fileForUpload = req.file;

      setImmediate(() => {
        analyzePitchDeckWithBase64(
          pitchDeckId,
          encodedFile,
          fileName,
          fileForUpload
        ).catch((err) => {
          console.error(
            `Background pitch deck analysis failed for ${pitchDeckId}:`,
            err
          );
        });
      });

      res.status(201).json({
        message: "Pitch deck uploaded; analysis is running in the background",
        pitchDeck: {
          id: pitchDeck._id,
          title: pitchDeck.title,
          description: pitchDeck.description,
          status: pitchDeck.status,
          uploadedAt: pitchDeck.createdAt,
          analysis: null,
          analysisPending: true,
        },
      });
    } catch (error) {
      console.error("Pitch deck upload error:", error);
      res.status(500).json({ message: "Server error during upload" });
    }
  }
);

// Background AI analysis function with base64 file
async function analyzePitchDeckWithBase64(
  pitchDeckId,
  encodedFile,
  fileName,
  fileBuffer
) {
  try {
    // Update status to analyzing
    await PitchDeck.findByIdAndUpdate(pitchDeckId, { status: "ANALYZING" });

    const startTime = Date.now();

    // Fetch latest active thesis for this organization to assess fit
    const pdRecord = await PitchDeck.findById(pitchDeckId).lean();
    const latestThesis = await Thesis.findOne({
      organization: pdRecord.organization,
      isActive: true,
    })
      .sort({ updatedAt: -1 })
      .lean();

    // Generate AI analysis using Perplexity with retries
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function callPerplexityWithRetry(maxAttempts = 3) {
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await perplexity.chat.completions.create({
            model: "sonar-pro",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `You are DealFlow AI — an AI assistant for Venture Capital analysts.

Your job: Analyze startup pitch decks and produce a structured, investment-grade Pre-Read report focused on (a) understanding the business.

Input: A pitch deck (PDF) and optional analyst comments.
Output: A single JSON object — concise, factual, and well-structured.

Rules:
• Extract insights only from the pitch deck — no external data or assumptions.
• Do NOT perform external web search in this step; focus purely on deck content.
• If information is missing, mark as "unknown" and briefly note what's missing.
• Be objective, evidence-based, and avoid speculation or hype.
• Summaries must be concise yet capture key strategic and financial details.

Return this JSON structure:

{
  "summary": "Overall description of what the startup does and its core value proposition (2-3 sentences).",
  "keyPoints": ["3-6 bullets of important takeaways about problem, solution, traction, team, etc."],
  "marketSize": "Quantify TAM/SAM/SOM if given; else describe qualitatively or mark 'unknown'.",
  "businessModel": "How the company makes money; pricing type and customer segment.",
  "competitiveAdvantage": "Summarize differentiators, defensibility, or moat.",
  "team": "Founders, experience, credibility signals, and team gaps.",
  "financials": {
    "traction": "Revenue, users, MRR, growth — or 'unknown'.",
    "fundraising": "Ask amount and intended use of funds.",
    "unitEconomics": "CAC/LTV/gross margin if given — else 'unknown'."
  },
  "risks": ["List key risks or red flags found in deck."],
  "opportunities": ["List 3-5 growth opportunities or strengths."],
  "recommendation": "One of: 'Pass', 'Request More Info', 'Schedule Meeting', or 'Proceed to Diligence'. Include 1-line rationale.",
  "confidenceScore": 1-10,
  "fitAssessment": {
    "overallFit": "STRONG | PARTIAL | WEAK",
    "rationale": "Explain main reasons for this fit rating.",
    "alignment": {
      "sectors": [{ "match": true/false, "details": "text or 'unknown'" }],
      "stage": [{ "match": true/false, "details": "text or 'unknown'" }],
      "geography": [{ "match": true/false, "details": "text or 'unknown'" }],
      "checkSize": { "match": true/false, "details": "text or 'unknown'" },
      "ownershipTargets": { "match": true/false, "details": "text or 'unknown'" },
      "timeHorizon": { "match": true/false, "details": "text or 'unknown'" },
      "returnTargets": { "match": true/false, "details": "text or 'unknown'" },
      "riskTolerance": { "match": true/false, "details": "text or 'unknown'" },
      "constraintsAndExclusions": [{ "violated": true/false, "details": "text or 'unknown'" }]
    },
    "openQuestions": ["Top 5 questions the analyst should ask to validate assumptions."]
  }
}

Keep tone professional, clear, and investor-grade. Output valid JSON only.

Firm thesis (JSON below). Use it strictly to assess fit; do not alter it.
${
  latestThesis && latestThesis.profile
    ? JSON.stringify(latestThesis.profile)
    : latestThesis && latestThesis.content
    ? String(latestThesis.content)
    : "No firm thesis available."
}`,
                  },

                  {
                    type: "file_url",
                    file_url: {
                      url: encodedFile, // base64 string without data: prefix
                    },
                    file_name: fileName,
                  },
                ],
              },
            ],
          });
        } catch (err) {
          console.log(err);
          lastError = err;
          const status = err && err.status ? err.status : 0;
          // Retry on transient provider/network errors (5xx or connection issues)
          if (status >= 500 || status === 0) {
            const backoffMs =
              attempt === 1 ? 1000 : attempt === 2 ? 3000 : 7000;
            await sleep(backoffMs);
            continue;
          }
          throw err;
        }
      }
      throw lastError;
    }

    const completion = await callPerplexityWithRetry(3);

    const analysisText = completion.choices[0].message.content;

    // Try to parse JSON response, fallback to structured text if needed
    const parsed = tryParseJson(analysisText);
    let analysis;
    if (parsed && typeof parsed === "object") {
      analysis = parsed;
    } else {
      // If JSON parsing fails, create structured analysis from text
      const text = stripCodeFences(analysisText) || "";
      analysis = {
        summary: text,
        keyPoints: text
          .split("\n")
          .filter((line) => line.trim().startsWith("-"))
          .map((line) => line.replace(/^ -?\s*/, "")),
        marketSize: "Analysis available in summary",
        businessModel: "Analysis available in summary",
        competitiveAdvantage: "Analysis available in summary",
        team: "Analysis available in summary",
        financials: "Analysis available in summary",
        risks: ["See detailed analysis"],
        opportunities: ["See detailed analysis"],
        recommendation: "See detailed analysis",
        confidenceScore: 7,
        fitAssessment: {
          overallFit: latestThesis ? "PARTIAL" : "UNKNOWN",
          rationale: latestThesis
            ? "Heuristic fallback fit due to non-JSON AI response. Review manually."
            : "No thesis available to assess fit.",
          alignment: {
            sectors: [],
            stage: [],
            geography: [],
            checkSize: { match: false, details: "Unknown" },
            ownershipTargets: { match: false, details: "Unknown" },
            timeHorizon: { match: false, details: "Unknown" },
            returnTargets: { match: false, details: "Unknown" },
            riskTolerance: { match: false, details: "Unknown" },
            constraintsAndExclusions: [],
          },
          openQuestions: [],
        },
      };
    }

    // Normalize analysis (fix weird summary formatting, nested JSON, code fences, etc.)
    analysis = normalizeAnalysisObject(analysis);

    // Generate separate, detailed sector analysis using web search
    const sectorAnalysis = await generateSectorAnalysisForPitchDeck(
      pdRecord,
      analysis
    );
    if (sectorAnalysis) {
      analysis.sectorAnalysis = sectorAnalysis;
    }

    const endTime = Date.now();
    const analysisDuration = endTime - startTime;

    // Upload file to S3 after successful analysis
    const fileKey = generateFileKey(
      fileName,
      pdRecord.organization,
      "pitch-decks"
    );
    // fileBuffer is actually req.file object with buffer and mimetype
    const fileUrl = await uploadToS3(fileBuffer, fileKey);

    // Save to analysis history
    const analysisRecord = {
      version: 1,
      analysis: {
        ...analysis,
        analysisDate: new Date(),
        aiModel: "sonar-pro",
      },
      analysisRaw: analysisText,
      analysisDate: new Date(),
      trigger: "initial",
    };

    // Update pitch deck with analysis and S3 URLs
    const updatedPitchDeck = await PitchDeck.findOneAndUpdate(
      { _id: pitchDeckId },
      {
        $set: {
          analysis: {
            ...analysis,
            analysisDate: new Date(),
            aiModel: "sonar-pro",
          },
          analysisRaw: analysisText,
          analysisVersion: 1,
          status: "COMPLETED",
          originalFileUrl: fileUrl,
          originalFileKey: fileKey,
          "metadata.analysisDuration": analysisDuration,
        },
        $push: {
          analysisHistory: analysisRecord,
        },
      },
      { new: true }
    );

    // Create initial message with analysis (special case: no user query for initial analysis)
    await PitchDeckMessage.create({
      pitchDeck: pitchDeckId,
      author: pdRecord.uploadedBy,
      organization: pdRecord.organization,
      userQuery: "[Initial pitch deck upload]",
      attachments: [],
      aiResponse: analysis,
      responseType: "initial",
      requiresAnalysisUpdate: true,
      analysisVersion: 1,
      metadata: {
        processingTime: analysisDuration,
        model: "sonar-pro",
      },
    });

    console.log(
      `Pitch deck ${pitchDeckId} analysis completed in ${analysisDuration}ms`
    );

    return updatedPitchDeck;
  } catch (error) {
    console.error("Pitch deck analysis error:", error);
    await PitchDeck.findByIdAndUpdate(pitchDeckId, {
      status: "FAILED",
      analysis: {
        summary: "Analysis failed. Please try again later.",
        keyPoints: [],
        marketSize: "Analysis failed",
        businessModel: "Analysis failed",
        competitiveAdvantage: "Analysis failed",
        team: "Analysis failed",
        financials: "Analysis failed",
        risks: ["Analysis failed"],
        opportunities: ["Analysis failed"],
        recommendation: "Analysis failed",
        confidenceScore: 0,
        sectorAnalysis: {
          marketTrends: "Analysis failed",
          recentNews: [],
          competitorNews: [],
          relevantInsights: "Analysis failed",
          sources: [],
        },
        analysisDate: new Date(),
        aiModel: "sonar-pro",
      },
    });
  }
}

// Get pitch decks (SA can see all, Analysts see only their own)
router.get("/", authMiddleware, requireSAOrAnalyst, async (req, res) => {
  try {
    const query = {
      organization: req.user.organization._id,
      isActive: true,
    };

    // Analysts can only see their own pitch decks
    if (req.user.role === "ANALYST") {
      query.uploadedBy = req.user._id;
    }

    const pitchDecks = await PitchDeck.find(query)
      .populate("uploadedBy", "firstName lastName email")
      .sort({ createdAt: -1 });

    res.json({ pitchDecks });
  } catch (error) {
    console.error("Get pitch decks error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Get sector analysis for a specific pitch deck (optionally recompute with ?refresh=true)
router.get(
  "/:id/sector-analysis",
  authMiddleware,
  requireSAOrAnalyst,
  async (req, res) => {
    try {
      const query = {
        _id: req.params.id,
        organization: req.user.organization._id,
        isActive: true,
      };

      // Analysts can only see their own pitch decks
      if (req.user.role === "ANALYST") {
        query.uploadedBy = req.user._id;
      }

      const pitchDeck = await PitchDeck.findOne(query);
      if (!pitchDeck) {
        return res.status(404).json({ message: "Pitch deck not found" });
      }

      let sectorAnalysis =
        pitchDeck.analysis && pitchDeck.analysis.sectorAnalysis
          ? pitchDeck.analysis.sectorAnalysis
          : null;

      const shouldRefresh =
        req.query.refresh && String(req.query.refresh).toLowerCase() === "true";

      // If missing or refresh requested and we have a base analysis, recompute
      if ((!sectorAnalysis || shouldRefresh) && pitchDeck.analysis) {
        const baseAnalysis = normalizeAnalysisObject(
          pitchDeck.analysis.toObject
            ? pitchDeck.analysis.toObject()
            : pitchDeck.analysis
        );
        const newSector = await generateSectorAnalysisForPitchDeck(
          pitchDeck,
          baseAnalysis
        );
        if (newSector) {
          sectorAnalysis = newSector;
          await PitchDeck.findByIdAndUpdate(pitchDeck._id, {
            $set: {
              "analysis.sectorAnalysis": sectorAnalysis,
            },
          });
        }
      }

      if (!sectorAnalysis) {
        return res.status(404).json({
          message:
            "Sector analysis not available yet. Run initial analysis first or try again later.",
        });
      }

      res.json({
        pitchDeckId: pitchDeck._id.toString(),
        sectorAnalysis,
      });
    } catch (error) {
      console.error("Get sector analysis error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Get live sessions for a pitch deck
router.get(
  "/:id/live-sessions",
  authMiddleware,
  requireSAOrAnalyst,
  async (req, res) => {
    try {
      const query = {
        _id: req.params.id,
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

      const LiveConversation = require("../models/LiveConversation");
      const sessions = await LiveConversation.find({
        pitchDeck: pitchDeck._id,
        organization: req.user.organization._id,
        isActive: true,
      })
        .sort({ createdAt: -1 })
        .select(
          "_id title status startedAt endedAt totalDuration transcriptCount suggestionCount"
        )
        .lean();

      res.json({
        sessions: sessions.map((s) => ({
          sessionId: s._id.toString(),
          title: s.title,
          status: s.status,
          createdAt: s.startedAt,
          endedAt: s.endedAt,
          duration: s.totalDuration,
          transcriptCount: s.transcriptCount,
          suggestionCount: s.suggestionCount,
        })),
      });
    } catch (error) {
      console.error("Get live sessions error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Get specific pitch deck
router.get("/:id", authMiddleware, requireSAOrAnalyst, async (req, res) => {
  try {
    const query = {
      _id: req.params.id,
      organization: req.user.organization._id,
      isActive: true,
    };

    // Analysts can only see their own pitch decks
    if (req.user.role === "ANALYST") {
      query.uploadedBy = req.user._id;
    }

    const pitchDeck = await PitchDeck.findOne(query).populate(
      "uploadedBy",
      "firstName lastName email"
    );

    if (!pitchDeck) {
      return res.status(404).json({ message: "Pitch deck not found" });
    }

    // Generate signed URL for file access (valid for limited time)
    let signedFileUrl = pitchDeck.originalFileUrl;
    if (pitchDeck.originalFileKey) {
      signedFileUrl = await generateSignedUrl(pitchDeck.originalFileKey);
    }

    res.json({
      pitchDeck: {
        ...pitchDeck.toObject(),
        originalFileUrl: signedFileUrl,
      },
    });
  } catch (error) {
    console.error("Get pitch deck error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Add comment to pitch deck
router.post(
  "/:id/comments",
  authMiddleware,
  requireSAOrAnalyst,
  [
    body("content")
      .trim()
      .notEmpty()
      .withMessage("Comment content is required"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { content } = req.body;

      // Check if pitch deck exists and user has access
      const query = {
        _id: req.params.id,
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

      // Create comment
      const comment = new Comment({
        content,
        pitchDeck: pitchDeck._id,
        author: req.user._id,
        organization: req.user.organization._id,
      });

      await comment.save();
      await comment.populate("author", "firstName lastName email");

      res.status(201).json({
        message: "Comment added successfully",
        comment,
      });
    } catch (error) {
      console.error("Add comment error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Get comments for pitch deck
router.get(
  "/:id/comments",
  authMiddleware,
  requireSAOrAnalyst,
  async (req, res) => {
    try {
      // Check if pitch deck exists and user has access
      const query = {
        _id: req.params.id,
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

      const comments = await Comment.find({
        pitchDeck: pitchDeck._id,
        isActive: true,
      })
        .populate("author", "firstName lastName email")
        .sort({ createdAt: -1 });

      res.json({ comments });
    } catch (error) {
      console.error("Get comments error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Delete pitch deck (SA can delete any, Analysts can only delete their own)
router.delete("/:id", authMiddleware, requireSAOrAnalyst, async (req, res) => {
  try {
    const query = {
      _id: req.params.id,
      organization: req.user.organization._id,
      isActive: true,
    };

    // Analysts can only delete their own pitch decks
    if (req.user.role === "ANALYST") {
      query.uploadedBy = req.user._id;
    }

    const pitchDeck = await PitchDeck.findOne(query);
    if (!pitchDeck) {
      return res.status(404).json({ message: "Pitch deck not found" });
    }

    // Soft delete pitch deck
    pitchDeck.isActive = false;
    await pitchDeck.save();

    // Soft delete all comments
    await Comment.updateMany({ pitchDeck: pitchDeck._id }, { isActive: false });

    res.json({ message: "Pitch deck deleted successfully" });
  } catch (error) {
    console.error("Delete pitch deck error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// ====================================================================================
// CONVERSATIONAL ANALYSIS ENDPOINTS
// ====================================================================================

// Get conversation history for pitch deck
router.get(
  "/:id/chat",
  authMiddleware,
  requireSAOrAnalyst,
  async (req, res) => {
    try {
      const query = {
        _id: req.params.id,
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

      // Get all messages in the chat
      const messages = await PitchDeckMessage.find({
        pitchDeck: pitchDeck._id,
        isActive: true,
      })
        .populate("author", "firstName lastName email")
        .sort({ createdAt: 1 });

      // Get supporting documents
      const supportingDocs = await SupportingDocument.find({
        pitchDeck: pitchDeck._id,
        isActive: true,
      })
        .populate("uploadedBy", "firstName lastName email")
        .sort({ createdAt: -1 });

      // Generate signed URLs for supporting documents
      const supportingDocsWithSignedUrls = await Promise.all(
        supportingDocs.map(async (doc) => {
          let signedUrl = doc.fileUrl;
          if (doc.fileKey) {
            signedUrl = await generateSignedUrl(doc.fileKey);
          }
          return {
            ...doc.toObject(),
            fileUrl: signedUrl,
          };
        })
      );

      // Transform messages and generate signed URLs for attachments
      const formattedMessages = await Promise.all(
        messages.map(async (msg) => {
          // Generate signed URLs for message attachments
          const attachmentsWithSignedUrls = await Promise.all(
            (msg.attachments || []).map(async (att) => {
              let signedUrl = att.fileUrl;
              if (att.fileKey) {
                signedUrl = await generateSignedUrl(att.fileKey);
              }
              return {
                ...att,
                fileUrl: signedUrl,
              };
            })
          );

          return {
            _id: msg._id,
            userQuery: msg.userQuery,
            aiResponse: msg.aiResponse,
            responseType: msg.responseType,
            requiresAnalysisUpdate: msg.requiresAnalysisUpdate,
            attachments: attachmentsWithSignedUrls,
            analysisVersion: msg.analysisVersion,
            author: msg.author,
            createdAt: msg.createdAt,
            metadata: msg.metadata,
          };
        })
      );

      res.json({
        conversationHistory: formattedMessages,
        supportingDocuments: supportingDocsWithSignedUrls,
        currentVersion: pitchDeck.analysisVersion,
        status: pitchDeck.status,
      });
    } catch (error) {
      console.error("Get chat history error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Unified chat endpoint - send messages and/or attach files, get AI response
router.post(
  "/:id/chat",
  authMiddleware,
  requireSAOrAnalyst,
  upload.array("attachments", 5), // Support up to 5 attachments
  async (req, res) => {
    try {
      const { message } = req.body;
      const attachments = req.files || [];

      // Must have either a message or attachments
      if (!message && attachments.length === 0) {
        return res.status(400).json({
          message: "Please provide a message or attach files",
        });
      }

      const query = {
        _id: req.params.id,
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

      // Update status to analyzing
      await PitchDeck.findByIdAndUpdate(pitchDeck._id, {
        status: "ANALYZING",
      });

      // 1. Process and save supporting documents (if any)
      const savedAttachments = [];
      for (const file of attachments) {
        const encodedFile = file.buffer.toString("base64");

        // Upload to S3
        const fileKey = generateFileKey(
          file.originalname,
          req.user.organization._id,
          "supporting-docs"
        );
        const fileUrl = await uploadToS3(file.buffer, fileKey, file.mimetype);

        const supportingDoc = await SupportingDocument.create({
          pitchDeck: pitchDeck._id,
          title: file.originalname,
          description: `Attached by ${req.user.firstName} ${req.user.lastName}`,
          fileUrl: fileUrl,
          fileKey: fileKey,
          uploadedBy: req.user._id,
          organization: req.user.organization._id,
          metadata: {
            fileSize: file.size,
            fileType: file.mimetype,
            uploadDate: new Date(),
          },
        });

        savedAttachments.push({
          doc: supportingDoc,
          encodedFile,
          fileName: file.originalname,
        });
      }

      // 2. Get conversation history (BEFORE creating new message)
      const allMessages = await PitchDeckMessage.find({
        pitchDeck: pitchDeck._id,
        isActive: true,
      })
        .populate("author", "firstName lastName email")
        .sort({ createdAt: 1 });

      const allSupportingDocs = await SupportingDocument.find({
        pitchDeck: pitchDeck._id,
        isActive: true,
      });

      // 3. Process with AI to get response
      const result = await reanalyzeWithContext(
        pitchDeck._id,
        allMessages,
        allSupportingDocs,
        savedAttachments,
        message || "[Attached files]"
      );

      // 4. Save ONE document with both query and response
      const attachmentRefs = savedAttachments.map((att) => ({
        fileName: att.fileName,
        fileType: att.doc.metadata.fileType,
        fileSize: att.doc.metadata.fileSize,
        fileUrl: att.doc.fileUrl,
        fileKey: att.doc.fileKey,
      }));

      const conversationTurn = await PitchDeckMessage.create({
        pitchDeck: pitchDeck._id,
        author: req.user._id,
        organization: req.user.organization._id,
        userQuery: message || "[Attached files]",
        attachments: attachmentRefs,
        aiResponse: result.aiResponse,
        responseType: result.responseType,
        requiresAnalysisUpdate: result.requiresAnalysisUpdate,
        analysisVersion: result.analysisVersion,
        metadata: {
          processingTime: result.processingTime,
          model: "sonar-pro",
        },
      });

      await conversationTurn.populate("author", "firstName lastName email");

      // 5. Build response
      const response = {
        conversationTurn,
        userQuery: conversationTurn.userQuery,
        aiResponse: conversationTurn.aiResponse,
        responseType: result.responseType,
        requiresAnalysisUpdate: result.requiresAnalysisUpdate,
        version: result.analysisVersion,
        status: "completed",
      };

      // Include structured data based on response type
      if (result.responseType === "conversational") {
        response.conversationalResponse = result.aiResponse.response;
        response.rationale = result.aiResponse.rationale;
      } else if (result.responseType === "full_analysis") {
        response.analysis = result.analysis;
        response.rationale = result.aiResponse.rationale;
      }

      res.json(response);
    } catch (error) {
      console.error("Chat error:", error);
      await PitchDeck.findByIdAndUpdate(req.params.id, {
        status: "FAILED",
      });
      res.status(500).json({
        message: "Server error during analysis",
        error: error.message,
      });
    }
  }
);

// Helper function to apply edits to analysis object
function applyEditsToAnalysis(analysis, edits) {
  if (!edits || !Array.isArray(edits) || edits.length === 0) {
    return analysis;
  }

  // Create a deep copy to avoid mutating the original
  const updatedAnalysis = JSON.parse(JSON.stringify(analysis));

  for (const edit of edits) {
    const { path, newValue } = edit;
    if (!path || newValue === undefined) {
      console.warn(`Invalid edit: missing path or newValue`, edit);
      continue;
    }

    try {
      // Handle array indices like "keyPoints[0]" or "risks[1]" or nested "financials.items[0]"
      const arrayMatch = path.match(/^(.+)\[(\d+)\]$/);
      if (arrayMatch) {
        const [, arrayPath, indexStr] = arrayMatch;
        const index = parseInt(indexStr, 10);
        const array = getNestedValue(updatedAnalysis, arrayPath);
        if (Array.isArray(array) && index >= 0 && index < array.length) {
          array[index] = newValue;
        } else if (Array.isArray(array) && index === array.length) {
          // Allow appending to array if index equals length
          array.push(newValue);
        } else {
          console.warn(
            `Invalid array path or index: ${path} (array length: ${
              Array.isArray(array) ? array.length : "not an array"
            })`
          );
        }
      } else {
        // Handle nested paths like "financials.traction" or simple paths like "summary"
        try {
          setNestedValue(updatedAnalysis, path, newValue);
        } catch (error) {
          console.warn(`Cannot apply edit to path ${path}: ${error.message}`);
        }
      }
    } catch (error) {
      console.error(`Error applying edit to path ${path}:`, error);
    }
  }

  return updatedAnalysis;
}

// Helper to get nested value from object
function getNestedValue(obj, path) {
  const keys = path.split(".");
  let current = obj;
  for (const key of keys) {
    if (current && typeof current === "object" && key in current) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

// Helper to set nested value in object
function setNestedValue(obj, path, value) {
  const keys = path.split(".");
  let current = obj;

  // Navigate to the parent of the target key
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (
      !(key in current) ||
      typeof current[key] !== "object" ||
      current[key] === null
    ) {
      // Path doesn't exist - create it for nested paths, but warn for top-level
      if (i === 0) {
        throw new Error(`Path "${path}" does not exist in analysis object`);
      }
      current[key] = {};
    }
    current = current[key];
  }

  // Set the final value
  const finalKey = keys[keys.length - 1];
  if (!(finalKey in current)) {
    throw new Error(`Path "${path}" does not exist in analysis object`);
  }
  current[finalKey] = value;
}

// Re-analysis function with conversation context
async function reanalyzeWithContext(
  pitchDeckId,
  allMessages,
  allSupportingDocs,
  newAttachments = [],
  currentUserMessage = ""
) {
  try {
    const pitchDeck = await PitchDeck.findById(pitchDeckId).lean();
    const latestThesis = await Thesis.findOne({
      organization: pitchDeck.organization,
      isActive: true,
    })
      .sort({ updatedAt: -1 })
      .lean();

    const startTime = Date.now();
    const newVersion = pitchDeck.analysisVersion + 1;

    // Get the current analysis for reference
    const currentAnalysis = pitchDeck.analysis || {};
    const currentAnalysisJson = JSON.stringify(currentAnalysis, null, 2);

    // Build conversation context from messages (now with userQuery/aiResponse structure)
    const conversationContext = allMessages
      .map((msg) => {
        const author = msg.author
          ? `${msg.author.firstName} ${msg.author.lastName}`
          : "Analyst";
        const attachments =
          msg.attachments && msg.attachments.length > 0
            ? ` [Attachments: ${msg.attachments
                .map((a) => a.fileName)
                .join(", ")}]`
            : "";

        // Format: User query followed by AI response
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

    // Build supporting docs context
    const supportingDocsContext =
      allSupportingDocs.length > 0
        ? `\n\nSupporting Documents Available:\n${allSupportingDocs
            .map(
              (doc) => `- ${doc.title}: ${doc.description || "No description"}`
            )
            .join("\n")}`
        : "";

    // Determine if this requires full re-analysis or just a conversational answer
    const hasAttachments = newAttachments.length > 0;
    const userMessageContent = currentUserMessage;

    // Build enhanced prompt with conversation history
    const enhancedPrompt = `You are DealFlow AI — an AI assistant for Venture Capital analysts.

This is a FOLLOW-UP interaction. The analyst has asked a question or provided new information.

CURRENT ANALYSIS (Version ${pitchDeck.analysisVersion}):
This is the baseline analysis from the pitch deck. Use this as your reference when answering questions.
${currentAnalysisJson}

CONVERSATION HISTORY:
${conversationContext}
${supportingDocsContext}

IMPORTANT - Response Type Instructions:
You must first determine the appropriate response type:

1. **CONVERSATIONAL** - Use when:
   - Analyst asks a specific question about existing analysis
   - Analyst wants clarification or elaboration
   - No new data/files are provided
   - Examples: "What's the CAC?", "Can you elaborate on the team?", "What are the risks?"

2. **MINOR_EDIT** - Use when:
   - Analyst requests minor corrections (spelling, typos, small factual updates)
   - Analyst asks to fix specific text without requiring full re-analysis
   - Changes are localized to specific fields (e.g., "Fix the typo in the summary", "Update the company name to 'Acme Corp'")
   - Examples: "Fix spelling in summary", "Change 'startup' to 'company' in keyPoints", "Correct the revenue number to $5M"

3. **FULL_ANALYSIS** - Use when:
   - New files/documents are attached
   - Analyst explicitly requests re-analysis or update
   - Analyst provides significant new information that changes the evaluation
   - Examples: "Update the analysis", "Reanalyze with this new data", "Here are the financials, update projections"

Your response MUST be a JSON object with this structure:

{
  "responseType": "conversational" | "minor_edit" | "full_analysis",
  "requiresAnalysisUpdate": true | false,
  "rationale": "Brief explanation of why you chose this response type",
  "response": {
    // IF responseType is "conversational":
    "answer": "Direct, concise answer to the analyst's question (2-4 sentences)",
    "reference": "Which part of the analysis this relates to (e.g., 'financials.unitEconomics')",
    "suggestedFollowUp": ["Optional: 1-2 follow-up questions the analyst might want to ask"]
    
    // IF responseType is "minor_edit":
    "edits": [
      {
        "path": "summary" | "keyPoints[0]" | "marketSize" | "businessModel" | "competitiveAdvantage" | "team" | "financials.traction" | "financials.fundraising" | "financials.unitEconomics" | "risks[0]" | "opportunities[0]" | "recommendation" | etc.,
        "oldValue": "The current value at this path",
        "newValue": "The corrected/updated value"
      }
    ],
    "confirmation": "Brief message confirming what edits were made (e.g., 'Fixed spelling errors in summary and keyPoints[2]')"
    
    // IF responseType is "full_analysis":
    // Include the FULL structured analysis (summary, keyPoints, marketSize, businessModel, etc.).
    // You may optionally include an updated "sectorAnalysis" field, but sector analysis is generally handled by a separate, dedicated process.
  }
}

Rules:
• Default to "conversational" unless there's clear reason for full re-analysis or minor edits
• For "conversational", give direct answers - don't repeat the entire analysis
• For "minor_edit", provide specific edits with exact paths and values - only edit what was requested
• For "full_analysis", you may update the full structured analysis, but detailed sector analysis is typically obtained via a separate sectorAnalysis process (no need to run heavy web search here).
• Be objective, evidence-based, and avoid speculation
• If uncertain, choose "conversational" and offer to do full re-analysis if needed

Current analyst message: "${userMessageContent}"
New files attached: ${hasAttachments ? "Yes" : "No"}

Firm thesis (for fit assessment - only needed for full_analysis):
${
  latestThesis && latestThesis.profile
    ? JSON.stringify(latestThesis.profile)
    : latestThesis && latestThesis.content
    ? String(latestThesis.content)
    : "No firm thesis available."
}`;

    // Build message content array (text + any new file attachments)
    const messageContent = [
      {
        type: "text",
        text: enhancedPrompt,
      },
    ];

    // Add any newly attached files to the AI message
    for (const attachment of newAttachments) {
      messageContent.push({
        type: "file_url",
        file_url: {
          url: attachment.encodedFile,
        },
        file_name: attachment.fileName,
      });
    }

    // Call Perplexity with updated context
    const completion = await perplexity.chat.completions.create({
      model: "sonar-pro",
      messages: [
        {
          role: "user",
          content: messageContent,
        },
      ],
    });

    const analysisText = completion.choices[0].message.content;

    const parsed = tryParseJson(analysisText);
    const endTime = Date.now();
    const analysisDuration = endTime - startTime;

    let aiResponse = {};
    let responseType = "conversational";
    let requiresAnalysisUpdate = false;

    // Parse the AI response to determine type
    if (parsed && typeof parsed === "object" && parsed.responseType) {
      responseType = parsed.responseType;
      requiresAnalysisUpdate = parsed.requiresAnalysisUpdate || false;
      aiResponse = parsed;
    } else {
      // Fallback: if parsing fails or old format, treat as conversational
      const text = stripCodeFences(analysisText) || "";
      aiResponse = {
        responseType: "conversational",
        requiresAnalysisUpdate: false,
        rationale: "Parsing fallback - treating as conversational response",
        response: {
          // answer: text.substring(0, 500),
          answer: text,
          reference: "general",
          suggestedFollowUp: [],
        },
      };
    }

    // Determine actual version increment
    const shouldIncrementVersion = responseType === "full_analysis";
    // requiresAnalysisUpdate && responseType === "full_analysis";
    const isMinorEdit = responseType === "minor_edit";
    const actualVersion = shouldIncrementVersion
      ? newVersion
      : pitchDeck.analysisVersion;

    let updatedPitchDeck = pitchDeck;

    // Handle full analysis update
    if (shouldIncrementVersion) {
      // Normalize full analysis before saving (fix any weird summary formatting)
      const fullAnalysis = normalizeAnalysisObject(aiResponse.response || {});

      // Save to history
      const analysisRecord = {
        version: actualVersion,
        analysis: {
          ...fullAnalysis,
          analysisDate: new Date(),
          aiModel: "sonar-pro",
        },
        analysisRaw: analysisText,
        analysisDate: new Date(),
        trigger: hasAttachments ? "supporting_doc" : "user_question",
      };

      // Update pitch deck with new analysis
      updatedPitchDeck = await PitchDeck.findByIdAndUpdate(
        pitchDeckId,
        {
          $set: {
            analysis: {
              ...fullAnalysis,
              analysisDate: new Date(),
              aiModel: "sonar-pro",
            },
            analysisRaw: analysisText,
            analysisVersion: actualVersion,
            status: "COMPLETED",
          },
          $push: {
            analysisHistory: analysisRecord,
          },
        },
        { new: true }
      );

      console.log(
        `Pitch deck ${pitchDeckId} FULL RE-ANALYSIS (v${actualVersion}) in ${analysisDuration}ms`
      );
    } else if (isMinorEdit) {
      // Handle minor edits - apply edits to existing analysis
      const edits = aiResponse.response?.edits || [];
      if (edits.length > 0) {
        const updatedAnalysis = applyEditsToAnalysis(currentAnalysis, edits);

        // Update analysis date but keep same version (minor edits don't increment version)
        updatedAnalysis.analysisDate = new Date();
        updatedAnalysis.aiModel = updatedAnalysis.aiModel || "sonar-pro";

        // Save to history with trigger "user_question" to indicate it was a minor edit
        const analysisRecord = {
          version: actualVersion,
          analysis: updatedAnalysis,
          analysisRaw: analysisText,
          analysisDate: new Date(),
          trigger: "user_question",
        };

        // Update pitch deck with edited analysis (same version)
        updatedPitchDeck = await PitchDeck.findByIdAndUpdate(
          pitchDeckId,
          {
            $set: {
              analysis: updatedAnalysis,
              status: "COMPLETED",
            },
            $push: {
              analysisHistory: analysisRecord,
            },
          },
          { new: true }
        );

        console.log(
          `Pitch deck ${pitchDeckId} MINOR EDIT applied (${edits.length} edits, v${actualVersion}) in ${analysisDuration}ms`
        );
      } else {
        // No valid edits provided - treat as conversational
        updatedPitchDeck = await PitchDeck.findByIdAndUpdate(
          pitchDeckId,
          {
            $set: {
              status: "COMPLETED",
            },
          },
          { new: true }
        );

        console.log(
          `Pitch deck ${pitchDeckId} MINOR_EDIT requested but no valid edits found, treated as conversational (v${actualVersion}) in ${analysisDuration}ms`
        );
      }
    } else {
      // Just conversational - update status but don't change analysis
      updatedPitchDeck = await PitchDeck.findByIdAndUpdate(
        pitchDeckId,
        {
          $set: {
            status: "COMPLETED",
          },
        },
        { new: true }
      );

      console.log(
        `Pitch deck ${pitchDeckId} CONVERSATIONAL response (v${actualVersion}) in ${analysisDuration}ms`
      );
    }

    // Return all the data (message will be saved by the calling function)
    return {
      ...updatedPitchDeck.toObject(),
      aiResponse,
      responseType,
      requiresAnalysisUpdate,
      processingTime: analysisDuration,
    };
  } catch (error) {
    console.error("Re-analysis error:", error);
    await PitchDeck.findByIdAndUpdate(pitchDeckId, {
      status: "FAILED",
    });
    throw error;
  }
}

module.exports = router;
