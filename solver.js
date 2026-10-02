/*
 * solver.js — turns an arithmetic expression into a list of narration steps
 * for a soroban abacus, using the sentence templates in tts.json.
 *
 * A step is { say, place, digit } — speak `say`, then animate rod `place`
 * to show `digit`. place 1 = units (rightmost rod). place 0 / digit null
 * means "speak only, no bead change".
 *
 * Works in the browser (window.Solver) and under node (module.exports)
 * so the logic can be unit-tested without a DOM.
 */
(function (global) {
  'use strict';

  const TOTAL_RODS = 7; // default; override per-Solver
  

  function fill(template, vars) {
    return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  }

  function placeName(T, place) {
    const names = T.place_names;
    return names[String(place)] || fill(names.fallback, { place });
  }

  function operatorWord(T, operator) {
    const w = (T.meta && T.meta.operator_words) || {};
    if (operator === '+') return w.plus || 'plus';
    if (operator === '-') return w.minus || 'minus';
    if (operator === '*') return w.times || 'times';
    return w.divide || 'divided by';
  }

  // build an audio clip recipe for a filled template:
  //   {s: text}  -> whole-sentence clip
  //   {f: text}  -> fragment clip (literal text or non-numeric var like a place name)
  //   {n: value} -> number clip (0-9, spoken digit by digit for any size)
  function recipeOf(template, vars) {
    vars = vars || {};
    const parts = String(template).split(/(\{\w+\})/);
    const recipe = [];
    for (const part of parts) {
      if (!part) continue;
      const m = part.match(/^\{(\w+)\}$/);
      if (!m) { recipe.push({ f: part }); continue; }
      const v = vars[m[1]];
      if (v === undefined) { recipe.push({ f: part }); continue; }
      if (Number.isInteger(v) && v >= 0) {
        // numbers are spoken digit by digit (clips only cover 0-9)
        String(v).split('').forEach((ch) => recipe.push({ n: Number(ch) }));
      } else recipe.push({ f: String(v) });
    }
    return recipe.length === 1 && recipe[0].s === undefined && !/\{/.test(template) ? [{ s: template }] : recipe;
  }

  function narrate(template, vars) {
    return { say: fill(template, vars), audio: recipeOf(template, vars) };
  }

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function beadActionText(T, action, placeNameStr, count) {
    const a = T.bead_actions[action];
    const tpl = typeof a === 'object' ? (count === 1 ? a.one : a.many) : a;
    return fill(tpl, { place_name: placeNameStr, count });
  }

  function Solver(T, rods) {
    this.T = T;
    this.rods = rods || TOTAL_RODS;
    this.maxValue = Math.pow(10, this.rods) - 1;
  }

  // state: array indexed [place-1] of digits 0..9
  Solver.prototype.solve = function (a, operator, b, opts) {
    const T = this.T;
    opts = opts || {};
    const lessonMode = !!opts.lesson; // lessons narrate zero digits, watch mode skips them
    const steps = [];
    const vars = {
      first_number: a,
      second_number: b,
      operator_word: operatorWord(T, operator),
    };

    if (operator !== '+' && operator !== '-' && operator !== '*' && operator !== '/') {
      throw new Error('Only +, -, * and / are supported for now');
    }
    function early(line) {
      const step = line && typeof line === 'object' ? line : { say: line, audio: null };
      return { steps: [{ say: step.say, audio: step.audio || null, place: 0, digit: null }], result: null };
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
      return early(T.special_cases.invalid_input);
    }
    if (a > this.maxValue || b > this.maxValue) {
      return early(narrate(T.special_cases.overflow, { total_rods: this.rods }));
    }
    if (operator === '/' && b === 0) {
      return early(T.division.by_zero);
    }
    const result = operator === '+' ? a + b : operator === '-' ? a - b
      : operator === '*' ? a * b : Math.floor(a / b);
    if (result < 0) {
      return early(T.special_cases.negative_result);
    }
    if (result > this.maxValue) {
      return early(narrate(T.special_cases.overflow, { total_rods: this.rods }));
    }

    const core = this._core(steps);
    const { push, setNumber, addAt, subAt, digitAt } = core;

    // add a multi-digit number n starting at `place` (units of n sits on `place`),
    // most significant digit first, using the narrated add methods
    function addNumberAt(place, n) {
      const s = String(n);
      for (let i = 0; i < s.length; i++) addAt(place + (s.length - 1 - i), Number(s[i]));
    }

    function subNumberAt(place, n) {
      const s = String(n);
      for (let i = 0; i < s.length; i++) subAt(place + (s.length - 1 - i), Number(s[i]));
    }

    function applyNumber(n) {
      const s = (lessonMode && opts.bPad) || String(n);
      push(T.session.start_from_left, 0, null);
      for (let i = 0; i < s.length; i++) {
        const d = Number(s[i]);
        const place = s.length - i;
        if (d === 0) {
          if (lessonMode) {
            push(narrate(
              operator === '+' ? T.special_cases.zero_digit_add : T.special_cases.zero_digit_sub,
              { place_name: placeName(T, place), digit: digitAt(place) },
            ), 0, null);
          }
          continue;
        }
        push(narrate(T.session.next_digit, { place_name: placeName(T, place), digit: d }), 0, null);
        if (operator === '+') addAt(place, d);
        else subAt(place, d);
      }
    }

    // --- assemble the session ---
    steps.push({ say: T.session.welcome, place: 0, digit: null });
    steps.push({ say: T.session.clearing, place: 0, digit: null, clear: true });
    steps.push({ say: T.session.cleared, place: 0, digit: null });
    if (operator === '*') {
      // school method: every digit of a times every digit of b, one digit
      // pair at a time, accumulated left to right with the narrated add methods
      push(narrate(T.session.problem_intro, vars), 0, null);
      push(narrate(T.multiplication.intro, vars), 0, null);
      let acc = 0;
      const as = String(a), bs = String(b);
      // teach where the first product lands: digit count of both numbers, one less
      push(narrate(T.multiplication.start_left, { place_name: placeName(T, as.length), first_number: a }), 0, null);
      const totalDigits = as.length + bs.length;
      if (totalDigits > 2) {
        // where to start: multiply the leading digits; >= 10 means count all
        // digits, < 10 means one less — that rod holds the leading digit
        const fd = Number(as[0]), sd = Number(bs[0]);
        const fprod = fd * sd;
        push(narrate(T.multiplication.start_rod_intro, {}), 0, null);
        if (fprod >= 10) {
          push(narrate(T.multiplication.start_rod_big, {
            digit: fd, digit2: sd, fprod, digits_total: totalDigits,
            place_name: placeName(T, totalDigits),
          }), 0, null);
        } else {
          push(narrate(T.multiplication.start_rod_small, {
            digit: fd, digit2: sd, fprod, digits_total: totalDigits,
            start_place: totalDigits - 1, place_name: placeName(T, totalDigits - 1),
          }), 0, null);
        }
        push(narrate(T.multiplication.multi_note, {}), 0, null);
      } else {
        push(narrate(T.multiplication.units_only, {}), 0, null);
        if (Number(as[0]) * Number(bs[0]) >= 10) {
          push(narrate(T.multiplication.units_only_big, {
            digit: Number(as[0]), digit2: Number(bs[0]),
          }), 0, null);
        }
      }
      for (let i = 0; i < as.length; i++) {
        const da = Number(as[i]);
        const pa = as.length - i;
        if (da === 0) continue;
        if (i > 0) {
          push(narrate(T.multiplication.next_rod, { place_name: placeName(T, pa + bs.length - 1) }), 0, null);
        }
        push(narrate(T.session.next_digit, {
          place_name: placeName(T, pa), digit: da,
        }), 0, null);
        for (let j = 0; j < bs.length; j++) {
          const db = Number(bs[j]);
          const pb = bs.length - j;
          if (db === 0) continue;
          const partial = da * db;
          const place = pa + pb - 1;
          push(narrate(T.multiplication.partial, {
            digit: da, digit2: db, partial,
          }), 0, null);
          addNumberAt(place, partial);
          acc += partial * Math.pow(10, place - 1);
          push(narrate(T.session.current_value, { current_value: acc }), 0, null);
        }
      }
    } else if (operator === '/') {
      // long division on the soroban: the divisor sits on the far-left rods,
      // the dividend in the middle, and the quotient grows on the right rods,
      // one digit at a time, ending on the units rod
      push(narrate(T.session.problem_intro, vars), 0, null);
      push(narrate(T.division.intro, vars), 0, null);
      const as = String(a), bs = String(b);
      const qd = a < b ? '0' : String(Math.floor(a / b));
      const Q = qd.length;
      if (bs.length + as.length + Q > this.rods) {
        const n = narrate(T.special_cases.overflow, { total_rods: this.rods });
        steps.push({ say: n.say, audio: n.audio, place: 0, digit: null });
        return { steps, result: null };
      }
      push(narrate(T.division.setup_divisor, vars), 0, null);
      for (let j = 0; j < bs.length; j++) {
        push(narrate(T.session.set_digit, {
          digit: Number(bs[j]), place_name: placeName(T, this.rods - j),
        }), this.rods - j, Number(bs[j]));
      }
      push(narrate(T.division.setup_dividend, vars), 0, null);
      const u = Q + 1; // units rod of the dividend
      for (let i = 0; i < as.length; i++) {
        push(narrate(T.session.set_digit, {
          digit: Number(as[i]), place_name: placeName(T, u + as.length - 1 - i),
        }), u + as.length - 1 - i, Number(as[i]));
      }
      push(narrate(T.division.setup_quotient, vars), 0, null);
      let cur = 0, ranOnce = false, qRod = Q;
      for (let i = 0; i < as.length; i++) {
        cur = cur * 10 + Number(as[i]);
        if (!ranOnce && cur < b) continue; // still gathering leading digits
        ranOnce = true;
        const q = Math.floor(cur / b);
        const product = q * b;
        const rem = cur - product;
        push(narrate(T.division.work, { cur }), 0, null);
        push(narrate(T.division.ask, Object.assign({}, vars, { cur })), 0, null);
        push(narrate(T.division.times, { q, second_number: b, product }), 0, null);
        if (product > 0) subNumberAt(u + as.length - 1 - i, product);
        push(narrate(T.division.quotient_digit, {
          q, place_name: placeName(T, qRod),
        }), qRod, q);
        push(narrate(T.division.left, { rem }), 0, null);
        qRod -= 1;
        cur = rem;
      }
      if (!ranOnce) {
        // a < b: quotient 0, remainder a
        push(narrate(T.division.work, { cur: a }), 0, null);
        push(narrate(T.division.ask, Object.assign({}, vars, { cur: a })), 0, null);
        push(narrate(T.division.times, { q: 0, second_number: b, product: 0 }), 0, null);
        push(narrate(T.division.quotient_digit, { q: 0, place_name: placeName(T, 1) }), 1, 0);
        push(narrate(T.division.left, { rem: a }), 0, null);
      }
      const remainder = operator === '/' ? a - Math.floor(a / b) * b : 0;
      const quotient = Number(qd);
      if (remainder > 0) {
        push(narrate(T.division.remainder, Object.assign({}, vars, {
          quotient, rem: remainder,
        })), 0, null);
      }
      // the quotient is already on the right rods; keep it on display
    } else {
      setNumber(a, vars);
      push(narrate(T.session.problem_intro, vars), 0, null);
      applyNumber(b);
    }
    push(narrate(T.session.result, { result }), 0, null);
    push(narrate(T.session.problem_complete, Object.assign({}, vars, { result })), 0, null);
    return { steps, result };
  };


  // shared step-building machinery used by solve() and countSteps()
  Solver.prototype._core = function (steps) {
    const T = this.T;
    const state = new Array(this.rods).fill(0);
    const self = this;

    function push(say, place, digit) {
      const step = typeof say === 'object' && say !== null ? say : { say };
      steps.push({ say: step.say, audio: step.audio || null, place, digit });
      if (place >= 1) state[place - 1] = digit;
    }

    function digitAt(place) {
      return state[place - 1];
    }

    // --- setting a digit directly (used for the first number) ---
    function setDigit(place, d) {
      if (d === 0) return;
      const pn = placeName(T, place);
      push(narrate(T.session.set_digit, { digit: d, place_name: pn }), place, d);
    }

    function setNumber(n, vars) {
      push(narrate(T.session.set_number, vars), 0, null);
      const s = String(n);
      for (let i = 0; i < s.length; i++) {
        setDigit(s.length - i, Number(s[i]));
      }
      push(narrate(T.session.current_value, { current_value: n }), 0, null);
    }

    // say a method intro only when the method changes, not per digit
    let lastMethod = null;
    function methodIntro(key, template, vars) {
      if (lastMethod === key) return;
      lastMethod = key;
      push(narrate(template, vars), 0, null);
    }

    // --- addition ---
    function addAt(place, d) {
      if (d === 0) return;
      if (place > self.rods) throw new Error('overflow');
      const c = digitAt(place);
      const pn = placeName(T, place);
      const t = c + d;

      if (t <= 9) {
        const e = c % 5;
        const h = c >= 5 ? 1 : 0;
        if (t <= 9 && (h === 1 || e + d <= 4 || d >= 5)) {
          // direct addition (covers earth, heaven+earth)
          const op = T.operations.direct_addition;
          methodIntro('direct_addition', op.intro, { number: d, place_name: pn });
          push(narrate(op.steps.add, { number: d, place_name: pn }), place, t);
          push(narrate(op.outro, { digit: t, place_name: pn }), 0, null);
        } else {
          // five complement: add 5, remove 5-d
          const comp = 5 - d;
          const op = T.operations.five_complement_addition;
          methodIntro('five_complement_addition', op.intro, { number: d, place_name: pn });
          push(narrate(op.steps.add_five, { place_name: pn }), place, c + 5);
          push(narrate(op.steps.subtract_complement, { complement_5: comp, place_name: pn }), place, t);
          push(narrate(op.outro, { digit: t, place_name: pn }), 0, null);
        }
        return;
      }

      // ten complement: carry one to the left, subtract 10-d here
      const comp = 10 - d;
      const op = T.operations.ten_complement_addition;
      const nextPn = placeName(T, place + 1);
      if (digitAt(place + 1) === 9 && place + 1 <= self.rods) {
        push(narrate(T.special_cases.carry_cascade, { next_place_name: nextPn }), 0, null);
      }
      methodIntro('ten_complement_addition', op.intro, { number: d, place_name: pn });
      push(narrate(op.steps.carry, { next_place_name: nextPn }), 0, null);
      addAt(place + 1, 1);
      push(narrate(op.steps.subtract_complement, { complement_10: comp, place_name: pn }), place, t - 10);
      push(narrate(op.outro, { digit: t - 10, place_name: pn, next_place_name: nextPn }), 0, null);
    }

    // --- subtraction ---
    function subAt(place, d) {
      if (d === 0) return;
      const c = digitAt(place);
      const pn = placeName(T, place);
      const t = c - d;

      if (t >= 0) {
        const e = c % 5;
        const h = c >= 5 ? 1 : 0;
        if (h === 0 || e >= d || d >= 5) {
          // direct subtraction (earth only, or heaven + earth)
          const op = T.operations.direct_subtraction;
          methodIntro('direct_subtraction', op.intro, { number: d, place_name: pn });
          push(narrate(op.steps.subtract, { number: d, place_name: pn }), place, t);
          push(narrate(op.outro, { digit: t, place_name: pn }), 0, null);
        } else {
          // five complement: remove 5, add back 5-d
          const comp = 5 - d;
          const op = T.operations.five_complement_subtraction;
          methodIntro('five_complement_subtraction', op.intro, { number: d, place_name: pn });
          push(narrate(op.steps.subtract_five, { place_name: pn }), place, c - 5);
          push(narrate(op.steps.add_complement, { complement_5: comp, place_name: pn }), place, t);
          push(narrate(op.outro, { digit: t, place_name: pn }), 0, null);
        }
        return;
      }

      // ten complement: borrow one from the left, add 10-d here
      const comp = 10 - d;
      const op = T.operations.ten_complement_subtraction;
      const nextPn = placeName(T, place + 1);
      if (place + 1 > self.rods || digitAt(place + 1) === 0) {
        if (place + 1 <= self.rods) {
          push(narrate(T.special_cases.borrow_cascade, { next_place_name: nextPn }), 0, null);
        }
      }
      methodIntro('ten_complement_subtraction', op.intro, { number: d, place_name: pn });
      push(narrate(op.steps.borrow, { next_place_name: nextPn }), 0, null);
      subAt(place + 1, 1);
      push(narrate(op.steps.add_complement, { complement_10: comp, place_name: pn }), place, t + 10);
      push(narrate(op.outro, { digit: t + 10, place_name: pn, next_place_name: nextPn }), 0, null);
    }

    return { state, push, digitAt, setDigit, setNumber, addAt, subAt };
  };

  // count (or reverse-count) one bead at a time from `from` to `to`
  Solver.prototype.countSteps = function (from, to) {
    const T = this.T;
    function early(say) {
      return { steps: [{ say, place: 0, digit: null }], result: null };
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0) {
      return early(T.special_cases.invalid_input);
    }
    if (from > this.maxValue || to > this.maxValue) {
      return early(narrate(T.special_cases.overflow, { total_rods: this.rods }));
    }
    const steps = [];
    const core = this._core(steps);
    steps.push({ say: T.session.clearing, place: 0, digit: null, clear: true });
    steps.push({ say: T.session.cleared, place: 0, digit: null });
    core.setNumber(from, {
      first_number: from,
      second_number: to,
      operator_word: operatorWord(T, from <= to ? '+' : '-'),
    });
    const inc = from <= to ? 1 : -1;
    for (let v = from + inc; ; v += inc) {
      const before = steps.length;
      if (inc > 0) core.addAt(1, 1);
      else core.subAt(1, 1);
      // counting says one sentence per number: drop the method narration and
      // label the bead moves with the running value instead
      const valueStep = narrate(T.session.current_value, { current_value: v });
      let said = false;
      for (let k = before; k < steps.length; k++) {
        if (steps[k].place >= 1) {
          steps[k].say = said ? '' : valueStep.say;
          steps[k].audio = said ? null : valueStep.audio;
          said = true;
        }
      }
      const kept = steps.slice(0, before).concat(steps.slice(before).filter((st) => st.place >= 1));
      steps.length = 0;
      steps.push.apply(steps, kept);
      // if a rod beyond the units was touched, announce the carry/borrow,
      // then the reset of every lower rod (units gives up its 9, or gains it back)
      const carryPlace = kept.slice(before).reduce((m, st) => Math.max(m, st.place), 0);
      if (carryPlace >= 2) {
        const carryTpl = inc > 0
          ? T.operations.ten_complement_addition.steps.carry
          : T.operations.ten_complement_subtraction.steps.borrow;
        const resetTpl = inc > 0
          ? T.operations.ten_complement_addition.steps.subtract_complement
          : T.operations.ten_complement_subtraction.steps.add_complement;
        const newSteps = [Object.assign(
          narrate(carryTpl, { next_place_name: placeName(T, carryPlace) }),
          { place: 0, digit: null }
        )];
        const resetPlaces = kept
          .slice(before)
          .filter((st) => st.place >= 1 && st.place < carryPlace)
          .map((st) => st.place)
          .sort((x, y) => x - y);
        resetPlaces.forEach((p) => {
          newSteps.push(Object.assign(
            narrate(resetTpl, { complement_10: 9, place_name: placeName(T, p) }),
            { place: 0, digit: null }
          ));
        });
        steps.splice.apply(steps, [before, 0].concat(newSteps));
      }
      // cue the action before the beads move: "Now add 1." / "Now subtract 1."
      steps.splice(before, 0, Object.assign(
        narrate(inc > 0 ? (T.session.count_add || 'Now add 1.') : (T.session.count_subtract || 'Now subtract 1.'), {}),
        { place: 0, digit: null }
      ));
      if (v === to) break;
    }
    return { steps, result: to };
  };

  // steps for practice mode: clear + set first number, then hand over
  Solver.prototype.practiceSetup = function (a, operator, b) {
    const T = this.T;
    const vars = {
      first_number: a,
      second_number: b,
      operator_word: operatorWord(T, operator),
    };
    if (operator === '/' && b === 0) {
      return early(T.division.by_zero);
    }
    const result = operator === '+' ? a + b : operator === '-' ? a - b
      : operator === '*' ? a * b : Math.floor(a / b);
    const steps = [];
    steps.push({ say: T.session.clearing, place: 0, digit: null, clear: true });
    // addition, subtraction and division start with the first number (the
    // dividend) on the abacus; multiplication starts from a cleared abacus
    if (operator !== '*') {
      const s = String(a);
      steps.push(narrate(T.session.set_number, vars));
      for (let i = 0; i < s.length; i++) {
        const place = s.length - i;
        const d = Number(s[i]);
        if (d === 0) continue;
        const n = narrate(T.session.set_digit, { digit: d, place_name: placeName(T, place) });
        steps.push({ say: n.say, audio: n.audio, place, digit: d });
      }
    }
    steps.push(narrate(T.session.problem_intro, vars));
    // cue for the biggest digit of b that changes beads
    const bs = String(b);
    let cue = null;
    if (operator === '*') {
      cue = narrate(T.feedback.your_turn_multiply, vars);
    } else if (operator === '/') {
      cue = narrate(T.division.your_turn_divide, vars);
    } else {
      for (let i = bs.length; i >= 1; i--) {
        if (Number(bs[i - 1]) !== 0) {
          cue = narrate(T.feedback.your_turn, {
            number: Number(bs[i - 1]),
            place_name: placeName(T, bs.length - i + 1),
          });
          break;
        }
      }
    }
    if (cue) steps.push({ say: cue.say, audio: cue.audio, place: 0, digit: null });
    return { steps, result };
  };

  const api = { Solver, fill, placeName, pick, operatorWord };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Solver = api;
})(typeof window !== 'undefined' ? window : globalThis);
