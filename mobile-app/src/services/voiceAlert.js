// Spoken alerts with a dark-zone fallback (MOB-07, Workflow 4).
//
// Bhashini is a network service. It produces the best Assamese/Hindi speech we
// can get, and it is unreachable in exactly the situation this app is built
// for. So the delivery path is two-tier:
//
//   online  -> Bhashini: translate to the driver's language, then synthesise.
//   offline -> react-native-tts: the device's own engine, no network at all.
//
// The fallback is genuinely worse -- Android ships no Assamese voice on most
// handsets -- so it degrades to a language the engine actually has rather than
// staying silent. A hazard warning in the wrong language still stops a truck;
// silence does not.
import Tts from 'react-native-tts';
import { translateAndSpeak } from './bhashini';

/// Android locales for the languages trucks.alert_lang can hold.
const TTS_LOCALE = { as: 'as-IN', hi: 'hi-IN', en: 'en-IN' };

let ttsReady = null;

function initTts() {
  if (!ttsReady) {
    ttsReady = Tts.getInitStatus().catch((error) => {
      // On a device with no TTS engine installed this rejects with
      // 'no_engine'. Swallow it: speak() below will simply do nothing, and
      // the visual modal is still shown.
      console.warn('[tts] engine unavailable:', error?.message ?? error);
      return null;
    });
  }
  return ttsReady;
}

/**
 * Speak an alert, preferring Bhashini and falling back to the device engine.
 *
 * Never throws. A failed alert must not take down the screen the driver is
 * navigating by, so every path here ends in a warning and a resolved promise.
 */
export async function speakAlert({ language, text }) {
  const lang = TTS_LOCALE[language] ? language : 'en';

  try {
    // Credentials come from @env inside bhashini.js, not from the caller.
    await translateAndSpeak({ language: lang, text });
    return { spoken: true, engine: 'bhashini' };
  } catch (error) {
    console.warn('[voice] Bhashini unavailable, falling back to device TTS:', error.message);
  }

  try {
    await initTts();
    // setDefaultLanguage rejects when the voice is not installed, which is the
    // normal case for Assamese. Fall back to English rather than not speaking.
    try {
      await Tts.setDefaultLanguage(TTS_LOCALE[lang]);
    } catch {
      await Tts.setDefaultLanguage('en-IN').catch(() => {});
    }
    Tts.stop();
    Tts.speak(text);
    return { spoken: true, engine: 'device' };
  } catch (error) {
    console.warn('[voice] device TTS failed:', error?.message ?? error);
    return { spoken: false, engine: null };
  }
}
