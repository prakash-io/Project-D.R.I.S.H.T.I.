// Bhashini TTS (MOB-07).
//
// Reroute alerts are read aloud in the driver's own language. A dispatcher
// pushing a reroute to a truck on a mountain road cannot expect the driver to
// look at a screen, so the audio path is the alert -- the banner is the copy.
import Sound from 'react-native-sound';
import RNFS from 'react-native-fs';
// Injected at compile time by react-native-dotenv (see babel.config.js).
// process.env is NOT substituted by React Native's preset, which is why the
// credentials were previously undefined and every call returned HTTP 401.
//
// BOTH are required: the pipeline authenticates on Authorization AND userID.
// Sending only the key still returns 401.
import { BHASHINI_API_KEY, BHASHINI_USER_ID } from '@env';

const PIPELINE_URL = 'https://dhruva-api.bhashini.gov.in/services/inference/pipeline';

/// Assamese, Hindi, English -- matching trucks.alert_lang in the schema.
const SUPPORTED = new Set(['as', 'hi', 'en']);

// Reroute wording is fixed and small, so synthesised audio is cached on disk
// by language. The same "landslide ahead, rerouting" is spoken many times a
// week, and a truck that has just regained a marginal connection should not
// spend it on TTS it already has.
const cache = new Map();

/// Bounded because alert text is no longer one fixed sentence. Hazard copy
/// varies per incident, and an unbounded Map here is a slow leak on a device
/// that stays up for a whole shift.
const CACHE_LIMIT = 32;

function remember(key, path) {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, path);
}

export async function speakRerouteAlert({ language, text }) {
  if (!BHASHINI_API_KEY || !BHASHINI_USER_ID) {
    // Not an error worth a network round trip: say so plainly so the caller
    // falls straight through to the on-device engine.
    throw new Error('Bhashini credentials are not configured (.env)');
  }

  const lang = SUPPORTED.has(language) ? language : 'en';

  const cached = cache.get(`${lang}:${text}`);
  if (cached) return playFile(cached);

  const response = await fetch(PIPELINE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: BHASHINI_API_KEY,
      userID: BHASHINI_USER_ID,
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
  remember(`${lang}:${text}`, path);
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

/**
 * Translate an alert into the driver's language, then speak it (Workflow 4).
 *
 * One Bhashini pipeline call does both tasks: `translation` hands its output
 * straight to `tts`, so the round trip is single, which matters on the
 * marginal connection a truck has just regained.
 *
 * English text to an English driver skips translation -- asking the pipeline
 * to translate en->en wastes the request.
 */
export async function translateAndSpeak({ language, text }) {
  if (!BHASHINI_API_KEY || !BHASHINI_USER_ID) {
    // Not an error worth a network round trip: say so plainly so the caller
    // falls straight through to the on-device engine.
    throw new Error('Bhashini credentials are not configured (.env)');
  }

  const lang = SUPPORTED.has(language) ? language : 'en';

  const cached = cache.get(`${lang}:${text}`);
  if (cached) return playFile(cached);

  const tasks = [];
  if (lang !== 'en') {
    tasks.push({
      taskType: 'translation',
      config: {
        language: { sourceLanguage: 'en', targetLanguage: lang },
      },
    });
  }
  tasks.push({
    taskType: 'tts',
    config: { language: { sourceLanguage: lang }, gender: 'female' },
  });

  const response = await fetch(PIPELINE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: BHASHINI_API_KEY,
      userID: BHASHINI_USER_ID,
    },
    body: JSON.stringify({ pipelineTasks: tasks, inputData: { input: [{ source: text }] } }),
  });

  if (!response.ok) {
    throw new Error(`Bhashini pipeline failed: HTTP ${response.status}`);
  }

  const body = await response.json();
  // The audio is on the LAST task's response -- the tts stage -- regardless of
  // whether a translation stage ran ahead of it.
  const stages = body?.pipelineResponse ?? [];
  const base64 = stages[stages.length - 1]?.audio?.[0]?.audioContent;
  if (!base64) throw new Error('Bhashini returned no audio');

  const path = `${RNFS.CachesDirectoryPath}/alert-${lang}-${hash(text)}.wav`;
  await RNFS.writeFile(path, base64, 'base64');
  remember(`${lang}:${text}`, path);
  return playFile(path);
}
