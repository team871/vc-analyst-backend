const OpenAI = require("openai");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const os = require("os");

let openaiClient = null;

/**
 * Get the configured transcription provider
 * @returns {string} "openai" or "elevenlabs"
 */
function getTranscriptionProvider() {
  const provider = (
    process.env.TRANSCRIPTION_PROVIDER || "openai"
  ).toLowerCase();
  if (provider !== "openai" && provider !== "elevenlabs") {
    console.warn(
      `Invalid TRANSCRIPTION_PROVIDER "${provider}", defaulting to "openai"`
    );
    return "openai";
  }
  return provider;
}

/**
 * Initialize OpenAI client
 */
function initializeOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY not set. OpenAI transcription will not work."
    );
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return openaiClient;
}

/**
 * Initialize ElevenLabs API key validation
 */
function validateElevenLabsConfig() {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error(
      "ELEVENLABS_API_KEY not set. ElevenLabs transcription will not work."
    );
  }
  return process.env.ELEVENLABS_API_KEY;
}

/**
 * Convert PCM audio buffer to WAV format
 * @param {Buffer} pcmBuffer - PCM audio data (16-bit, mono)
 * @param {number} sampleRate - Sample rate (default: 16000)
 * @returns {Buffer} WAV file buffer
 */
function pcmToWav(pcmBuffer, sampleRate = 16000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);

  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Split PCM audio buffer into chunks that will be under 25MB when converted to WAV
 * @param {Buffer} pcmBuffer - PCM audio data
 * @param {number} sampleRate - Sample rate (default: 16000)
 * @returns {Array<Buffer>} Array of PCM chunks
 */
function splitPcmIntoChunks(pcmBuffer, sampleRate = 16000) {
  // Validate input buffer
  if (!pcmBuffer || pcmBuffer.length === 0) {
    throw new Error("Cannot split empty or invalid PCM buffer");
  }

  // Minimum chunk size: ~1 second of audio (sample_rate * 2 bytes)
  const MIN_CHUNK_SIZE = sampleRate * 2; // ~32000 bytes for 16kHz

  // WAV header is 44 bytes
  // Target max WAV size: 20MB (safe margin under 25MB limit)
  const MAX_WAV_SIZE = 20 * 1024 * 1024; // 20MB
  const WAV_HEADER_SIZE = 44;
  const MAX_PCM_SIZE_PER_CHUNK = MAX_WAV_SIZE - WAV_HEADER_SIZE;

  const chunks = [];
  let offset = 0;

  while (offset < pcmBuffer.length) {
    const remaining = pcmBuffer.length - offset;
    let chunkSize = Math.min(remaining, MAX_PCM_SIZE_PER_CHUNK);

    // Ensure last chunk meets minimum size, or merge with previous chunk
    if (remaining < MIN_CHUNK_SIZE && chunks.length > 0) {
      // Merge last small chunk with previous chunk
      const lastChunk = chunks.pop();
      offset -= lastChunk.length;
      chunkSize = remaining + lastChunk.length;
    } else if (remaining < MIN_CHUNK_SIZE && chunks.length === 0) {
      // If entire buffer is too small, use it anyway (will be validated in transcribeAudioChunk)
      chunkSize = remaining;
    }

    const chunk = pcmBuffer.slice(offset, offset + chunkSize);
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    offset += chunkSize;
  }

  return chunks;
}

/**
 * Check if an error is retryable
 * @param {Error} error - The error to check
 * @returns {boolean} True if the error is retryable
 */
