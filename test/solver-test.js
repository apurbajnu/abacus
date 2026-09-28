// Run: node test/solver-test.js  (from the project root)
const { Solver } = require('../solver.js');
const T = require('../tts.json');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('ok  -', name);
  else {
    failures++;
    console.log('FAIL -', name, detail || '');
  }
}

function replay(steps) {
  // simulate the abacus by applying each step's rod target
  const rods = new Array(7).fill(0);
  for (const st of steps) {
    if (st.clear) rods.fill(0);
    else if (st.place >= 1) rods[st.place - 1] = st.digit;
  }
  return rods.reduce((v, d, i) => v + d * Math.pow(10, i), 0);
}

const solver = new Solver(T);

const cases = [
  ['direct add', 123, '+', 56],
  ['direct sub', 879, '-', 258],
  ['five comp add', 3, '+', 3],
  ['five comp add2', 43, '+', 22],
  ['five comp sub', 5, '-', 2],
  ['five comp sub2', 66, '-', 33],
  ['ten comp add', 8, '+', 7],
  ['ten comp add carry', 95, '+', 87], // carry cascade: 9+1 on tens
  ['ten comp sub', 12, '-', 4],
  ['ten comp sub borrow cascade', 1001, '-', 3],
  ['big', 48372, '+', 9481],
  ['big sub', 50000, '-', 24507],
  ['zeros in operand', 101, '+', 202],
  ['to zero', 77, '-', 77],
];

for (const [name, a, op, b] of cases) {
  const { steps, result } = solver.solve(a, op, b);
  const shown = replay(steps);
  check(`${name}: ${a} ${op} ${b} = ${result}, beads replay to ${shown}`, shown === result && result === (op === '+' ? a + b : a - b));
  const unfilled = steps.filter((s) => /\{\w+\}/.test(s.say));
  check(`${name}: no unfilled placeholders`, unfilled.length === 0, JSON.stringify(unfilled.map((s) => s.say)));
}

const ov = solver.solve(9999999, '+', 1);
check('overflow detected', ov.steps.length === 1 && /rods/.test(ov.steps[0].say));
const neg = solver.solve(5, '-', 10);
check('negative detected', neg.steps.length === 1 && /below zero/.test(neg.steps[0].say));

const p = solver.practiceSetup(34, '+', 8);
check('practice setup replays to first number', replay(p.steps) === 34);
check('practice result', p.result === 42);

// method intros are said once per method run, not per digit
function introCount(steps, phrase) {
  return steps.filter((st) => st.say.includes(phrase)).length;
}
const allDirect = solver.solve(123, '+', 321);
check('all-direct addition: one intro', introCount(allDirect.steps, 'This is direct addition') === 1);
const mixed = solver.solve(48, '+', 76);
// 48+76: tens ten-complement (carry = direct intro on hundreds), then units ten-complement.
// The direct carry between them is a method change, so the ten-complement intro re-fires: 2 total.
check('ten-complement with direct interlude: intro re-fires on switch', introCount(mixed.steps, 'This needs the ten complement') === 2);
const mixed2 = solver.solve(43, '+', 22);
// 43+22: units 3+2 five-comp, tens 4+2 five-comp
check('five-complement repeated: one intro', introCount(mixed2.steps, 'This needs the five complement') === 1);
const switchy = solver.solve(28, '+', 44);
// 28+44: units 8+4 -> 12 ten-complement; tens 2+4+1: 2+5? 2+4 direct, then +1 carry direct
const tc = introCount(switchy.steps, 'This needs the ten complement');
const da = introCount(switchy.steps, 'This is direct addition');
check('method switch: ten-comp once', tc === 1, `got ${tc}`);
check('method switch: direct still introduced', da >= 1, `got ${da}`);
const sub = solver.solve(66, '-', 33);
check('five-complement subtraction: one intro', introCount(sub.steps, 'This needs the five complement') === 1);

// counting narrates carry/borrow once at rod transitions
const cUp = solver.countSteps(7, 12);
check('count 7-12: one carry line', introCount(cUp.steps, 'carry one') === 1);
check('count 7-12: replay', replay(cUp.steps) === 12);
const cDown = solver.countSteps(12, 7);
check('count 12-7: one borrow line', introCount(cDown.steps, 'borrow one') === 1);
check('count 12-7: replay', replay(cDown.steps) === 7);
const cNone = solver.countSteps(1, 5);
check('count 1-5: no carry/borrow', introCount(cNone.steps, 'carry one') === 0 && introCount(cNone.steps, 'borrow one') === 0);
check('count 1-5: no reset lines', introCount(cNone.steps, 'subtract 9 on the units rod') === 0);
check('count 8-12: units reset mentioned', introCount(solver.countSteps(8, 12).steps, 'subtract 9 on the units rod') === 1);
const cDown2 = solver.countSteps(11, 8);
check('count 11-8: units reset mentioned', introCount(cDown2.steps, 'add 9 on the units rod') === 1);
const cCascade = solver.countSteps(98, 102);
check('count 98-102: two reset lines', introCount(cCascade.steps, 'subtract 9 on the') === 2);
check('count 98-102: replay', replay(cCascade.steps) === 102);
// carry line comes before the reset line, reset before the first bead move
const cSeq = solver.countSteps(8, 12).steps;
const iCarry = cSeq.findIndex((st) => /carry one/.test(st.say));
const iReset = cSeq.findIndex((st) => /subtract 9/.test(st.say));
const iBead = cSeq.findIndex((st) => st.place >= 1 && /shows 10/.test(st.say));
check('count 8-12: carry -> reset -> beads order', iCarry !== -1 && iCarry < iReset && iReset < iBead);

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall tests passed');
