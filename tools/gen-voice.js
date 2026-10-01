#!/usr/bin/env node
/*
 * gen-voice.js — pre-generate narration MP3s with the ElevenLabs API.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=xxx [VOICE_EN=..] [VOICE_BN=..] [VOICE_HI=..] \
 *   node tools/gen-voice.js [--lang=en,bn,hi] [--numbers=compact|all] [--dry-run]
 *
 * - ELEVENLABS_API_KEY: your key (never commit it)
 * - VOICE_<LANG>: ElevenLabs voice_id for that language. If unset, the script
 *   lists your voices and picks the first one whose name mentions the language.
 * - --numbers=compact (default): clips for 0-99 + 100,200..900 + 1000.
 *   --numbers=all: clips for every number 0-999 (better prosody, more quota).
 *
 * Output: audio/<lang>/sent/<slug>.mp3, frag/<slug>.mp3, num/<n>.mp3,
 * plus manifest.json mapping fixed sentence text -> sent file (used by the
 * page as a lookup when a step has no explicit recipe).
 *
 * Re-running skips files that already exist, so it is safe to resume.
 * Filename slugs use the same djb2-base36 hash as index.html's slug().
 */
'use strict';

const fs = require('fs');
const path = require('path');

// load tools/.env if present (gitignored) so the key never lands in the repo
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  for (const a of args) {
    const m = a.match(new RegExp('^--' + name + '=(.+)$'));
    if (m) return m[1];
  }
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const dryRun = args.includes('--dry-run');
const langs = flag('lang', 'en,bn,hi').split(',');
const numbersMode = flag('numbers', 'digits');
const API = 'https://api.elevenlabs.io/v1';
const KEY = process.env.ELEVENLABS_API_KEY;

