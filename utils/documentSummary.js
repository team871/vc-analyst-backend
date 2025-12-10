const OpenAI = require("openai");
const { getOrganizationApiKey } = require("./organizationApiKeys");

// Initialize OpenAI client with organization-specific API key
let openaiClients = new Map(); // Cache clients per organization

async function getOpenAIClient(organizationId) {
  if (!organizationId) {
    // Fallback to environment variable
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenAI API key not configured. Please set it in API Settings or environment variable."
      );
    }
    return new OpenAI({ apiKey });
  }

  // Check cache first
  if (openaiClients.has(organizationId.toString())) {
    return openaiClients.get(organizationId.toString());
  }

  // Get organization-specific API key
  const apiKey = await getOrganizationApiKey(organizationId, "openai");
  if (!apiKey) {
    throw new Error(
      "OpenAI API key not configured. Please set it in API Settings."
    );
  }

  const client = new OpenAI({ apiKey });
  openaiClients.set(organizationId.toString(), client);
  return client;
}

/**
 * Generate a mini summary/caption for a document using GPT-4o-mini
 * @param {Buffer} fileBuffer - The document file buffer
 * @param {string} fileName - Original file name
 * @param {string} mimeType - File MIME type
 * @param {string} organizationId - Organization ID for API key lookup
 * @returns {Promise<{summary: string, category: string}>} Summary and category
 */
async function generateDocumentSummary(
  fileBuffer,
  fileName,
  mimeType,
  organizationId = null
) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.warn("OPENAI_API_KEY not set, skipping AI summary generation");
      return {
        summary: `Document: ${fileName}`,
        category: "",
      };
    }

    const client = await getOpenAIClient(organizationId);

    // Upload file to OpenAI Files API first (required for document analysis)
    const fs = require("fs");
    const path = require("path");
    const os = require("os");

    // Create temporary file
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(
      tempDir,
      `doc-summary-${Date.now()}-${Math.random()
        .toString(36)
        .substring(7)}-${fileName}`
    );

    try {
      // Write buffer to temp file
      fs.writeFileSync(tempFilePath, fileBuffer);

      // Upload file to OpenAI
      const uploadedFile = await client.files.create({
        file: fs.createReadStream(tempFilePath),
        purpose: "assistants",
      });

      // Wait a moment for file processing
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const prompt = `You are analyzing a document from a venture capital deal's data room. Generate a concise, informative summary/caption for this document.

Guidelines:
- Create a brief, professional summary (1-2 sentences maximum)
- Identify the document type and key information
- Examples:
  * "This document is the company's balance sheet for the fiscal year 2024-2025."
  * "This document is a breakdown of their technical infrastructure and architecture."
  * "This document is the shareholder agreement dated January 2024."
  * "This document contains the company's cap table showing ownership distribution."
- Be specific about dates, periods, or relevant details if visible
- If the document type is unclear, provide a general description

Return ONLY a JSON object with this structure:
{
  "summary": "Your concise summary here",
  "category": "Document category (e.g., 'Balance Sheet', 'Shareholder Agreement', 'Tech Infrastructure', 'Cap Table', etc.)"
}

Output valid JSON only.`;

      // Use the file ID in the file_url format
      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt,
              },
              {
                type: "file_url",
                file_url: {
                  url: `file://${uploadedFile.id}`,
                },
              },
            ],
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3, // Lower temperature for more consistent summaries
      });

      // Clean up: delete temp file and OpenAI file
      fs.unlinkSync(tempFilePath);
      await client.files.del(uploadedFile.id).catch(() => {
        // Ignore cleanup errors
      });

      const responseText = completion.choices[0].message.content;
      const parsed = JSON.parse(responseText);

      return {
        summary: parsed.summary || `Document: ${fileName}`,
        category: parsed.category || "",
      };
    } catch (uploadError) {
      // If file upload fails, try alternative approach with base64
      console.warn(
        "OpenAI file upload failed, trying alternative approach:",
        uploadError
      );

      // Clean up temp file if it exists
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }

      // Fallback: Use text-based analysis (extract filename info)
      const fileExtension = path.extname(fileName).toLowerCase();
      const baseName = path.basename(fileName, fileExtension);

      // Try to infer category from filename
      let inferredCategory = "";
      const lowerName = baseName.toLowerCase();
      if (lowerName.includes("balance") || lowerName.includes("financial")) {
        inferredCategory = "Financial Statement";
      } else if (
        lowerName.includes("shareholder") ||
        lowerName.includes("agreement")
      ) {
        inferredCategory = "Legal Document";
      } else if (lowerName.includes("cap") || lowerName.includes("equity")) {
        inferredCategory = "Cap Table";
      } else if (
        lowerName.includes("tech") ||
        lowerName.includes("infrastructure")
      ) {
        inferredCategory = "Technical Documentation";
      }

      return {
        summary: `This document is ${baseName}${
          fileExtension
            ? ` (${fileExtension.substring(1).toUpperCase()} file)`
            : ""
        }.`,
        category: inferredCategory,
      };
    } finally {
      // Ensure temp file is cleaned up
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
  } catch (error) {
    console.error("Error generating document summary:", error);
    // Fallback to basic summary
    return {
      summary: `Document: ${fileName}`,
      category: "",
    };
  }
}

module.exports = {
  generateDocumentSummary,
};