function isRetryableError(error) {
  if (!error || !error.status) {
    return false;
  }

  // Retry on 500, 502, 503, 504 (server errors)
  // Also retry on 429 (rate limit)
  // Don't retry on 400 (bad request) unless it's a specific case
  const retryableStatuses = [500, 502, 503, 504, 429];

  if (retryableStatuses.includes(error.status)) {
    return true;
  }

  // For 400 errors, check if it's a "something went wrong reading your request" error
  // which might be a transient issue
  if (error.status === 400 && error.error && error.error.message) {
    const message = error.error.message.toLowerCase();
    if (
      message.includes("something went wrong") ||
      message.includes("reading your request") ||
      message.includes("timeout") ||
      message.includes("temporary")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Transcribe a single audio chunk with retry logic using OpenAI
 * @param {Buffer} pcmChunk - PCM audio chunk
 * @param {Object} options - Configuration options
 * @param {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @returns {Promise<Object>} Transcription result
 */
async function transcribeAudioChunkOpenAI(
  pcmChunk,
  options = {},
  maxRetries = 3
) {
  const client = initializeOpenAI();

  const {
    model = "gpt-4o-transcribe-diarize",
    language = null,
    sample_rate = 16000,
  } = options;

  // Validate chunk size - OpenAI requires minimum audio duration
  // Minimum: ~0.25 seconds of audio (sample_rate * 2 bytes * 0.25)
  const MIN_CHUNK_SIZE = sample_rate * 2 * 0.25; // ~8000 bytes for 16kHz
  if (!pcmChunk || pcmChunk.length < MIN_CHUNK_SIZE) {
    throw new Error(
      `Audio chunk too small: ${
        pcmChunk?.length || 0
      } bytes (minimum: ${MIN_CHUNK_SIZE} bytes)`
    );
  }

  const wavBuffer = pcmToWav(pcmChunk, sample_rate);

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    let audioFile;
    let tempFilePath = null;

    try {
      if (typeof File !== "undefined" && typeof Blob !== "undefined") {
        try {
          const blob = new Blob([wavBuffer], { type: "audio/wav" });
          audioFile = new File([blob], "audio-chunk.wav", {
            type: "audio/wav",
            lastModified: Date.now(),
          });
        } catch (err) {
          console.warn(
            "File API creation failed, using temp file:",
            err.message
          );
        }
      }

      if (!audioFile) {
        const tempDir = os.tmpdir();
        tempFilePath = path.join(
          tempDir,
          `openai-audio-chunk-${Date.now()}-${Math.random()
            .toString(36)
            .substring(7)}.wav`
        );

        fs.writeFileSync(tempFilePath, wavBuffer);

        const fileStream = fs.createReadStream(tempFilePath);
        fileStream.name = "audio-chunk.wav";
        fileStream.path = tempFilePath;
        fileStream.type = "audio/wav";

        audioFile = fileStream;
      }

      const requestParams = {
        file: audioFile,
        model: model,
        language: language || undefined,
      };

      if (model.includes("diarize")) {
        requestParams.response_format = "diarized_json";
        requestParams.chunking_strategy = "auto";
        requestParams.timestamp_granularities = ["segment"];
      } else {
        requestParams.response_format = "verbose_json";
      }

      const transcription = await client.audio.transcriptions.create(
        requestParams
      );

      // Cleanup temp file on success
      if (tempFilePath) {
        try {
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }
        } catch (err) {
          console.warn("Failed to cleanup temp file:", err);
        }
      }

      return transcription;
    } catch (error) {
      lastError = error;

      // Cleanup temp file on error
      if (tempFilePath) {
        try {
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }
        } catch (err) {
          console.warn("Failed to cleanup temp file:", err);
        }
      }

      // Check if error is retryable
      if (attempt < maxRetries && isRetryableError(error)) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff, max 10s
        console.log(
          `Transcription attempt ${attempt + 1}/${maxRetries + 1} failed (${
            error.status || "unknown"
          }). Retrying in ${delayMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      } else {
        // Not retryable or max retries reached
        throw error;
      }
    }
  }

  // Should never reach here, but just in case
  throw lastError || new Error("Failed to transcribe audio chunk");
}

/**
 * Merge transcription results from multiple chunks
 * @param {Array<Object>} chunkResults - Array of transcription results from chunks
 * @param {Array<Buffer>} pcmChunks - Original PCM chunks (to calculate accurate durations)
 * @param {number} sampleRate - Sample rate
 * @returns {Object} Merged transcription result
 */
function mergeTranscriptionChunks(chunkResults, pcmChunks, sampleRate = 16000) {
  if (chunkResults.length === 0) {
    return null;
  }

  if (chunkResults.length === 1) {
    return chunkResults[0];
  }

  // Calculate duration per chunk in seconds based on PCM buffer size
  // PCM: 16-bit = 2 bytes per sample, mono = 1 channel
  // So: bytes per second = sample_rate * 2
  const bytesPerSecond = sampleRate * 2;

  const mergedSegments = [];
  let cumulativeOffset = 0;

  for (let i = 0; i < chunkResults.length; i++) {
    const chunkResult = chunkResults[i];

    // Calculate actual chunk duration from PCM buffer size
    const chunkDuration = pcmChunks[i]
      ? pcmChunks[i].length / bytesPerSecond
      : chunkResult.duration || 0;

    if (chunkResult.segments && Array.isArray(chunkResult.segments)) {
      for (const segment of chunkResult.segments) {
        // Adjust timestamps to account for previous chunks
        mergedSegments.push({
          ...segment,
          start: segment.start + cumulativeOffset,
          end: segment.end + cumulativeOffset,
        });
      }
    } else if (chunkResult.text) {
      // Fallback: if no segments, create a segment from text
      mergedSegments.push({
        text: chunkResult.text,
        start: cumulativeOffset,
        end: cumulativeOffset + chunkDuration,
        speaker: null,
      });
    }

    // Update cumulative offset based on actual chunk duration
    cumulativeOffset += chunkDuration;
  }

  // Build merged result
  const firstResult = chunkResults[0];
  const merged = {
    text: chunkResults
      .map((r) => r.text || "")
      .join(" ")
      .trim(),
    language: firstResult.language || null,
    duration: cumulativeOffset,
    segments: mergedSegments,
  };

  // Preserve other fields from first result
  if (firstResult.words) {
    merged.words = firstResult.words;
  }

  return merged;
}

/**
 * Normalize ElevenLabs transcription response to match OpenAI format
 * @param {Object} elevenLabsResponse - Response from ElevenLabs API
 * @param {number} duration - Audio duration in seconds
 * @returns {Object} Normalized transcription response
 */
function normalizeElevenLabsResponse(elevenLabsResponse, duration) {
  // ElevenLabs returns different structure - normalize to OpenAI format
  const normalized = {
    text: "",
    language: null,
    duration: duration,
    segments: [],
  };

  // Handle different response formats from ElevenLabs
  if (elevenLabsResponse.text) {
    normalized.text = elevenLabsResponse.text;
  }

  if (elevenLabsResponse.language) {
    normalized.language = elevenLabsResponse.language;
  }

  // Handle segments/transcripts
  if (
    elevenLabsResponse.segments &&
    Array.isArray(elevenLabsResponse.segments)
  ) {
    normalized.segments = elevenLabsResponse.segments.map((segment) => ({
      text: segment.text || "",
      start: segment.start || 0,
      end: segment.end || 0,
      speaker: segment.speaker || null,
    }));
  } else if (
    elevenLabsResponse.transcripts &&
    Array.isArray(elevenLabsResponse.transcripts)
  ) {
    // Multi-channel format
    const firstTranscript = elevenLabsResponse.transcripts[0];
    if (firstTranscript && firstTranscript.segments) {
      normalized.segments = firstTranscript.segments.map((segment) => ({
        text: segment.text || "",
        start: segment.start || 0,
        end: segment.end || 0,
        speaker: segment.speaker || null,
      }));
    }
    if (firstTranscript && firstTranscript.text) {
      normalized.text = firstTranscript.text;
    }
  }

  // If no segments but we have text, create a single segment
  if (normalized.segments.length === 0 && normalized.text) {
    normalized.segments = [
      {
        text: normalized.text,
        start: 0,
        end: duration,
        speaker: null,
      },
    ];
  }

  return normalized;
}

/**
 * Transcribe complete audio file using ElevenLabs
 * Note: ElevenLabs supports up to 3GB file size and 10 hours duration,
 * so chunking is NOT needed (unlike OpenAI's 25MB limit)
 * @param {Buffer} audioBuffer - Complete audio recording (PCM format)
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} Complete transcription with segments and speaker information
 */
async function transcribeCompleteAudioElevenLabs(audioBuffer, options = {}) {
  validateElevenLabsConfig();
  const apiKey = process.env.ELEVENLABS_API_KEY;

  const {
    model_id = "scribe_v1", // Required: "scribe_v1" or "scribe_v1_experimental"
    language = null,
    sample_rate = 16000,
    diarize = true,
    num_speakers = null,
  } = options;

  try {
    // Validate audio buffer
    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error("Audio buffer is empty or invalid");
    }

    const MIN_AUDIO_SIZE = sample_rate * 2 * 0.25;
    if (audioBuffer.length < MIN_AUDIO_SIZE) {
      throw new Error(
        `Audio buffer too small: ${audioBuffer.length} bytes (minimum: ${MIN_AUDIO_SIZE} bytes)`
      );
    }

    // Validate that audioBuffer is actually PCM data (not already WAV)
    // WAV files start with "RIFF" header
    let pcmBuffer = audioBuffer;
    if (
      audioBuffer.length > 44 &&
      audioBuffer.toString("ascii", 0, 4) === "RIFF"
    ) {
      console.log(
        "[ElevenLabs] Detected WAV format in input, extracting PCM data"
      );
      // Extract PCM data from WAV (skip 44-byte header)
      pcmBuffer = audioBuffer.slice(44);
    }

    const wavBuffer = pcmToWav(pcmBuffer, sample_rate);
    const fileSizeMB = wavBuffer.length / 1024 / 1024;
    const duration = pcmBuffer.length / (sample_rate * 2);

    // Validate WAV file format
    if (wavBuffer.length < 44) {
      throw new Error("Generated WAV file is too small (invalid format)");
    }

    // Verify WAV header
    const wavHeader = wavBuffer.toString("ascii", 0, 4);
    if (wavHeader !== "RIFF") {
      throw new Error(
        `Invalid WAV file format: expected RIFF header, got ${wavHeader}`
      );
    }

    // ElevenLabs supports up to 3GB and 10 hours - no chunking needed
    const MAX_FILE_SIZE_GB = 3;
    const MAX_DURATION_HOURS = 10;
    const maxFileSizeMB = MAX_FILE_SIZE_GB * 1024;
    const maxDurationSeconds = MAX_DURATION_HOURS * 3600;

    if (fileSizeMB > maxFileSizeMB) {
      throw new Error(
        `Audio file too large: ${fileSizeMB.toFixed(
          2
        )}MB (ElevenLabs limit: ${MAX_FILE_SIZE_GB}GB)`
      );
    }

    if (duration > maxDurationSeconds) {
      throw new Error(
        `Audio duration too long: ${(duration / 3600).toFixed(
          2
        )} hours (ElevenLabs limit: ${MAX_DURATION_HOURS} hours)`
      );
    }

    console.log(
      `[ElevenLabs] Transcribing audio (${fileSizeMB.toFixed(
        2
      )}MB, ~${duration.toFixed(
        2
      )}s) - No chunking needed (supports up to ${MAX_FILE_SIZE_GB}GB/${MAX_DURATION_HOURS}h)...`
    );

    // Create form data - use form-data package for proper multipart encoding
    const formData = new FormData();

    // Append file buffer with proper options for form-data package
    formData.append("file", wavBuffer, {
      filename: "audio.wav",
      contentType: "audio/wav",
      knownLength: wavBuffer.length, // Help form-data calculate content-length correctly
    });

    // model_id is REQUIRED - must be "scribe_v1" or "scribe_v1_experimental"
    formData.append("model_id", model_id);

    // file_format: "pcm_s16le_16" for raw PCM, "other" for encoded audio (WAV, MP3, etc.)
    // Since we're sending WAV (encoded), use "other"
    formData.append("file_format", "other");
    if (language) {
      formData.append("language_code", language);
    }
    // diarize should be boolean, but form-data sends as string
    if (diarize) {
      formData.append("diarize", "true");
    }
    if (num_speakers) {
      formData.append("num_speakers", num_speakers.toString());
    }
    // timestamps_granularity: "none" | "word" | "character"
    formData.append("timestamps_granularity", "word");

    // Use form-data's built-in stream support for fetch compatibility
    // form-data package works with node-fetch, but we need to handle it properly
    let fetchFn;
    let fetchModule;

    // Try to use node-fetch which has better form-data support
    try {
      fetchModule = require("node-fetch");
      fetchFn = fetchModule.default || fetchModule;
    } catch (e) {
      // Fallback to built-in fetch (Node 18+)
      if (typeof globalThis.fetch !== "undefined") {
        fetchFn = globalThis.fetch;
      } else {
        throw new Error(
          "fetch is not available. Please use Node.js 18+ or install node-fetch: npm install node-fetch"
        );
      }
    }

    // Get form data headers
    const headers = {
      "xi-api-key": apiKey,
      ...formData.getHeaders(),
    };

    console.log(
      `[ElevenLabs] Sending request with ${(
        wavBuffer.length /
        1024 /
        1024
      ).toFixed(2)}MB WAV file`
    );

    const response = await fetchFn(
      "https://api.elevenlabs.io/v1/speech-to-text",
      {
        method: "POST",
        headers: headers,
        body: formData,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[ElevenLabs] API error details - Status: ${response.status}, Headers:`,
        Object.fromEntries(response.headers.entries())
      );
      throw new Error(
        `ElevenLabs API error (${response.status}): ${errorText}`
      );
    }

    const result = await response.json();
    console.log("[ElevenLabs] Transcription successful");

    // Normalize response to match OpenAI format
    return normalizeElevenLabsResponse(result, duration);
  } catch (error) {
    console.error("[ElevenLabs] Error transcribing audio:", error);
    throw error;
  }
}

/**
 * Transcribe complete audio file using OpenAI
 * Used for end-of-meeting complete analysis with speaker diarization
 * Automatically handles chunking for files over 25MB (OpenAI's limit)
 * Note: ElevenLabs supports much larger files (3GB/10h) and doesn't need chunking
 * @param {Buffer} audioBuffer - Complete audio recording (PCM format)
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} Complete transcription with segments and speaker information
 */
async function transcribeCompleteAudioOpenAI(audioBuffer, options = {}) {
  const client = initializeOpenAI();

  const {
    model = "gpt-4o-transcribe-diarize",
    language = null,
    sample_rate = 16000,
  } = options;

  try {
    // Validate audio buffer
    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error("Audio buffer is empty or invalid");
    }

    // Minimum audio duration: ~0.25 seconds
    const MIN_AUDIO_SIZE = sample_rate * 2 * 0.25; // ~8000 bytes for 16kHz
    if (audioBuffer.length < MIN_AUDIO_SIZE) {
      throw new Error(
        `Audio buffer too small: ${audioBuffer.length} bytes (minimum: ${MIN_AUDIO_SIZE} bytes for ~0.25 seconds)`
      );
    }

    const wavBuffer = pcmToWav(audioBuffer, sample_rate);
    const fileSizeMB = wavBuffer.length / 1024 / 1024;

    console.log(
      `Audio file size: ${fileSizeMB.toFixed(2)}MB (max 25MB per chunk)`
    );

    // If file is small enough, transcribe directly
    if (wavBuffer.length <= 25 * 1024 * 1024) {
      const fs = require("fs");
      const path = require("path");
      const os = require("os");
      let audioFile;
      let tempFilePath = null;

      if (typeof File !== "undefined" && typeof Blob !== "undefined") {
        try {
          const blob = new Blob([wavBuffer], { type: "audio/wav" });
          audioFile = new File([blob], "meeting-audio.wav", {
            type: "audio/wav",
            lastModified: Date.now(),
          });
        } catch (err) {
          console.warn(
            "File API creation failed, using temp file:",
            err.message
          );
        }
      }

      if (!audioFile) {
        const tempDir = os.tmpdir();
        tempFilePath = path.join(
          tempDir,
          `openai-complete-audio-${Date.now()}-${Math.random()
            .toString(36)
            .substring(7)}.wav`
        );

        fs.writeFileSync(tempFilePath, wavBuffer);

        const fileStream = fs.createReadStream(tempFilePath);
        fileStream.name = "meeting-audio.wav";
        fileStream.path = tempFilePath;
        fileStream.type = "audio/wav";

        audioFile = fileStream;
      }

      let transcription;
      try {
        console.log(
          `Transcribing complete audio file (${fileSizeMB.toFixed(2)}MB)...`
        );

        // Build request parameters
        const requestParams = {
          file: audioFile,
          model: model,
          language: language || undefined,
        };

        // For diarization models, chunking_strategy is REQUIRED
        // According to OpenAI docs, chunking_strategy should be a string "auto", not an object
        if (model.includes("diarize")) {
          requestParams.response_format = "diarized_json";
          requestParams.chunking_strategy = "auto";
          requestParams.timestamp_granularities = ["segment"];
        } else {
          requestParams.response_format = "verbose_json";
        }

        transcription = await client.audio.transcriptions.create(requestParams);
        console.log("Complete audio transcription successful");
      } finally {
        if (tempFilePath) {
          try {
            if (fs.existsSync(tempFilePath)) {
              fs.unlinkSync(tempFilePath);
            }
          } catch (err) {
            console.warn("Failed to cleanup temp file:", err);
          }
        }
      }

      return transcription;
    }

    // File is too large - split into chunks and transcribe separately
    console.log(
      `Audio file too large (${fileSizeMB.toFixed(
        2
      )}MB). Splitting into chunks...`
    );

    const chunks = splitPcmIntoChunks(audioBuffer, sample_rate);
    console.log(`Split into ${chunks.length} chunks for transcription`);

    // Transcribe each chunk sequentially (to avoid rate limits)
    const chunkResults = [];
    const failedChunks = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkWavSize = pcmToWav(chunks[i], sample_rate).length;
      const chunkDuration = chunks[i].length / (sample_rate * 2); // seconds

      console.log(
        `Transcribing chunk ${i + 1}/${chunks.length} (${(
          chunkWavSize /
          1024 /
          1024
        ).toFixed(2)}MB, ${chunkDuration.toFixed(2)}s, ${
          chunks[i].length
        } bytes PCM)...`
      );

      // Additional validation before transcription
      if (chunks[i].length < sample_rate * 2 * 0.25) {
        console.warn(
          `Chunk ${i + 1} is too small (${
            chunks[i].length
          } bytes, ~${chunkDuration.toFixed(2)}s). Skipping...`
        );
        failedChunks.push(i + 1);
        chunkResults.push({
          text: `[Chunk ${i + 1} too small to transcribe]`,
          segments: [],
          duration: chunkDuration,
          language: null,
        });
        continue;
      }

      try {
        const chunkResult = await transcribeAudioChunk(
          chunks[i],
          {
            model,
            language,
            sample_rate,
          },
          3
        ); // 3 retries per chunk

        chunkResults.push(chunkResult);
        console.log(`Chunk ${i + 1}/${chunks.length} transcribed successfully`);
      } catch (error) {
        console.error(
          `Error transcribing chunk ${i + 1} after retries:`,
          error
        );
        failedChunks.push(i + 1);

        // Calculate chunk duration for placeholder
        const bytesPerSecond = sample_rate * 2;
        const chunkDuration = chunks[i].length / bytesPerSecond;

        // Add a placeholder to maintain chunk order
        chunkResults.push({
          text: `[Transcription failed for chunk ${i + 1} after retries: ${
            error.status || "unknown error"
          }]`,
          segments: [],
          duration: chunkDuration,
          language: null,
        });
      }
    }

    // Log summary of failed chunks
    if (failedChunks.length > 0) {
      console.warn(
        `Warning: ${
          failedChunks.length
        } chunk(s) failed transcription: ${failedChunks.join(", ")}`
      );

      // If all chunks failed, throw an error to trigger retry mechanism
      if (failedChunks.length === chunks.length) {
        throw new Error(
          `All ${chunks.length} audio chunks failed transcription. This will trigger retry mechanism.`
        );
      }
    }

    // Merge all chunk results
    console.log("Merging transcription results from all chunks...");
    const mergedTranscription = mergeTranscriptionChunks(
      chunkResults,
      chunks,
      sample_rate
    );

    if (!mergedTranscription) {
      throw new Error("Failed to merge transcription chunks");
    }

    console.log(
      `Complete audio transcription successful (${chunks.length} chunks merged)`
    );
    return mergedTranscription;
  } catch (error) {
    console.error("Error transcribing complete audio:", error);
    throw error;
  }
}

