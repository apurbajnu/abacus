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

async function api(pathname, opts) {
  const res = await fetch(API + pathname, opts);
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${await res.text()}`);
  return res;
}

async function pickVoice(langCode, nameHint) {
  if (process.env['VOICE_' + langCode.toUpperCase()]) return process.env['VOICE_' + langCode.toUpperCase()];
  const res = await api('/voices', { headers: { 'xi-api-key': KEY } });
  const voices = (await res.json()).voices || [];
  const match = voices.find((v) => new RegExp(nameHint, 'i').test(v.name))
    || voices.find((v) => (v.labels && v.labels.language || '').toLowerCase().startsWith(langCode));
  if (!match) {
    // multilingual v2 voices speak any language; fall back to the first voice
    match = voices[0];
    console.error(`  note: no language-matched voice for ${langCode}; using "${match.name}". Override with VOICE_${langCode.toUpperCase()}.`);
  }
  console.log(`voice for ${langCode}: ${match.name} (${match.voice_id})`);
  return match.voice_id;
}

const NAME_HINT = { en: 'english|emma|arthur|brian', bn: 'bengali|bangla|lily', hi: 'hindi|viraj|bunty' };

// digits are synthesized as spoken words so TTS uses the right language
const NUM_WORDS = {
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
  bn: ['শূন্য', 'এক', 'দুই', 'তিন', 'চার', 'পাঁচ', 'ছয়', 'সাত', 'আট', 'নয়'],
  hi: ['शून्य', 'एक', 'दो', 'तीन', 'चार', 'पाँच', 'छह', 'सात', 'आठ', 'नौ'],
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
