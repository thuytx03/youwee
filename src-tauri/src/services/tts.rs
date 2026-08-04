// Text-to-speech synthesis for the Video Editor voiceover feature.
// Supports the two cloud providers the app already configures: OpenAI and
// Gemini. OpenAI returns a ready-to-use audio file (wav); Gemini returns raw
// base64 PCM (L16 24kHz mono) which we wrap into a WAV container here.
use std::time::Duration;

const OPENAI_TTS_URL: &str = "https://api.openai.com/v1/audio/speech";
const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_TTS_SAMPLE_RATE: u32 = 24_000;

#[derive(Debug)]
pub enum TtsError {
    NoApiKey,
    Network(String),
    Api(String),
    Parse(String),
}

impl std::fmt::Display for TtsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TtsError::NoApiKey => write!(f, "No API key configured for TTS provider."),
            TtsError::Network(e) => write!(f, "TTS network error: {}", e),
            TtsError::Api(e) => write!(f, "TTS API error: {}", e),
            TtsError::Parse(e) => write!(f, "TTS parse error: {}", e),
        }
    }
}

impl From<TtsError> for String {
    fn from(e: TtsError) -> String {
        e.to_string()
    }
}

fn tts_client() -> Result<reqwest::Client, TtsError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| TtsError::Network(e.to_string()))
}

/// Synthesize `text` to WAV bytes using OpenAI's /v1/audio/speech.
/// `voice` e.g. "alloy"; `model` e.g. "gpt-4o-mini-tts" (falls back if empty).
pub async fn synthesize_openai(
    api_key: &str,
    model: &str,
    voice: &str,
    text: &str,
) -> Result<Vec<u8>, TtsError> {
    if api_key.is_empty() {
        return Err(TtsError::NoApiKey);
    }
    let model = if model.is_empty() { "gpt-4o-mini-tts" } else { model };
    let client = tts_client()?;
    let body = serde_json::json!({
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": "wav",
    });
    let resp = client
        .post(OPENAI_TTS_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| TtsError::Network(e.to_string()))?;

    let status = resp.status();
    if !status.is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(TtsError::Api(format!("OpenAI TTS {}: {}", status, err_text)));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| TtsError::Network(e.to_string()))?;
    Ok(bytes.to_vec())
}

/// Synthesize `text` to WAV bytes using Gemini generateContent (AUDIO modality).
/// Gemini returns base64 PCM (s16le, 24kHz, mono) → wrapped into WAV.
pub async fn synthesize_gemini(
    api_key: &str,
    model: &str,
    voice: &str,
    text: &str,
) -> Result<Vec<u8>, TtsError> {
    if api_key.is_empty() {
        return Err(TtsError::NoApiKey);
    }
    let model = if model.is_empty() {
        "gemini-2.5-flash-preview-tts"
    } else {
        model
    };
    let client = tts_client()?;
    let url = format!("{}/{}:generateContent", GEMINI_BASE, model);
    let body = serde_json::json!({
        "contents": [{ "parts": [{ "text": text }] }],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": { "voiceName": voice }
                }
            }
        }
    });
    let resp = client
        .post(&url)
        .header("x-goog-api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| TtsError::Network(e.to_string()))?;

    let status = resp.status();
    let resp_text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let msg = serde_json::from_str::<serde_json::Value>(&resp_text)
            .ok()
            .and_then(|j| {
                j.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .map(String::from)
            })
            .unwrap_or_else(|| format!("HTTP {}", status));
        return Err(TtsError::Api(format!("Gemini TTS: {}", msg)));
    }

    let json: serde_json::Value =
        serde_json::from_str(&resp_text).map_err(|e| TtsError::Parse(e.to_string()))?;
    let b64 = json
        .get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.get(0))
        .and_then(|p| p.get("inlineData"))
        .and_then(|d| d.get("data"))
        .and_then(|d| d.as_str())
        .ok_or_else(|| TtsError::Parse("No audio data in Gemini response".to_string()))?;

    use base64::Engine;
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| TtsError::Parse(format!("base64 decode: {}", e)))?;

    Ok(pcm_s16le_to_wav(&pcm, GEMINI_TTS_SAMPLE_RATE, 1))
}

/// Wrap raw signed-16-bit little-endian PCM into a minimal WAV container.
pub fn pcm_s16le_to_wav(pcm: &[u8], sample_rate: u32, channels: u16) -> Vec<u8> {
    let bits_per_sample: u16 = 16;
    let byte_rate = sample_rate * channels as u32 * (bits_per_sample as u32 / 8);
    let block_align = channels * (bits_per_sample / 8);
    let data_len = pcm.len() as u32;
    let riff_len = 36 + data_len;

    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_len.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}
