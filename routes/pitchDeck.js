const express = require("express");
const { body, validationResult } = require("express-validator");
const PitchDeck = require("../models/PitchDeck");
const Thesis = require("../models/Thesis");
const Comment = require("../models/Comment");
const { authMiddleware, requireSAOrAnalyst } = require("../middleware/auth");
const {
  upload,
  uploadToS3,
  generateFileKey,
  generateSignedUrl,
} = require("../utils/s3Upload");
const Perplexity = require("@perplexity-ai/perplexity_ai");
const fs = require("fs");

const router = express.Router();
const perplexity = new Perplexity();

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

      // Start AI analysis in background (with base64 file)
      analyzePitchDeckWithBase64(
        pitchDeck._id,
        encodedFile,
        req.file.originalname,
        req.file
      );

      res.status(201).json({
        message: "Pitch deck uploaded and analysis started",
        pitchDeck: {
          id: pitchDeck._id,
          title: pitchDeck.title,
          description: pitchDeck.description,
          status: pitchDeck.status,
          uploadedAt: pitchDeck.createdAt,
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
   
    "openQuestions": ["Top 5 questions the analyst should ask to validate assumptions."]
  }
}

Keep tone professional, clear, and investor-grade. Output valid JSON only.`,
                  },
                  // Include firm's thesis content for fit evaluation
                  latestThesis
                    ? {
                        type: "text",
                        text:
                          "Firm thesis (JSON or text). Use only what's stated:" +
                          "\n\n" +
                          String(latestThesis.content).slice(0, 20000),
                      }
                    : { type: "text", text: "No firm thesis available." },
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
    let analysis;
    try {
      // analysis = JSON.parse(analysisText);
      analysis = analysisText;
    } catch (parseError) {
      // If JSON parsing fails, create structured analysis from text
      analysis = {
        summary: analysisText.substring(0, 500),
        keyPoints: analysisText
          .split("\n")
          .filter((line) => line.trim().startsWith("-"))
          .map((line) => line.replace(/^-\s*/, "")),
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

    const endTime = Date.now();
    const analysisDuration = endTime - startTime;

    // Upload file to S3 after successful analysis
    // const fileKey = generateFileKey(
    //   fileName,
    //   pdRecord.organization,
    //   "pitch-decks"
    // );
    // const fileUrl = await uploadToS3(fileBuffer, fileKey);

    // Update pitch deck with analysis and S3 URLs
    await PitchDeck.findByIdAndUpdate(pitchDeckId, {
      analysis: {
        summary: analysis,
        analysisDate: new Date(),
        aiModel: "sonar-pro",
      },
      status: "COMPLETED",
      // originalFileUrl: fileUrl,
      // originalFileKey: fileKey,
      "metadata.analysisDuration": analysisDuration,
    });

    console.log(
      `Pitch deck ${pitchDeckId} analysis completed in ${analysisDuration}ms`
    );
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

    // Generate signed URL for file access
    const fileUrl = await generateSignedUrl(pitchDeck.originalFileKey);

    res.json({
      pitchDeck: {
        ...pitchDeck.toObject(),
        originalFileUrl: fileUrl,
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

module.exports = router;