function slug(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function walkTemplates(node, out) {
  // collects strings and literal fragments of placeholder templates
  if (typeof node === 'string') {
    if (/\{\w+\}/.test(node)) {
      node.split(/(\{\w+\})/).forEach((p) => {
        if (p && !/^\{\w+\}$/.test(p) && /\p{L}/u.test(p)) out.fragments.add(p);
      });
    } else {
      out.sentences.add(node);
    }
  } else if (Array.isArray(node)) {
    node.forEach((x) => walkTemplates(x, out));
  } else if (node && typeof node === 'object') {
    Object.entries(node).forEach(([k, v]) => {
      if (k === 'meta' || k === 'placeholders' || k === 'place_names') return; // handled separately / not narration
      walkTemplates(v, out);
    });
  }
}

function collectClips(tts) {
  const out = { sentences: new Set(), fragments: new Set() };
  walkTemplates(tts, out);
  // place names and operator words are spoken as values inside templates
  Object.values(tts.place_names).forEach((n) => {
    if (/\{\w+\}/.test(n)) n.split(/(\{\w+\})/).forEach((p) => p && !/^\{\w+\}$/.test(p) && out.fragments.add(p));
    else out.fragments.add(n);
  });
  Object.values(tts.meta.operator_words || {}).forEach((w) => out.fragments.add(w));
  // drop anything without letters (lone punctuation from template splits)
  const nums = [];
  if (numbersMode === 'all') {
    for (let i = 0; i <= 999; i++) nums.push(i);
  } else if (numbersMode === 'compact') {
    for (let i = 0; i <= 99; i++) nums.push(i);
    for (let i = 100; i <= 900; i += 100) nums.push(i);
    nums.push(1000);
  } else { // digits (default)
    for (let i = 0; i <= 9; i++) nums.push(i);
  }
  return { sentences: out.sentences, fragments: out.fragments, nums };
}

// The multiplication lessons use fixed problems; each step's full sentence is
// synthesized as ONE clip (numbers spoken as words) instead of stitched
// fragments. Keep this list in sync with LESSONS in index.html.
const MULT_LESSONS = [[2, 2], [2, 8], [24, 82], [24, 26], [362, 12]];

function lessonSentences(tts) {
  const { Solver } = require(path.join(__dirname, '..', 'solver.js'));
  const solver = new Solver(tts);
  const out = new Set();
  for (const [a, b] of MULT_LESSONS) {
    const r = solver.solve(a, '*', b, { lesson: true });
    for (const st of (r.steps || [])) {
      if (st && st.say && !/\{\w+\}/.test(st.say)) out.add(st.say);
    }
  }
  return out;
}

// words for 0-99 so lesson sentences read numbers fluently, not as digits
const TENS_WORDS = {
  en: ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty','twenty-one','twenty-two','twenty-three','twenty-four','twenty-five','twenty-six','twenty-seven','twenty-eight','twenty-nine','thirty','thirty-one','thirty-two','thirty-three','thirty-four','thirty-five','thirty-six','thirty-seven','thirty-eight','thirty-nine','forty','forty-one','forty-two','forty-three','forty-four','forty-five','forty-six','forty-seven','forty-eight','forty-nine','fifty','fifty-one','fifty-two','fifty-three','fifty-four','fifty-five','fifty-six','fifty-seven','fifty-eight','fifty-nine','sixty','sixty-one','sixty-two','sixty-three','sixty-four','sixty-five','sixty-six','sixty-seven','sixty-eight','sixty-nine','seventy','seventy-one','seventy-two','seventy-three','seventy-four','seventy-five','seventy-six','seventy-seven','seventy-eight','seventy-nine','eighty','eighty-one','eighty-two','eighty-three','eighty-four','eighty-five','eighty-six','eighty-seven','eighty-eight','eighty-nine','ninety','ninety-one','ninety-two','ninety-three','ninety-four','ninety-five','ninety-six','ninety-seven','ninety-eight','ninety-nine'],
  es: ['cero','uno','dos','tres','cuatro','cinco','seis','siete','ocho','nueve','diez','once','doce','trece','catorce','quince','dieciséis','diecisiete','dieciocho','diecinueve','veinte','veintiuno','veintidós','veintitrés','veinticuatro','veinticinco','veintiséis','veintisiete','veintiocho','veintinueve','treinta','treinta y uno','treinta y dos','treinta y tres','treinta y cuatro','treinta y cinco','treinta y seis','treinta y siete','treinta y ocho','treinta y nueve','cuarenta','cuarenta y uno','cuarenta y dos','cuarenta y tres','cuarenta y cuatro','cuarenta y cinco','cuarenta y seis','cuarenta y siete','cuarenta y ocho','cuarenta y nueve','cincuenta','cincuenta y uno','cincuenta y dos','cincuenta y tres','cincuenta y cuatro','cincuenta y cinco','cincuenta y seis','cincuenta y siete','cincuenta y ocho','cincuenta y nueve','sesenta','sesenta y uno','sesenta y dos','sesenta y tres','sesenta y cuatro','sesenta y cinco','sesenta y seis','sesenta y siete','sesenta y ocho','sesenta y nueve','setenta','setenta y uno','setenta y dos','setenta y tres','setenta y cuatro','setenta y cinco','setenta y seis','setenta y siete','setenta y ocho','setenta y nueve','ochenta','ochenta y uno','ochenta y dos','ochenta y tres','ochenta y cuatro','ochenta y cinco','ochenta y seis','ochenta y siete','ochenta y ocho','ochenta y nueve','noventa','noventa y uno','noventa y dos','noventa y tres','noventa y cuatro','noventa y cinco','noventa y seis','noventa y siete','noventa y ocho','noventa y nueve'],
  hi: ['शून्य','एक','दो','तीन','चार','पाँच','छह','सात','आठ','नौ','दस','ग्यारह','बारह','तेरह','चौदह','पंद्रह','सोलह','सत्रह','अठारह','उन्नीस','बीस','इक्कीस','बाईस','तेईस','चौबीस','पच्चीस','छब्बीस','सत्ताईस','अट्ठाईस','उनतीस','तीस','इकतीस','बत्तीस','तैंतीस','चौंतीस','पैंतीस','छत्तीस','सैंतीस','अड़तीस','उनतालीस','चालीस','इकतालीस','बयालीस','तैंतालीस','चवालीस','पैंतालीस','छियालीस','सैंतालीस','अड़तालीस','उनचास','पचास','इक्यावन','बावन','तिरपन','चौवन','पचपन','छप्पन','सत्तावन','अट्ठावन','उनसठ','साठ','इकसठ','बासठ','तिरसठ','चौंसठ','पैंसठ','छियासठ','सड़सठ','अड़सठ','उनहत्तर','सत्तर','इकहत्तर','बहत्तर','तिहत्तर','चौहत्तर','पचहत्तर','छिहत्तर','सतहत्तर','अठहत्तर','उन्यासी','अस्सी','इक्यासी','बयासी','तिरासी','चौरासी','पचासी','छियासी','सत्तासी','अट्ठासी','नव्यासी','नब्बे','इक्यानबे','बानबे','तिरानबे','चौरानबे','पंचानबे','छियानबे','सत्तानबे','अट्ठानबे','निन्यानबे'],
  bn: ['শূন্য','এক','দুই','তিন','চার','পাঁচ','ছয়','সাত','আট','নয়','দশ','এগারো','বারো','তেরো','চৌদ্দ','পনেরো','ষোলো','সতেরো','আঠারো','উনিশ','বিশ','একুশ','বাইশ','তেইশ','চব্বিশ','পঁচিশ','ছাব্বিশ','সাতাশ','আটাশ','উনত্রিশ','ত্রিশ','একত্রিশ','বত্রিশ','তেত্রিশ','চৌঁত্রিশ','পঁয়ত্রিশ','ছত্রিশ','সাঁইত্রিশ','আটত্রিশ','উনচল্লিশ','চল্লিশ','একচল্লিশ','বিয়াল্লিশ','তেতাল্লিশ','চুয়াল্লিশ','পঁয়তাল্লিশ','ছেচল্লিশ','সাতচল্লিশ','আটচল্লিশ','উনপঞ্চাশ','পঞ্চাশ','একান্ন','বায়ান্ন','তিপ্পান্ন','চুয়ান্ন','পঞ্চান্ন','ছাপ্পান্ন','সাতান্ন','আটান্ন','উনষাট','ষাট','একষট্টি','বাষট্টি','তিরষট্টি','চৌষট্টি','পঁয়ষট্টি','ছেষট্টি','সাতষট্টি','আটষট্টি','উনসত্তর','সত্তর','একাত্তর','বাহাত্তর','তিয়াত্তর','চৌহাত্তর','পঁচাত্তর','ছিয়াত্তর','সাতাত্তর','আটাত্তর','উনআশি','আশি','একাশি','বিরাশি','তিরাশি','চুরাশি','পঁচাশি','ছিয়াশি','সাতাশি','আটাশি','নিরাশি','নব্বই','একানব্বই','বিরানব্বই','তিরানব্বই','চুরানব্বই','পঁচানব্বই','ছিয়ানব্বই','সাতানব্বই','আটানব্বই','নিরানব্বই'],
};
const BIG_WORDS = {
  en: { hundred: 'hundred', thousand: 'thousand', join: ' ' },
  es: { hundreds: ['cien','doscientos','trescientos','cuatrocientos','quinientos','seiscientos','setecientos','ochocientos','novecientos'], thousand: 'mil', join: ' ' },
  hi: { hundred: 'सौ', thousand: 'हज़ार', join: ' ' },
  bn: { hundred: 'শত', thousand: 'হাজার', join: ' ' },
};

function numberToWords(lang, n) {
  const t = TENS_WORDS[lang] || TENS_WORDS.en;
  const b = BIG_WORDS[lang] || BIG_WORDS.en;
  const j = (xs) => xs.filter(Boolean).join(b.join);
  if (!Number.isInteger(n) || n < 0 || n > 9999) return String(n);
  if (n < 100) return t[n];
  if (n < 1000) {
    const h = Math.floor(n / 100), r = n % 100;
    if (lang === 'es') return j([r ? b.hundreds[h - 1].replace(/^cien$/, 'ciento') : b.hundreds[h - 1], r ? t[r] : '']);
    return j([t[h], b.hundred, r ? t[r] : '']);
  }
  const th = Math.floor(n / 1000), r = n % 1000;
  return j([th === 1 && (lang === 'es') ? '' : t[th], b.thousand, r ? numberToWords(lang, r) : '']);
}

// replace every digit run in a sentence with its spoken form
function digitsToWords(lang, text) {
  return text.replace(/\d+/g, (m) => numberToWords(lang, Number(m)));
}

async function api(pathname, opts) {
  const res = await fetch(API + pathname, opts);
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${await res.text()}`);
  return res;
}

async function pickVoice(langCode, nameHint) {
  if (process.env['VOICE_' + langCode.toUpperCase()]) return process.env['VOICE_' + langCode.toUpperCase()];
  const res = await api('/voices', { headers: { 'xi-api-key': KEY } });
  const voices = (await res.json()).voices || [];
  let match = voices.find((v) => new RegExp(nameHint, 'i').test(v.name))
    || voices.find((v) => (v.labels && v.labels.language || '').toLowerCase().startsWith(langCode));
  if (!match) {
    // multilingual v2 voices speak any language; fall back to the first voice
    match = voices[0];
    console.error(`  note: no language-matched voice for ${langCode}; using "${match.name}". Override with VOICE_${langCode.toUpperCase()}.`);
  }
  console.log(`voice for ${langCode}: ${match.name} (${match.voice_id})`);
  return match.voice_id;
}

const NAME_HINT = { en: 'english|emma|arthur|brian', bn: 'bengali|bangla|lily', hi: 'hindi|viraj|bunty', es: 'spanish|español|carmen|maria' };

// digits are synthesized as spoken words so TTS uses the right language
const NUM_WORDS = {
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
  bn: ['শূন্য', 'এক', 'দুই', 'তিন', 'চার', 'পাঁচ', 'ছয়', 'সাত', 'আট', 'নয়'],
  hi: ['शून्य', 'एक', 'दो', 'तीन', 'चार', 'पाँच', 'छह', 'सात', 'आठ', 'नौ'],
  es: ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'],
};

async function synthesize(voiceId, text, file) {
  if (fs.existsSync(file)) return false;
  // eleven_v3 supports Bengali and other languages multilingual v2 cannot
  const res = await api(`/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_v3',
    }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return true;
}

