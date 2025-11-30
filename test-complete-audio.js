// test-complete-audio.js
// Test script for complete audio transcription

const { transcribeCompleteAudio, pcmToWav } = require('./utils/speechToText');
const fs = require('fs');
const path = require('path');

/**
 * Generate mock PCM audio buffer (16-bit, mono, 16kHz)
 * Creates a simple sine wave tone for testing
 * @param {number} durationSeconds - Duration in seconds
 * @param {number} frequency - Frequency in Hz (default: 440Hz = A note)
 * @returns {Buffer} PCM audio buffer
 */
function generateMockPCMAudio(durationSeconds = 5, frequency = 440) {
  const sampleRate = 16000;
  const numSamples = sampleRate * durationSeconds;
  const buffer = Buffer.alloc(numSamples * 2); // 16-bit = 2 bytes per sample
  
  for (let i = 0; i < numSamples; i++) {
    // Generate sine wave
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequency * t);
    
    // Convert float (-1.0 to 1.0) to 16-bit integer (-32768 to 32767)
    const int16Sample = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    
    // Write as little-endian 16-bit integer
    buffer.writeInt16LE(int16Sample, i * 2);
  }
  
  return buffer;
}

/**
 * Generate mock PCM audio with silence (useful for testing)
 * @param {number} durationSeconds - Duration in seconds
 * @returns {Buffer} PCM audio buffer (silence)
 */
function generateSilentPCMAudio(durationSeconds = 5) {
  const sampleRate = 16000;
  const numSamples = sampleRate * durationSeconds;
  // All zeros = silence
  return Buffer.alloc(numSamples * 2);
}

/**
 * Load a real WAV file and convert to PCM (if you have a test audio file)
 * @param {string} filePath - Path to WAV file
 * @returns {Buffer} PCM audio buffer
 */
function loadWAVFileAsPCM(filePath) {
  const wavBuffer = fs.readFileSync(filePath);
  
  // Skip WAV header (44 bytes) and extract PCM data
  const pcmData = wavBuffer.slice(44);
  
  return pcmData;
}

/**
 * Save PCM buffer as WAV file for inspection
 * @param {Buffer} pcmBuffer - PCM audio buffer
 * @param {string} outputPath - Output file path
 * @param {number} sampleRate - Sample rate (default: 16000)
 */
function savePCMAsWAV(pcmBuffer, outputPath, sampleRate = 16000) {
  const wavBuffer = pcmToWav(pcmBuffer, sampleRate);
  fs.writeFileSync(outputPath, wavBuffer);
  console.log(`✅ Saved WAV file: ${outputPath} (${(wavBuffer.length / 1024).toFixed(2)}KB)`);
}

/**
 * Main test function
 */
async function testCompleteAudioTranscription() {
  console.log('🧪 Testing complete audio transcription...\n');
  
  try {
    // Option 1: Generate mock PCM audio (sine wave)
    console.log('📝 Generating mock PCM audio (5 seconds, 440Hz tone)...');
    const mockAudio = generateMockPCMAudio(5, 440);
    console.log(`✅ Generated ${mockAudio.length} bytes of PCM audio`);
    
    // Option 2: Generate silent audio (for testing error handling)
    // const mockAudio = generateSilentPCMAudio(5);
    
    // Option 3: Load from a real WAV file (if you have one)
    // Uncomment and provide path to test with real audio:
    // const testAudioPath = './test-audio.wav';
    // if (fs.existsSync(testAudioPath)) {
    //   console.log(`📂 Loading audio from: ${testAudioPath}`);
    //   mockAudio = loadWAVFileAsPCM(testAudioPath);
    //   console.log(`✅ Loaded ${mockAudio.length} bytes of PCM audio`);
    // }
    
    // Save as WAV for inspection (optional)
    const testWavPath = path.join(__dirname, 'test-mock-audio.wav');
    savePCMAsWAV(mockAudio, testWavPath);
    
    // Test the transcription function
    console.log('\n🎙️ Calling transcribeCompleteAudio...');
    const startTime = Date.now();
    
    const result = await transcribeCompleteAudio(mockAudio, {
      model: 'gpt-4o-transcribe-diarize',
      language: null, // auto-detect
      sample_rate: 16000,
    });
    
    const duration = Date.now() - startTime;
    
    console.log(`\n✅ Transcription completed in ${duration}ms`);
    console.log('\n📊 Transcription Result:');
    console.log(JSON.stringify(result, null, 2));
    
    // Check if result has expected structure
    if (result.segments && Array.isArray(result.segments)) {
      console.log(`\n✅ Found ${result.segments.length} segments`);
      result.segments.forEach((segment, index) => {
        console.log(`  Segment ${index + 1}:`);
        console.log(`    Text: ${segment.text || '(no text)'}`);
        console.log(`    Speaker: ${segment.speaker || 'N/A'}`);
        console.log(`    Start: ${segment.start || 'N/A'}s`);
        console.log(`    End: ${segment.end || 'N/A'}s`);
      });
    } else if (result.text) {
      console.log(`\n✅ Transcription text: ${result.text}`);
    } else {
      console.log('\n⚠️ Unexpected result format');
    }
    
    // Cleanup test file
    if (fs.existsSync(testWavPath)) {
      fs.unlinkSync(testWavPath);
      console.log('\n🧹 Cleaned up test WAV file');
    }
    
    console.log('\n✅ Test completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    console.error('Error details:', {
      message: error.message,
      status: error.status,
      code: error.code,
      type: error.type,
    });
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  // Check if OPENAI_API_KEY is set
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY environment variable is not set');
    console.error('Please set it before running the test:');
    console.error('  export OPENAI_API_KEY=your-api-key');
    console.error('  or');
    console.error('  set OPENAI_API_KEY=your-api-key (Windows)');
    process.exit(1);
  }
  
  testCompleteAudioTranscription()
    .then(() => {
      console.log('\n✨ All tests passed!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Test suite failed:', error);
      process.exit(1);
    });
}

module.exports = {
  generateMockPCMAudio,
  generateSilentPCMAudio,
  loadWAVFileAsPCM,
  savePCMAsWAV,
  testCompleteAudioTranscription,
};