/**
 * Unified interface: Transcribe complete audio file
 * Routes to the configured provider (OpenAI or ElevenLabs)
 * @param {Buffer} audioBuffer - Complete audio recording (PCM format)
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} Complete transcription with segments and speaker information
 */
async function transcribeCompleteAudio(audioBuffer, options = {}) {
  const provider = getTranscriptionProvider();
  console.log(`[Transcription] Using provider: ${provider}`);

  if (provider === "elevenlabs") {
    return await transcribeCompleteAudioElevenLabs(audioBuffer, options);
  } else {
    return await transcribeCompleteAudioOpenAI(audioBuffer, options);
  }
}

/**
 * Transcribe a single audio chunk using ElevenLabs
 * @param {Buffer} pcmChunk - PCM audio chunk
 * @param {Object} options - Configuration options
 * @param {number} maxRetries - Maximum number of retry attempts
 * @returns {Promise<Object>} Transcription result
 */
async function transcribeAudioChunkElevenLabs(
  pcmChunk,
  options = {},
  maxRetries = 3
) {
  validateElevenLabsConfig();
  const apiKey = process.env.ELEVENLABS_API_KEY;

  const {
    model_id = null,
    language = null,
    sample_rate = 16000,
    diarize = true,
  } = options;

  const MIN_CHUNK_SIZE = sample_rate * 2 * 0.25;
  if (!pcmChunk || pcmChunk.length < MIN_CHUNK_SIZE) {
    throw new Error(
      `Audio chunk too small: ${
        pcmChunk?.length || 0
      } bytes (minimum: ${MIN_CHUNK_SIZE} bytes)`
    );
  }

  const wavBuffer = pcmToWav(pcmChunk, sample_rate);
  const duration = pcmChunk.length / (sample_rate * 2);
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Send buffer directly with proper form-data formatting
      const formData = new FormData();
      formData.append("file", wavBuffer, {
        filename: "chunk.wav",
        contentType: "audio/wav",
        knownLength: wavBuffer.length, // Help form-data calculate content-length correctly
      });

      // model_id is REQUIRED
      formData.append("model_id", model_id || "scribe_v1");

      // file_format: "other" for encoded audio (WAV)
      formData.append("file_format", "other");
      if (language) {
        formData.append("language_code", language);
      }
      // diarize should be boolean, not string
      if (diarize) {
        formData.append("diarize", "true"); // FormData converts to string anyway
      }
      // timestamps_granularity: "none" | "word" | "character" (not "segment")
      formData.append("timestamps_granularity", "word");

      // Use node-fetch for better form-data compatibility
      let fetchFn;
      try {
        const nodeFetch = require("node-fetch");
        fetchFn = nodeFetch.default || nodeFetch;
      } catch (e) {
        if (typeof globalThis.fetch !== "undefined") {
          fetchFn = globalThis.fetch;
          console.warn(
            "[ElevenLabs] Using built-in fetch - form-data may not work correctly. Consider installing node-fetch: npm install node-fetch"
          );
        } else {
          throw new Error(
            "node-fetch is required for ElevenLabs API. Please install: npm install node-fetch"
          );
        }
      }

      const response = await fetchFn(
        "https://api.elevenlabs.io/v1/speech-to-text",
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            ...formData.getHeaders(),
          },
          body: formData,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `ElevenLabs API error (${response.status}): ${errorText}`
        );
      }

      const result = await response.json();
      return normalizeElevenLabsResponse(result, duration);
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries && isRetryableError(error)) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(
          `[ElevenLabs] Transcription attempt ${attempt + 1}/${
            maxRetries + 1
          } failed. Retrying in ${delayMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      } else {
        throw error;
      }
    }
  }

  throw lastError || new Error("Failed to transcribe audio chunk");
}

/**
 * Unified interface: Transcribe a single audio chunk
 * Routes to the configured provider
 * @param {Buffer} pcmChunk - PCM audio chunk
 * @param {Object} options - Configuration options
 * @param {number} maxRetries - Maximum number of retry attempts
 * @returns {Promise<Object>} Transcription result
 */
async function transcribeAudioChunk(pcmChunk, options = {}, maxRetries = 3) {
  const provider = getTranscriptionProvider();
  if (provider === "elevenlabs") {
    return await transcribeAudioChunkElevenLabs(pcmChunk, options, maxRetries);
  } else {
    return await transcribeAudioChunkOpenAI(pcmChunk, options, maxRetries);
  }
}

/**
 * Create live transcription using OpenAI (existing implementation)
 * Note: This is the original createLiveTranscription function, renamed for clarity
 */
function createLiveTranscriptionOpenAI(options = {}, onTranscript, onError) {
  const client = initializeOpenAI();

  if (!client) {
    throw new Error("OpenAI client not initialized. Check OPENAI_API_KEY.");
  }

  const {
    model = "whisper-1", // Use whisper-1 for live transcription (faster, cheaper)
    language = null,
    sample_rate = 16000,
    channels = 1,
  } = options;

  let audioBuffer = Buffer.alloc(0);
  let completeAudioRecording = Buffer.alloc(0);
  let isConnected = true;
  let processingInterval = null;
  let lastProcessTime = Date.now();
  const BUFFER_DURATION_MS = 5000; // Process every 5 seconds
  const MIN_BUFFER_SIZE = sample_rate * 2 * 1; // Minimum 1 second of audio

  const processAudioBuffer = async () => {
    if (!isConnected || audioBuffer.length < MIN_BUFFER_SIZE) {
      return;
    }

    try {
      const bufferToProcess = audioBuffer;
      audioBuffer = Buffer.alloc(0);
      lastProcessTime = Date.now();

      const wavBuffer = pcmToWav(bufferToProcess, sample_rate);

      if (wavBuffer.length > 25 * 1024 * 1024) {
        console.warn("Audio buffer too large, skipping this batch");
        return;
      }

      const fs = require("fs");
      const path = require("path");
      const os = require("os");
      let audioFile;
      let tempFilePath = null;

      if (typeof File !== "undefined" && typeof Blob !== "undefined") {
        try {
          const blob = new Blob([wavBuffer], { type: "audio/wav" });
          audioFile = new File([blob], "audio.wav", {
            type: "audio/wav",
            lastModified: Date.now(),
          });
        } catch (err) {
          // Fall through to temp file
        }
      }

      if (!audioFile) {
        const tempDir = os.tmpdir();
        tempFilePath = path.join(
          tempDir,
          `openai-live-audio-${Date.now()}-${Math.random()
            .toString(36)
            .substring(7)}.wav`
        );

        fs.writeFileSync(tempFilePath, wavBuffer);

        const fileStream = fs.createReadStream(tempFilePath);
        fileStream.name = "audio.wav";
        fileStream.path = tempFilePath;
        fileStream.type = "audio/wav";

        audioFile = fileStream;
      }

      let transcription;
      try {
        transcription = await client.audio.transcriptions.create({
          file: audioFile,
          model: model,
          language: language || undefined,
          response_format: "verbose_json",
        });
      } finally {
        if (tempFilePath) {
          try {
            if (fs.existsSync(tempFilePath)) {
              fs.unlinkSync(tempFilePath);
            }
          } catch (err) {
            console.warn("Failed to cleanup temp file:", err);
          }
        }
      }

      if (transcription && transcription.text) {
        const transcriptText = transcription.text.trim();
        if (transcriptText) {
          onTranscript({
            text: transcriptText,
            isFinal: true,
            confidence: 1.0,
            timestamp: Date.now(),
            speaker: null,
            speakerId: null,
            languageCode: transcription.language || null,
          });
        }
      }
    } catch (error) {
      console.error("Error processing live audio with OpenAI:", error);
      if (onError) {
        onError(error);
      }
    }
  };

  processingInterval = setInterval(() => {
    const timeSinceLastProcess = Date.now() - lastProcessTime;
    if (
      timeSinceLastProcess >= BUFFER_DURATION_MS &&
      audioBuffer.length >= MIN_BUFFER_SIZE
    ) {
      processAudioBuffer();
    }
  }, 1000);

  return {
    send: (audioData) => {
      if (!isConnected) {
        return;
      }

      try {
        let buffer;
        if (Buffer.isBuffer(audioData)) {
          buffer = audioData;
        } else if (audioData instanceof Uint8Array) {
          buffer = Buffer.from(audioData);
        } else {
          buffer = Buffer.from(audioData);
        }

        if (buffer.length === 0) {
          return;
        }

        audioBuffer = Buffer.concat([audioBuffer, buffer]);
        completeAudioRecording = Buffer.concat([
          completeAudioRecording,
          buffer,
        ]);

        const timeSinceLastProcess = Date.now() - lastProcessTime;
        if (
          timeSinceLastProcess >= BUFFER_DURATION_MS &&
          audioBuffer.length >= MIN_BUFFER_SIZE
        ) {
          processAudioBuffer();
        }
      } catch (error) {
        console.error("Error buffering audio for live transcription:", error);
        if (onError) {
          onError(error);
        }
      }
    },
    close: () => {
      isConnected = false;
      if (processingInterval) {
        clearInterval(processingInterval);
        processingInterval = null;
      }
      if (audioBuffer.length >= MIN_BUFFER_SIZE) {
        processAudioBuffer().catch((error) => {
          console.error("Error processing final audio buffer:", error);
        });
      }
    },
    isConnected: () => isConnected,
    getCompleteAudio: () => {
      return completeAudioRecording;
    },
  };
}

/**
 * Unified interface: Create a live transcription connection
 * Currently only OpenAI is supported for live transcription
 * @param {Object} options - Configuration options
 * @param {Function} onTranscript - Callback for transcript updates
 * @param {Function} onError - Callback for errors
 * @returns {Object} Connection object with send and close methods
 */
function createLiveTranscription(options = {}, onTranscript, onError) {
  const provider = getTranscriptionProvider();
  console.log(`[Live Transcription] Using provider: ${provider}`);

  // Currently only OpenAI supports live transcription
  if (provider === "elevenlabs") {
    console.warn(
      "[Live Transcription] ElevenLabs does not support live transcription, falling back to OpenAI"
    );
    return createLiveTranscriptionOpenAI(options, onTranscript, onError);
  }

  return createLiveTranscriptionOpenAI(options, onTranscript, onError);
}

module.exports = {
  initializeOpenAI,
  createLiveTranscription,
  transcribeCompleteAudio,
  pcmToWav,
  getTranscriptionProvider, // Export for testing/debugging
};