(async () => {
  if (!KEY && !dryRun) {
    console.error('Set ELEVENLABS_API_KEY in the environment first.');
    process.exit(1);
  }
  let totalChars = 0;
  for (const lang of langs) {
    const ttsPath = path.join(__dirname, '..', `tts${lang === 'en' ? '' : '.' + lang}.json`);
    const tts = JSON.parse(fs.readFileSync(ttsPath, 'utf8'));
    const { sentences, fragments, nums } = collectClips(tts);
    const base = path.join(__dirname, '..', 'audio', lang);
    for (const d of ['sent', 'frag', 'num']) fs.mkdirSync(path.join(base, d), { recursive: true });

    const manifest = {};
    const jobs = [];
    for (const text of sentences) {
      const file = path.join(base, 'sent', slug(text) + '.mp3');
      manifest[text] = 'sent/' + slug(text) + '.mp3';
      jobs.push(['sentence', text, file]);
    }
    // fixed multiplication-lesson steps: one fluent clip per step, keyed by the
    // step's exact `say` text so index.html's manifest lookup finds it
    const lessons = [...lessonSentences(tts)].filter((s) => !sentences.has(s));
    for (const text of lessons) {
      const file = path.join(base, 'sent', slug(text) + '.mp3');
      manifest[text] = 'sent/' + slug(text) + '.mp3';
      jobs.push(['lesson', digitsToWords(lang, text), file]);
    }
    for (const text of fragments) jobs.push(['fragment', text, path.join(base, 'frag', slug(text) + '.mp3')]);
    const words = NUM_WORDS[lang] || NUM_WORDS.en;
    for (const n of nums) {
      const text = n <= 9 ? words[n] : String(n);
      jobs.push(['number', text, path.join(base, 'num', n + '.mp3')]);
    }

    console.log(`\n[${lang}] ${sentences.size} sentences, ${fragments.size} fragments, ${nums.length} numbers`);
    if (dryRun) {
      jobs.forEach(([kind, text]) => console.log(`  ${kind}: ${JSON.stringify(text)}`));
      continue;
    }

    const voiceId = await pickVoice(lang, NAME_HINT[lang] || lang);
    let done = 0, skipped = 0;
    for (const [kind, text, file] of jobs) {
      try {
        const made = await synthesize(voiceId, text, file);
        if (made) { done++; totalChars += text.length; }
        else skipped++;
        process.stdout.write(`\r  ${done} generated, ${skipped} existing, ${jobs.length - done - skipped} left`);
      } catch (e) {
        console.error(`\n  FAILED ${kind} ${JSON.stringify(text)}: ${e.message}`);
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 350)); // stay well under rate limits
    }
    console.log('');
    fs.writeFileSync(path.join(base, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`  manifest.json written`);
  }
  if (!dryRun) console.log(`\nDone. Characters used this run: ~${totalChars}`);
})();
