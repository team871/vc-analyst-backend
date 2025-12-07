const OpenAI = require("openai");

let openaiClient = null;

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
 * Create a live transcription connection for real-time display
 * Buffers audio and sends to OpenAI periodically for transcription
 * @param {Object} options - Configuration options
 * @param {Function} onTranscript - Callback for transcript updates
 * @param {Function} onError - Callback for errors
 * @returns {Object} Connection object with send and close methods
 */
function createLiveTranscription(options = {}, onTranscript, onError) {
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
 * Transcribe a single audio chunk with retry logic
 * @param {Buffer} pcmChunk - PCM audio chunk
 * @param {Object} options - Configuration options
 * @param {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @returns {Promise<Object>} Transcription result
 */
async function transcribeAudioChunk(pcmChunk, options = {}, maxRetries = 3) {
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
      `Audio chunk too small: ${pcmChunk?.length || 0} bytes (minimum: ${MIN_CHUNK_SIZE} bytes)`
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
          console.warn("File API creation failed, using temp file:", err.message);
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

      const transcription = await client.audio.transcriptions.create(requestParams);
      
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
          `Transcription attempt ${attempt + 1}/${maxRetries + 1} failed (${error.status || "unknown"}). Retrying in ${delayMs}ms...`
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
    text: chunkResults.map((r) => r.text || "").join(" ").trim(),
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
 * Transcribe complete audio file using OpenAI
 * Used for end-of-meeting complete analysis with speaker diarization
 * Automatically handles chunking for files over 25MB
 * @param {Buffer} audioBuffer - Complete audio recording (PCM format)
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} Complete transcription with segments and speaker information
 */
async function transcribeCompleteAudio(audioBuffer, options = {}) {
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
          console.warn("File API creation failed, using temp file:", err.message);
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
      `Audio file too large (${fileSizeMB.toFixed(2)}MB). Splitting into chunks...`
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
        `Transcribing chunk ${i + 1}/${chunks.length} (${(chunkWavSize / 1024 / 1024).toFixed(2)}MB, ${chunkDuration.toFixed(2)}s, ${chunks[i].length} bytes PCM)...`
      );

      // Additional validation before transcription
      if (chunks[i].length < sample_rate * 2 * 0.25) {
        console.warn(
          `Chunk ${i + 1} is too small (${chunks[i].length} bytes, ~${chunkDuration.toFixed(2)}s). Skipping...`
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
        const chunkResult = await transcribeAudioChunk(chunks[i], {
          model,
          language,
          sample_rate,
        }, 3); // 3 retries per chunk
        
        chunkResults.push(chunkResult);
        console.log(
          `Chunk ${i + 1}/${chunks.length} transcribed successfully`
        );
      } catch (error) {
        console.error(`Error transcribing chunk ${i + 1} after retries:`, error);
        failedChunks.push(i + 1);
        
        // Calculate chunk duration for placeholder
        const bytesPerSecond = sample_rate * 2;
        const chunkDuration = chunks[i].length / bytesPerSecond;
        
        // Add a placeholder to maintain chunk order
        chunkResults.push({
          text: `[Transcription failed for chunk ${i + 1} after retries: ${error.status || "unknown error"}]`,
          segments: [],
          duration: chunkDuration,
          language: null,
        });
      }
    }

    // Log summary of failed chunks
    if (failedChunks.length > 0) {
      console.warn(
        `Warning: ${failedChunks.length} chunk(s) failed transcription: ${failedChunks.join(", ")}`
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

module.exports = {
  initializeOpenAI,
  createLiveTranscription,
  transcribeCompleteAudio,
  pcmToWav,
};
