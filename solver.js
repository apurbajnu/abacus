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
  Solver.prototype.solve = function (a, operator, b) {
    const T = this.T;
    const steps = [];
    const vars = {
      first_number: a,
      second_number: b,
      operator_word: operator === '+' ? 'plus' : 'minus',
    };

    if (operator !== '+' && operator !== '-') {
      throw new Error('Only + and - are supported for now');
    }
    function early(say) {
      return { steps: [{ say, place: 0, digit: null }], result: null };
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
      return early(T.special_cases.invalid_input);
    }
    if (a > this.maxValue || b > this.maxValue) {
      return early(fill(T.special_cases.overflow, { total_rods: this.rods }));
    }
    const result = operator === '+' ? a + b : a - b;
    if (result < 0) {
      return early(T.special_cases.negative_result);
    }
    if (result > this.maxValue) {
      return early(fill(T.special_cases.overflow, { total_rods: this.rods }));
    }

    const core = this._core(steps);
    const { push, setNumber, addAt, subAt } = core;

    function applyNumber(n) {
      const s = String(n);
      push(T.session.start_from_left, 0, null);
      for (let i = 0; i < s.length; i++) {
        const d = Number(s[i]);
        const place = s.length - i;
        if (d === 0) continue;
        push(fill(T.session.next_digit, { place_name: placeName(T, place), digit: d }), 0, null);
        if (operator === '+') addAt(place, d);
        else subAt(place, d);
      }
    }

    // --- assemble the session ---
    steps.push({ say: T.session.welcome, place: 0, digit: null });
    steps.push({ say: T.session.clearing, place: 0, digit: null, clear: true });
    steps.push({ say: T.session.cleared, place: 0, digit: null });
    setNumber(a, vars);
    push(fill(T.session.problem_intro, vars), 0, null);
    applyNumber(b);
    push(fill(T.session.result, { result }), 0, null);
    push(fill(T.session.problem_complete, Object.assign({}, vars, { result })), 0, null);
    return { steps, result };
  };


  // shared step-building machinery used by solve() and countSteps()
  Solver.prototype._core = function (steps) {
    const T = this.T;
    const state = new Array(this.rods).fill(0);
    const self = this;

    function push(say, place, digit) {
      steps.push({ say, place, digit });
      if (place >= 1) state[place - 1] = digit;
    }

    function digitAt(place) {
      return state[place - 1];
    }

    // --- setting a digit directly (used for the first number) ---
    function setDigit(place, d) {
      if (d === 0) return;
      const pn = placeName(T, place);
      push(fill(T.session.set_digit, { digit: d, place_name: pn }), place, d);
    }

    function setNumber(n, vars) {
      push(fill(T.session.set_number, vars), 0, null);
      const s = String(n);
      for (let i = 0; i < s.length; i++) {
        setDigit(s.length - i, Number(s[i]));
      }
      push(fill(T.session.current_value, { current_value: n }), 0, null);
    }

    // say a method intro only when the method changes, not per digit
    let lastMethod = null;
    function methodIntro(key, template, vars) {
      if (lastMethod === key) return;
      lastMethod = key;
      push(fill(template, vars), 0, null);
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
          push(fill(op.steps.add, { number: d, place_name: pn }), place, t);
          push(fill(op.outro, { digit: t, place_name: pn }), 0, null);
        } else {
          // five complement: add 5, remove 5-d
          const comp = 5 - d;
          const op = T.operations.five_complement_addition;
          methodIntro('five_complement_addition', op.intro, { number: d, place_name: pn });
          push(fill(op.steps.add_five, { place_name: pn }), place, c + 5);
          push(fill(op.steps.subtract_complement, { complement_5: comp, place_name: pn }), place, t);
          push(fill(op.outro, { digit: t, place_name: pn }), 0, null);
        }
        return;
      }

      // ten complement: carry one to the left, subtract 10-d here
      const comp = 10 - d;
      const op = T.operations.ten_complement_addition;
      const nextPn = placeName(T, place + 1);
      if (digitAt(place + 1) === 9 && place + 1 <= self.rods) {
        push(fill(T.special_cases.carry_cascade, { next_place_name: nextPn }), 0, null);
      }
      methodIntro('ten_complement_addition', op.intro, { number: d, place_name: pn });
      push(fill(op.steps.carry, { next_place_name: nextPn }), 0, null);
      addAt(place + 1, 1);
      push(fill(op.steps.subtract_complement, { complement_10: comp, place_name: pn }), place, t - 10);
      push(fill(op.outro, { digit: t - 10, place_name: pn, next_place_name: nextPn }), 0, null);
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
          push(fill(op.steps.subtract, { number: d, place_name: pn }), place, t);
          push(fill(op.outro, { digit: t, place_name: pn }), 0, null);
        } else {
          // five complement: remove 5, add back 5-d
          const comp = 5 - d;
          const op = T.operations.five_complement_subtraction;
          methodIntro('five_complement_subtraction', op.intro, { number: d, place_name: pn });
          push(fill(op.steps.subtract_five, { place_name: pn }), place, c - 5);
          push(fill(op.steps.add_complement, { complement_5: comp, place_name: pn }), place, t);
          push(fill(op.outro, { digit: t, place_name: pn }), 0, null);
        }
        return;
      }

      // ten complement: borrow one from the left, add 10-d here
      const comp = 10 - d;
      const op = T.operations.ten_complement_subtraction;
      const nextPn = placeName(T, place + 1);
      if (place + 1 > self.rods || digitAt(place + 1) === 0) {
        if (place + 1 <= self.rods) {
          push(fill(T.special_cases.borrow_cascade, { next_place_name: nextPn }), 0, null);
        }
      }
      methodIntro('ten_complement_subtraction', op.intro, { number: d, place_name: pn });
      push(fill(op.steps.borrow, { next_place_name: nextPn }), 0, null);
      subAt(place + 1, 1);
      push(fill(op.steps.add_complement, { complement_10: comp, place_name: pn }), place, t + 10);
      push(fill(op.outro, { digit: t + 10, place_name: pn, next_place_name: nextPn }), 0, null);
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
      return early(fill(T.special_cases.overflow, { total_rods: this.rods }));
    }
    const steps = [];
    const core = this._core(steps);
    steps.push({ say: T.session.clearing, place: 0, digit: null, clear: true });
    steps.push({ say: T.session.cleared, place: 0, digit: null });
    core.setNumber(from, {
      first_number: from,
      second_number: to,
      operator_word: from <= to ? 'plus' : 'minus',
    });
    const inc = from <= to ? 1 : -1;
    for (let v = from + inc; ; v += inc) {
      const before = steps.length;
      if (inc > 0) core.addAt(1, 1);
      else core.subAt(1, 1);
      // counting says one sentence per number: drop the method narration and
      // label the bead moves with the running value instead
      const valueLine = fill(T.session.current_value, { current_value: v });
      let said = false;
      for (let k = before; k < steps.length; k++) {
        if (steps[k].place >= 1) {
          steps[k].say = said ? '' : valueLine;
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
        const newSteps = [{
          say: fill(carryTpl, { next_place_name: placeName(T, carryPlace) }),
          place: 0,
          digit: null,
        }];
        const resetPlaces = kept
          .slice(before)
          .filter((st) => st.place >= 1 && st.place < carryPlace)
          .map((st) => st.place)
          .sort((x, y) => x - y);
        resetPlaces.forEach((p) => {
          newSteps.push({
            say: fill(resetTpl, { complement_10: 9, place_name: placeName(T, p) }),
            place: 0,
            digit: null,
          });
        });
        steps.splice.apply(steps, [before, 0].concat(newSteps));
      }
      // cue the action before the beads move: "Now add 1." / "Now subtract 1."
      steps.splice(before, 0, {
        say: inc > 0 ? (T.session.count_add || 'Now add 1.') : (T.session.count_subtract || 'Now subtract 1.'),
        place: 0,
        digit: null,
      });
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
      operator_word: operator === '+' ? 'plus' : 'minus',
    };
    const result = operator === '+' ? a + b : a - b;
    const steps = [];
    steps.push({ say: T.session.clearing, place: 0, digit: null, clear: true });
    const state = new Array(this.rods).fill(0);
    const s = String(a);
    steps.push({ say: fill(T.session.set_number, vars), place: 0, digit: null });
    for (let i = 0; i < s.length; i++) {
      const place = s.length - i;
      const d = Number(s[i]);
      if (d === 0) continue;
      state[place - 1] = d;
      steps.push({
        say: fill(T.session.set_digit, { digit: d, place_name: placeName(T, place) }),
        place,
        digit: d,
      });
    }
    steps.push({ say: fill(T.session.problem_intro, vars), place: 0, digit: null });
    // cue for the biggest digit of b that changes beads
    const bs = String(b);
    let cue = null;
    for (let i = bs.length; i >= 1; i--) {
      if (Number(bs[i - 1]) !== 0) {
        cue = fill(T.feedback.your_turn, {
          number: Number(bs[i - 1]),
          place_name: placeName(T, bs.length - i + 1),
        });
        break;
      }
    }
    if (cue) steps.push({ say: cue, place: 0, digit: null });
    return { steps, result };
  };

  const api = { Solver, fill, placeName, pick };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Solver = api;
})(typeof window !== 'undefined' ? window : globalThis);
