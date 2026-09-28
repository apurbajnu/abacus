/*
 * abacus.js — soroban UI: 7 rods, 1 heaven bead + 4 earth beads each.
 * Beads are draggable (pointer events) and can be set programmatically
 * with animated transitions. Beads touching the beam are counted.
 */
(function (global) {
  'use strict';

  const W = 860, H = 470;
  const BEAM_Y = H / 2;
  const SLOT0 = BEAM_Y + 24;   // top earth slot (engaged, touching beam)
  const SLOT_GAP = 28;         // earth slot pitch (8 slots)
  const EARTH_SLOTS = 8;
  const HEAVEN_ON = BEAM_Y - 30;   // heaven bead center when engaged
  const HEAVEN_OFF = 78;           // heaven bead center when disengaged
  const BEAD_H = 24;
  const NS = 'http://www.w3.org/2000/svg';

  function Abacus(container, opts) {
    opts = opts || {};
    this.onchange = opts.onchange || function () {};
    this.rods = Math.max(1, Math.min(10, opts.rods || 7));
    this.digits = new Array(this.rods).fill(0); // digits[0] = units rod (rightmost)
    this.locked = false; // true while automated playback moves the beads
    this.build(container);
    this.render();
  }

  Abacus.prototype.build = function (container) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.classList.add('abacus-svg');

    const frame = document.createElementNS(NS, 'rect');
    frame.setAttribute('x', 6); frame.setAttribute('y', 6);
    frame.setAttribute('width', W - 12); frame.setAttribute('height', H - 12);
    frame.setAttribute('rx', 18);
    frame.classList.add('abacus-frame');
    svg.appendChild(frame);
    this.frameEl = frame;

    const beam = document.createElementNS(NS, 'rect');
    beam.setAttribute('x', 6); beam.setAttribute('y', BEAM_Y - 9);
    beam.setAttribute('width', W - 12); beam.setAttribute('height', 18);
    beam.classList.add('abacus-beam');
    svg.appendChild(beam);
    this.beamEl = beam;

    const rodGap = W / (this.rods + 1);
    this.beadW = rodGap * 0.72;
    this.rodX = [];
    this.rodEls = [];
    this.beadEls = [];

    for (let r = 0; r < this.rods; r++) {
      const x = W - rodGap * (r + 1); // r=0 units at the right
      this.rodX[r] = x;

      const rod = document.createElementNS(NS, 'line');
      rod.setAttribute('x1', x); rod.setAttribute('y1', 40);
      rod.setAttribute('x2', x); rod.setAttribute('y2', H - 40);
      rod.classList.add('abacus-rod');
      svg.appendChild(rod);
      this.rodEls[r] = rod;

      const value = Math.pow(10, r);
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', x);
      label.setAttribute('y', H - 14);
      label.setAttribute('text-anchor', 'middle');
      label.classList.add('abacus-place-label');
      label.textContent = value >= 1000000000
        ? (value / 1000000000) + 'B'
        : value >= 1000000 ? (value / 1000000) + 'M'
        : value >= 1000 ? (value / 1000) + 'k' : String(value);
      svg.appendChild(label);

      const makeBead = (cls, kind, earthIndex) => {
        const el = document.createElementNS(NS, 'rect');
        el.setAttribute('rx', 12);
        el.classList.add('abacus-bead', cls);
        el.dataset.rod = r;
        el.dataset.kind = kind;
        if (earthIndex !== undefined) el.dataset.earthIndex = earthIndex;
        el.style.cursor = 'pointer';
        svg.appendChild(el);
        this.attachDrag(el);
        return el;
      };

      const digitLabel = document.createElementNS(NS, 'text');
      digitLabel.setAttribute('x', x);
      digitLabel.setAttribute('y', 28);
      digitLabel.setAttribute('text-anchor', 'middle');
      digitLabel.classList.add('abacus-digit-label');
      svg.appendChild(digitLabel);

      this.beadEls[r] = {
        heaven: makeBead('heaven', 'heaven'),
        earth: [0, 1, 2, 3].map((i) => makeBead('earth', 'earth', i)),
        digitLabel,
      };
    }

    container.appendChild(svg);
    this.svg = svg;
  };

  Abacus.prototype.attachDrag = function (el) {
    // click-to-toggle: no dragging
    el.addEventListener('click', () => this.onBeadClick(el));
  };

  Abacus.prototype.onBeadClick = function (el) {
    if (this.locked) return; // playback in progress
    const r = Number(el.dataset.rod);
    const old = this.digits[r];

    if (el.dataset.kind === 'heaven') {
      this.digits[r] = old >= 5 ? old - 5 : old + 5;
    } else {
      const i = Number(el.dataset.earthIndex); // 0 = bead nearest the beam
      const engaged = old % 5;
      // clicking an engaged bead releases it; clicking a released bead
      // engages it (and only it — beads never change places)
      const count = i < engaged ? i : i + 1;
      this.digits[r] = (old >= 5 ? 5 : 0) + count;
    }
    this.render();
    this.onchange(this.value());
  };

  Abacus.prototype.earthSlotY = function (j) {
    return SLOT0 + j * SLOT_GAP;
  };

  // guided-tour highlighting: part is one of
  // 'frame' | 'rod' | 'beam' | 'heaven' | 'earth' | 'place', or null to clear
  Abacus.prototype.highlight = function (part) {
    this.svg.querySelectorAll('.hl').forEach((el) => el.classList.remove('hl'));
    if (!part) return;
    const u = 0; // demonstrate on the units rod (rightmost)
    if (part === 'frame') this.frameEl.classList.add('hl');
    else if (part === 'rod') this.rodEls.forEach((el) => el.classList.add('hl'));
    else if (part === 'beam') this.beamEl.classList.add('hl');
    else if (part === 'heaven') this.beadEls[u].heaven.classList.add('hl');
    else if (part === 'earth') this.beadEls[u].earth.forEach((el) => el.classList.add('hl'));
    else if (part === 'place') {
      this.rodEls[0].classList.add('hl');
      this.rodEls[1].classList.add('hl');
      this.beadEls[0].earth.forEach((el) => el.classList.add('hl'));
      this.beadEls[1].earth.forEach((el) => el.classList.add('hl'));
    }
  };

  Abacus.prototype.setDigit = function (rodIndex, d) {
    this.digits[rodIndex] = d;
    this.render();
    this.onchange(this.value());
  };

  Abacus.prototype.setRodByPlace = function (place, d) {
    this.setDigit(place - 1, d);
  };

  Abacus.prototype.clear = function () {
    this.digits.fill(0);
    this.render();
    this.onchange(0);
  };

  Abacus.prototype.value = function () {
    return this.digits.reduce((v, d, i) => v + d * Math.pow(10, i), 0);
  };

  Abacus.prototype.placeBead = function (el, cy) {
    const x = this.rodX[Number(el.dataset.rod)];
    el.setAttribute('x', x - this.beadW / 2);
    el.setAttribute('y', cy - BEAD_H / 2);
    el.setAttribute('width', this.beadW);
    el.setAttribute('height', BEAD_H);
  };

  // place all earth beads of a rod: engaged ones at the beam, rest packed below
  Abacus.prototype.render = function () {
    for (let r = 0; r < this.rods; r++) {
      const d = this.digits[r];
      const { heaven, earth, digitLabel } = this.beadEls[r];

      digitLabel.textContent = d;

      this.placeBead(heaven, d >= 5 ? HEAVEN_ON : HEAVEN_OFF);
      heaven.classList.toggle('active', d >= 5);

      const k = d % 5;
      earth.forEach((el, i) => {
        const slot = i < k ? i : EARTH_SLOTS - 4 + i;
        this.placeBead(el, this.earthSlotY(slot));
        el.classList.toggle('active', i < k);
      });
    }
  };

  global.Abacus = Abacus;
})(window);
