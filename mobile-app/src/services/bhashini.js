// Bhashini TTS (MOB-07).
//
// Reroute alerts are read aloud in the driver's own language. A dispatcher
// pushing a reroute to a truck on a mountain road cannot expect the driver to
// look at a screen, so the audio path is the alert -- the banner is the copy.
import Sound from 'react-native-sound';
import RNFS from 'react-native-fs';

const PIPELINE_URL = 'https://dhruva-api.bhashini.gov.in/services/inference/pipeline';

/// Assamese, Hindi, English -- matching trucks.alert_lang in the schema.
const SUPPORTED = new Set(['as', 'hi', 'en']);

// Reroute wording is fixed and small, so synthesised audio is cached on disk
// by language. The same "landslide ahead, rerouting" is spoken many times a
// week, and a truck that has just regained a marginal connection should not
// spend it on TTS it already has.
const cache = new Map();

export async function speakRerouteAlert({ apiKey, userId, language, text }) {
  const lang = SUPPORTED.has(language) ? language : 'en';

  const cached = cache.get(`${lang}:${text}`);
  if (cached) return playFile(cached);

  const response = await fetch(PIPELINE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: apiKey,
      userID: userId,
    },
    body: JSON.stringify({
      pipelineTasks: [{
        taskType: 'tts',
        config: { language: { sourceLanguage: lang }, gender: 'female' },
      }],
      inputData: { input: [{ source: text }] },
    }),
  });

  if (!response.ok) {
    throw new Error(`Bhashini TTS failed: HTTP ${response.status}`);
  }
  const body = await response.json();
  const base64 = body?.pipelineResponse?.[0]?.audio?.[0]?.audioContent;
  if (!base64) throw new Error('Bhashini returned no audio');

  const path = `${RNFS.CachesDirectoryPath}/reroute-${lang}-${hash(text)}.wav`;
  await RNFS.writeFile(path, base64, 'base64');
  cache.set(`${lang}:${text}`, path);
  return playFile(path);
}

function playFile(path) {
  return new Promise((resolve, reject) => {
    const sound = new Sound(path, '', (error) => {
      if (error) return reject(error);
      // Play over the navigation audio channel so it is heard above music.
      sound.setCategory?.('Playback');
      return sound.play((ok) => {
        sound.release();
        return ok ? resolve() : reject(new Error('playback failed'));
      });
    });
  });
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
