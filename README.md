# Virtual Abacus

A virtual soroban (Japanese abacus) that teaches children arithmetic step by step — with a real recorded voice in four languages.

**Try it here: https://apurbajnu.github.io/abacus/**

## What it does

- **Introduction** — a narrated 8-scene story: where numbers came from, how the abacus evolved, and a tour of every part (rods, beam, heaven and earth beads), animated on the abacus itself.
- **Lessons** — 12 guided lessons, from one-digit addition up to three-digit × two-digit multiplication. Each lesson solves on the abacus with full spoken explanation. Multiplication lessons teach the starting-rod rule: multiply the leading digits — if the product is ten or more, count all the digits of both numbers; if less, one less — and that rod is where you begin.
- **Watch mode** — a calculator with explanation: enter any problem (+ − × ÷) and watch every bead move while it is narrated, including carries, borrows and complements. Counting and reverse counting included.
- **Practice mode** — random problems per operator; the abacus is set up for you, you move the beads, and if you get it wrong you can watch the full solution.

## Languages

English, বাংলা (Bengali), हिन्दी (Hindi), Español — each with native numerals where applicable and a pre-recorded voice library (ElevenLabs eleven_v3). System text-to-speech is the automatic fallback when clips are unavailable; the two are never mixed.

## Running locally

It is a static page — any web server works:

```bash
cd abacus
python3 -m http.server 8000
# open http://localhost:8000
```

Tests for the step engine (every narration replays exactly on the beads):

```bash
node test/solver-test.js
```

## Regenerating voice clips

`tools/gen-voice.js` synthesizes the narration clips from the `tts*.json` templates. Put your ElevenLabs API key in `tools/.env` (gitignored) as `ELEVENLABS_API_KEY=...`, then:

```bash
node tools/gen-voice.js --lang=en,bn,hi,es
```

It is resumable — existing clips are skipped, so it only generates what is new. Digits are synthesized as spoken words in each language.
