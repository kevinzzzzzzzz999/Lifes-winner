/* Offline educational numerical engine. Double precision; no symbolic algebra,
 * market data, eval, generated functions, network requests, or external packages.
 * LS definitions: https://www.itl.nist.gov/div898/handbook/pmd/section4/pmd431.htm
 * HC1: https://www.statsmodels.org/stable/generated/statsmodels.regression.linear_model.OLSResults.HC1_se.html
 * QR is column-pivoted Householder, never the normal-equations coefficient solve.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MathLabEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
  const finite = (v, name = 'value') => {
    if (typeof v !== 'number' || !Number.isFinite(v)) fail('INPUT', name + ' must be a finite number.');
    return v;
  };
  const integer = (v, min, max, name) => {
    finite(v, name); if (!Number.isInteger(v) || v < min || v > max) fail('INPUT', name + ' must be an integer from ' + min + ' to ' + max + '.'); return v;
  };
  const positive = (v, name) => { finite(v, name); if (v <= 0) fail('INPUT', name + ' must be positive.'); return v; };
  const checked = (v, message = 'Numerical overflow or undefined result.') => { if (!Number.isFinite(v)) fail('NUMERICAL', message); return v; };
  const vector = (a, name = 'values', min = 1, max = 100000) => {
    if (!Array.isArray(a) || a.length < min || a.length > max) fail('INPUT', name + ' must contain ' + min + '..' + max + ' finite numbers.');
    a.forEach((v, i) => finite(v, name + '[' + i + ']')); return a;
  };
  const sum = a => { let s = 0, c = 0; for (const v of a) { const t = s + v; c += Math.abs(s) >= Math.abs(v) ? (s - t) + v : (v - t) + s; s = t; } return checked(s + c); };
  const average = a => sum(a.map(v => v / a.length));
  const dot = (a, b) => sum(a.map((v, i) => v * b[i]));
  const zero = (r, c) => Array.from({ length: r }, () => Array(c).fill(0));
  const multiply = (A, B) => A.map(row => B[0].map((_, j) => sum(row.map((v, k) => v * B[k][j]))));
  const transpose = A => A[0].map((_, j) => A.map(row => row[j]));
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const functions = Object.freeze({
    dsin: [x => Math.sin(x * Math.PI / 180), 1], dcos: [x => Math.cos(x * Math.PI / 180), 1], dtan: [x => Math.tan(x * Math.PI / 180), 1], dasin: [x => Math.asin(x) * 180 / Math.PI, 1], dacos: [x => Math.acos(x) * 180 / Math.PI, 1], datan: [x => Math.atan(x) * 180 / Math.PI, 1],
    sin: [Math.sin, 1], cos: [Math.cos, 1], tan: [Math.tan, 1], asin: [Math.asin, 1], acos: [Math.acos, 1], atan: [Math.atan, 1],
    sqrt: [Math.sqrt, 1], exp: [Math.exp, 1], log: [Math.log, 1], ln: [Math.log, 1], log10: [Math.log10, 1], abs: [Math.abs, 1],
    min: [Math.min, -1], max: [Math.max, -1], pow: [Math.pow, 2]
  });
  function compile(expression, variables = ['x']) {
    if (typeof expression !== 'string' || !expression.trim() || expression.length > 2048) fail('EXPRESSION', 'Expression must contain 1..2048 characters.');
    if (!Array.isArray(variables) || variables.length > 8 || new Set(variables).size !== variables.length || variables.some(v => typeof v !== 'string' || !/^[a-z][a-z0-9_]*$/.test(v) || own(functions, v) || ['pi', 'e', '__proto__', 'constructor', 'prototype'].includes(v))) fail('INPUT', 'Invalid or duplicate variable name.');
    const source = expression.trim().replace(/^y\s*=\s*/i, '');
    const tokens = []; let p = 0;
    while (p < source.length) {
      if (/\s/.test(source[p])) { p++; continue; }
      const rest = source.slice(p), number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
      if (number) { const v = Number(number[0]); if (!Number.isFinite(v)) fail('EXPRESSION', 'Number is too large.'); tokens.push({ t: 'number', v }); p += number[0].length; }
      else { const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
        if (id) { tokens.push({ t: 'id', v: id[0].toLowerCase() }); p += id[0].length; }
        else if ('+-*/^(),'.includes(source[p])) tokens.push({ t: source[p++] });
        else fail('EXPRESSION', 'Unsupported character at position ' + (p + 1) + '.');
      }
      if (tokens.length > 512) fail('LIMIT', 'Expression is too complex.');
    }
    tokens.push({ t: 'end' }); let i = 0, depth = 0;
    const peek = () => tokens[i].t;
    const take = t => { if (peek() !== t) fail('EXPRESSION', 'Expected ' + t + '. Use explicit multiplication, for example 2*x.'); return tokens[i++]; };
    const nested = fn => { if (++depth > 64) fail('LIMIT', 'Expression nesting exceeds 64 levels.'); const r = fn(); depth--; return r; };
    function expressionNode() { let a = product(); while (peek() === '+' || peek() === '-') { const op = tokens[i++].t; a = { op, a, b: product() }; } return a; }
    function product() { let a = unary(); while (peek() === '*' || peek() === '/') { const op = tokens[i++].t; a = { op, a, b: unary() }; } return a; }
    function unary() { if (peek() === '+' || peek() === '-') { const op = tokens[i++].t; return { op: op === '+' ? 'pos' : 'neg', a: nested(unary) }; } return power(); }
    function power() { const a = atom(); if (peek() === '^') { i++; return { op: '^', a, b: nested(unary) }; } return a; }
    function atom() {
      if (peek() === 'number') return { op: 'literal', value: tokens[i++].v };
      if (peek() === '(') { i++; const a = nested(expressionNode); take(')'); return a; }
      if (peek() !== 'id') fail('EXPRESSION', 'Expected a number, variable or function.');
      const name = tokens[i++].v;
      if (peek() === '(') {
        if (!own(functions, name)) fail('EXPRESSION', 'Unknown function: ' + name);
        i++; const args = [];
        if (peek() !== ')') { args.push(nested(expressionNode)); while (peek() === ',') { i++; args.push(nested(expressionNode)); } }
        take(')'); const argc = functions[name][1];
        if ((argc > 0 && args.length !== argc) || (argc === -1 && (args.length < 1 || args.length > 32))) fail('EXPRESSION', 'Wrong number of arguments for ' + name + '.');
        return { op: 'call', name, args };
      }
      if (name === 'pi' || name === 'e') return { op: 'literal', value: name === 'pi' ? Math.PI : Math.E };
      if (!variables.includes(name)) fail('EXPRESSION', 'Unknown variable: ' + name);
      return { op: 'variable', name };
    }
    const ast = expressionNode(); take('end');
    function evaluate(n, scope) {
      switch (n.op) {
        case 'literal': return n.value; case 'variable': return scope[n.name];
        case 'pos': return evaluate(n.a, scope); case 'neg': return -evaluate(n.a, scope);
        case '+': return evaluate(n.a, scope) + evaluate(n.b, scope); case '-': return evaluate(n.a, scope) - evaluate(n.b, scope);
        case '*': return evaluate(n.a, scope) * evaluate(n.b, scope); case '/': return evaluate(n.a, scope) / evaluate(n.b, scope);
        case '^': return Math.pow(evaluate(n.a, scope), evaluate(n.b, scope));
        case 'call': return functions[n.name][0](...n.args.map(a => evaluate(a, scope)));
      }
    }
    return function (scope = {}) { for (const v of variables) { if (!own(scope, v)) fail('INPUT', 'Missing variable: ' + v); finite(scope[v], v); } return evaluate(ast, scope); };
  }
  function sample(expression, { min = -10, max = 10, count = 401 } = {}) {
    finite(min, 'min'); finite(max, 'max'); integer(count, 3, 10000, 'count'); if (max <= min || !Number.isFinite(max - min)) fail('INPUT', 'max must exceed min by a finite interval.');
    const fn = compile(expression), points = [], segments = []; let current = [], gap = false;
    for (let i = 0; i < count; i++) {
      const x = min + (max - min) * (i / (count - 1)), raw = fn({ x }), point = { x, y: Number.isFinite(raw) ? raw : null };
      points.push(point);
      if (point.y === null) { if (current.length) segments.push(current); current = []; gap = true; continue; }
      if (current.length) {
        const prev = current[current.length - 1], mid = fn({ x: (prev.x + x) / 2 });
        // Deliberately conservative: break a suspected pole rather than connect it.
        const margin = Math.max(1, Math.abs(raw), Math.abs(prev.y)) * 1e-12;
        const pole = !Number.isFinite(mid) || (Math.sign(prev.y) !== Math.sign(raw) && (mid < Math.min(raw, prev.y) - margin || mid > Math.max(raw, prev.y) + margin));
        if (pole) { segments.push(current); current = []; gap = true; }
      }
      current.push(point);
    }
    if (current.length) segments.push(current);
    return { points, segments, warnings: gap ? ['Undefined values or suspected discontinuities were omitted. Sampling does not prove continuity.'] : [] };
  }
  function derivative(expression, x, { order = 1, step } = {}) {
    finite(x, 'x'); integer(order, 1, 2, 'order');
    const fn = compile(expression), f = t => checked(fn({ x: t }), 'Derivative crosses an undefined point.');
    let h = step === undefined ? (order === 1 ? 1e-3 : 1e-2) * Math.max(1, Math.abs(x)) : positive(step, 'step');
    const center = f(x); let best = null, lastError = Infinity;
    for (let k = 0; k < 12; k++) {
      if (x + h === x || x - h === x) break;
      const estimate = s => order === 1 ? (f(x + s) - f(x - s)) / (2 * s) : (f(x + s) - 2 * center + f(x - s)) / (s * s);
      const coarse = estimate(h), fine = estimate(h / 2), value = checked((4 * fine - coarse) / 3), errorEstimate = Math.abs(value - fine);
      // Left/right slopes reject corners that symmetric differencing would hide.
      const left = (center - f(x - h / 2)) / (h / 2), right = (f(x + h / 2) - center) / (h / 2);
      const corner = Math.abs(left - right) > Math.max(1, Math.abs(value)) * Math.sqrt(h / Math.max(1, Math.abs(x))) * 20;
      if (!corner && (!best || errorEstimate < best.errorEstimate)) best = { value, errorEstimate, step: h / 2, converged: true };
      if (best && errorEstimate < (order === 1 ? 1e-8 : 2e-6) * Math.max(1, Math.abs(value))) return best;
      if (errorEstimate > lastError * 4 && k > 3) break;
      lastError = errorEstimate; h /= 2;
    }
    if (best && best.errorEstimate < (order === 1 ? 1e-5 : 1e-3) * Math.max(1, Math.abs(best.value))) return best;
    fail('CONVERGENCE', 'Derivative did not converge; the point may be nonsmooth or ill-conditioned.');
  }
  function integrate(expression, min, max, { tolerance = 1e-8, maxDepth = 20, maxEvaluations = 50000 } = {}) {
    finite(min, 'min'); finite(max, 'max'); positive(tolerance, 'tolerance'); if (tolerance < 1e-12 || tolerance > 0.1) fail('INPUT', 'tolerance must be between 1e-12 and 0.1.');
    integer(maxDepth, 4, 24, 'maxDepth'); integer(maxEvaluations, 100, 100000, 'maxEvaluations');
    const fn = compile(expression); let evaluations = 0;
    if (min === max) return { value: 0, errorEstimate: 0, evaluations: 0, converged: true };
    const sign = max < min ? -1 : 1, a = Math.min(min, max), b = Math.max(min, max);
    if (!Number.isFinite(b - a)) fail('INPUT', 'Integration interval is too large.');
    const f = x => { if (++evaluations > maxEvaluations) fail('CONVERGENCE', 'Integration evaluation budget exceeded.'); return checked(fn({ x }), 'The interval contains an undefined value; improper integrals are not supported.'); };
    const simpson = (l, r, fl, fm, fr) => checked((r - l) / 6 * (fl + 4 * fm + fr));
    function recurse(l, r, fl, fm, fr, whole, tol, depth) {
      const m = (l + r) / 2, lm = (l + m) / 2, rm = (m + r) / 2;
      if (lm === l || rm === r) fail('CONVERGENCE', 'Integration reached floating-point resolution.');
      const f1 = f(lm), f2 = f(rm), left = simpson(l, m, fl, f1, fm), right = simpson(m, r, fm, f2, fr), delta = left + right - whole;
      if (Math.abs(delta) <= 15 * tol) return { value: left + right + delta / 15, error: Math.abs(delta) / 15 };
      if (depth === 0) fail('CONVERGENCE', 'Integration did not converge; check for a singularity or rapid oscillation.');
      const x = recurse(l, m, fl, f1, fm, left, tol / 2, depth - 1), y = recurse(m, r, fm, f2, fr, right, tol / 2, depth - 1);
      return { value: x.value + y.value, error: x.error + y.error };
    }
    // Initial panels avoid the worst endpoint/midpoint aliasing of a single panel.
    let value = 0, errorEstimate = 0;
    for (let j = 0; j < 16; j++) {
      const l = a + (b - a) * j / 16, r = a + (b - a) * (j + 1) / 16, m = (l + r) / 2, fl = f(l), fm = f(m), fr = f(r);
      const part = recurse(l, r, fl, fm, fr, simpson(l, r, fl, fm, fr), tolerance / 16, maxDepth);
      value += part.value; errorEstimate += part.error;
    }
    return { value: checked(sign * value), errorEstimate, evaluations, converged: true };
  }
  function gradientHessian(expression, { x, y }) {
    finite(x, 'x'); finite(y, 'y'); const fn = compile(expression, ['x', 'y']);
    const f = (a, b) => checked(fn({ x: a, y: b }), 'The local derivative stencil crosses an undefined point.');
    const hx = 0.004 * Math.max(1, Math.abs(x)), hy = 0.004 * Math.max(1, Math.abs(y)), value = f(x, y);
    function stencil(scale) {
      const h = hx * scale, k = hy * scale;
      if (x + h === x || y + k === y) fail('CONVERGENCE', 'Derivative steps are below floating-point resolution.');
      const xp=f(x+h,y), xm=f(x-h,y), yp=f(x,y+k), ym=f(x,y-k);
      const pp=f(x+h,y+k), pm=f(x+h,y-k), mp=f(x-h,y+k), mm=f(x-h,y-k);
      const values=[(xp-xm)/(2*h),(yp-ym)/(2*k),(xp-2*value+xm)/(h*h),(yp-2*value+ym)/(k*k),(pp-pm-mp+mm)/(4*h*k)];
      values.forEach(v=>checked(v));
      const amplitude=Math.max(Math.abs(value),Math.abs(xp),Math.abs(xm),Math.abs(yp),Math.abs(ym),Math.abs(pp),Math.abs(pm),Math.abs(mp),Math.abs(mm));
      const noise=Number.EPSILON*amplitude*16;
      const roundoff=[noise/h,noise/k,noise/(h*h),noise/(k*k),noise/(h*k)];
      return {values,roundoff,jump:[Math.abs(xp-2*value+xm)/h,Math.abs(yp-2*value+ym)/k],diagonal:(pp-2*value+mm)/(h*h+k*k),antiDiagonal:(pm-2*value+mp)/(h*h+k*k),h,k};
    }
    const coarse=stencil(1), fine=stencil(0.5), finer=stencil(0.25);
    for(let axis=0;axis<2;axis++) {
      const threshold=1e-5*Math.max(1,Math.abs(finer.values[axis]))+finer.roundoff[axis];
      if(finer.jump[axis]>threshold && finer.jump[axis]>fine.jump[axis]*0.8) fail('CONVERGENCE','Gradient/Hessian is undefined at a corner or did not converge.');
    }
    const result=finer.values.map((v,i)=>{
      const rich=(4*v-fine.values[i])/3, previous=(4*fine.values[i]-coarse.values[i])/3;
      const error=Math.abs(rich-previous)+finer.roundoff[i];
      if(error>1e-3*Math.max(1,Math.abs(rich))) fail('CONVERGENCE','Gradient/Hessian did not converge at this point; try a smoother expression or rescale it.');
      return checked(rich);
    });
    // A mixed corner such as |x*y| is invisible along each axis: additionally
    // require second directional differences to agree with the Hessian form.
    const [dx,dy,xx,yy,xy]=result, {h,k}=finer;
    for(const sign of [1,-1]) {
      const predicted=(xx*h*h+2*sign*xy*h*k+yy*k*k)/(h*h+k*k);
      const observed=sign===1?finer.diagonal:finer.antiDiagonal;
      if(Math.abs(observed-predicted)>1e-3*Math.max(1,Math.abs(observed),Math.abs(predicted))) fail('CONVERGENCE','The local function has no consistent smooth Hessian.');
    }
    return { value, gradient: { x: dx, y: dy }, hessian: [[xx, xy], [xy, yy]], steps: { x: h, y: k }, method: 'central finite differences' };
  }
  function parseCSV(text, { header = true } = {}) {
    if (typeof text !== 'string' || text.length > 2097152) fail('LIMIT', 'CSV must be text no longer than 2097152 characters.');
    if (typeof header !== 'boolean') fail('INPUT', 'header must be boolean.');
    text = text.replace(/^\uFEFF/, ''); const data = []; let row = [], cell = '', state = 'start', rowHasContent = false;
    const finishCell = () => { row.push(cell); cell = ''; state = 'start'; if (row.length > 64) fail('LIMIT', 'CSV exceeds 64 columns.'); };
    const finishRow = () => { finishCell(); if (rowHasContent || !(row.length === 1 && row[0] === '')) data.push(row); row = []; rowHasContent = false; if (data.length > 10000 + (header ? 1 : 0)) fail('LIMIT', 'CSV exceeds 10000 data rows.'); };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c !== '\r' && c !== '\n') rowHasContent = true;
      if (state === 'quoted') { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else state = 'closed'; } else cell += c; continue; }
      if (c === ',') { finishCell(); continue; }
      if (c === '\r' || c === '\n') { finishRow(); if (c === '\r' && text[i + 1] === '\n') i++; continue; }
      if (state === 'closed') fail('CSV', 'Unexpected characters after a closing quote.');
      if (c === '"') { if (state !== 'start') fail('CSV', 'Quotes must start at the beginning of a field.'); state = 'quoted'; }
      else { cell += c; state = 'plain'; }
    }
    if (state === 'quoted') fail('CSV', 'CSV contains an unterminated quoted field.');
    if (row.length || cell || state !== 'start') finishRow();
    if (!data.length) fail('CSV', 'CSV is empty.');
    const headers = header ? data.shift().map((s, i) => s.trim() || 'Column ' + (i + 1)) : data[0].map((_, i) => 'Column ' + (i + 1));
    const rows = data.map(r => { if (r.length > headers.length) fail('CSV', 'A row has more fields than the header.'); return r.concat(Array(headers.length - r.length).fill('')); });
    const numericColumns = headers.map((name, index) => {
      let missing = 0, invalid = 0, count = 0;
      const values = rows.map(r => { const s = r[index].trim(); if (!s) { missing++; return null; } if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s) || !Number.isFinite(Number(s))) { invalid++; return null; } count++; return Number(s); });
      return { index, name, values, count, missing, invalid, isNumeric: count > 0 && invalid === 0 };
    });
    return { headers, rows, numericColumns };
  }
  function describe(values) {
    vector(values); const n = values.length, sorted = values.slice().sort((a, b) => a - b), mean = average(values);
    const ss = sum(values.map(v => (v - mean) * (v - mean))), variance = ss / n, sampleVariance = n > 1 ? ss / (n - 1) : null;
    const quantile = p => { const i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return checked(sorted[lo] * (1 - (i - lo)) + sorted[hi] * (i - lo)); };
    return { count: n, mean, median: quantile(0.5), min: sorted[0], max: sorted[n - 1], variance, sampleVariance, stdDev: Math.sqrt(variance), sampleStdDev: n > 1 ? Math.sqrt(sampleVariance) : null, q1: quantile(0.25), q3: quantile(0.75), sum: sum(values) };
  }
  // Lanczos log-gamma and continued-fraction incomplete beta for Student t CIs.
  function logGamma(z) {
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
    z--; let x = c[0]; for (let i = 1; i < c.length; i++) x += c[i] / (z + i); const t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }
  function betaCF(a, b, x) {
    const tiny = 1e-300; let c = 1, d = 1 - (a + b) * x / (a + 1); if (Math.abs(d) < tiny) d = tiny; d = 1 / d; let h = d;
    for (let m = 1; m <= 250; m++) {
      const m2 = 2 * m; let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny; c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny; d = 1 / d; h *= d * c;
      aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
      d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny; c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny; d = 1 / d; const delta = d * c; h *= delta;
      if (Math.abs(delta - 1) < 3e-14) return h;
    }
    fail('CONVERGENCE', 'Student t interval calculation did not converge.');
  }
  function betaI(x, a, b) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
    return x < (a + 1) / (a + b + 2) ? bt * betaCF(a, b, x) / a : 1 - bt * betaCF(b, a, 1 - x) / b;
  }
  function tCritical(df) { let lo = 0, hi = 100; for (let i = 0; i < 65; i++) { const mid = (lo + hi) / 2, tail = 0.5 * betaI(df / (df + mid * mid), df / 2, 0.5); if (tail > 0.025) lo = mid; else hi = mid; } return (lo + hi) / 2; }
  function ols(y, X, { intercept = true, robust = false } = {}) {
    vector(y, 'y', 2, 10000); const n = y.length;
    if (typeof intercept !== 'boolean' || typeof robust !== 'boolean') fail('INPUT', 'intercept and robust must be booleans.');
    if (!Array.isArray(X) || X.length !== n || !Array.isArray(X[0])) fail('INPUT', 'X must have one array row per response.');
    const p = X[0].length, k = p + (intercept ? 1 : 0);
    if (p > 20 || k === 0 || n <= k) fail('INPUT', 'OLS requires at most 20 predictors and more observations than coefficients.');
    X.forEach((r, i) => { if (!Array.isArray(r) || r.length !== p) fail('INPUT', 'X rows must have equal lengths.'); r.forEach((v, j) => finite(v, 'X[' + i + '][' + j + ']')); });
    const means = Array.from({ length: p }, (_, j) => intercept ? average(X.map(r => r[j])) : 0);
    const scales = Array.from({ length: p }, (_, j) => {
      let h = 0; for (const row of X) h = Math.hypot(h, row[j] - means[j]); h /= Math.sqrt(n);
      if (!Number.isFinite(h) || h === 0) fail('RANK', 'A predictor is constant or numerically unresolvable.'); return h;
    });
    const Z = X.map(row => (intercept ? [1] : []).concat(row.map((v, j) => (v - means[j]) / scales[j])));
    const A = Z.map(r => r.slice()), b = y.slice(), perm = Array.from({ length: k }, (_, i) => i), diag = [];
    for (let j = 0; j < k; j++) {
      let pivot = j, largest = -1;
      for (let c = j; c < k; c++) { let norm = 0; for (let r = j; r < n; r++) norm = Math.hypot(norm, A[r][c]); if (norm > largest) { largest = norm; pivot = c; } }
      if (largest <= Math.sqrt(n) * 1e-10) fail('RANK', 'Predictors are linearly dependent or too ill-conditioned for reliable estimates.');
      if (pivot !== j) { for (let r = 0; r < n; r++) [A[r][j], A[r][pivot]] = [A[r][pivot], A[r][j]]; [perm[j], perm[pivot]] = [perm[pivot], perm[j]]; }
      const alpha = A[j][j] >= 0 ? -largest : largest, v = Array.from({ length: n - j }, (_, i) => A[i + j][j]); v[0] -= alpha;
      let norm = 0; for (const q of v) norm = Math.hypot(norm, q); for (let i = 0; i < v.length; i++) v[i] /= norm;
      for (let c = j; c < k; c++) { let s = 0; for (let r = j; r < n; r++) s += v[r - j] * A[r][c]; for (let r = j; r < n; r++) A[r][c] -= 2 * v[r - j] * s; }
      let s = 0; for (let r = j; r < n; r++) s += v[r - j] * b[r]; for (let r = j; r < n; r++) b[r] -= 2 * v[r - j] * s;
      A[j][j] = alpha; diag.push(Math.abs(alpha));
    }
    const conditionEstimate = Math.max(...diag) / Math.min(...diag), bp = Array(k).fill(0);
    for (let i = k - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < k; j++) s -= A[i][j] * bp[j]; bp[i] = checked(s / A[i][i]); }
    const beta = Array(k).fill(0); perm.forEach((original, j) => { beta[original] = bp[j]; });
    const fitted = Z.map(r => dot(r, beta)), residuals = y.map((v, i) => checked(v - fitted[i])), sse = sum(residuals.map(v => v * v)), dfResidual = n - k, sigma2 = sse / dfResidual;
    const Rinv = zero(k, k);
    for (let c = 0; c < k; c++) for (let i = k - 1; i >= 0; i--) { let s = i === c ? 1 : 0; for (let j = i + 1; j < k; j++) s -= A[i][j] * Rinv[j][c]; Rinv[i][c] = s / A[i][i]; }
    const permCov = multiply(Rinv, transpose(Rinv)), G = zero(k, k); for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) G[perm[i]][perm[j]] = permCov[i][j];
    let cov;
    if (robust) {
      const meat = zero(k, k); for (let r = 0; r < n; r++) { const w = residuals[r] * residuals[r]; for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) meat[i][j] += w * Z[r][i] * Z[r][j]; }
      cov = multiply(multiply(G, meat), G).map(row => row.map(v => v * n / dfResidual));
    } else cov = G.map(row => row.map(v => v * sigma2));
    const B = zero(k, k); if (intercept) B[0][0] = 1;
    for (let j = 0; j < p; j++) { const q = j + (intercept ? 1 : 0); B[q][q] = 1 / scales[j]; if (intercept) B[0][q] = -means[j] / scales[j]; }
    const coefficients = B.map(r => dot(r, beta)), covariance = multiply(multiply(B, cov), transpose(B));
    const standardErrors = covariance.map((r, i) => Math.sqrt(Math.max(0, checked(r[i]))));
    const tStatistics = coefficients.map((v, i) => standardErrors[i] > 0 ? checked(v / standardErrors[i]) : null), crit = tCritical(dfResidual);
    const confidenceIntervals95 = coefficients.map((v, i) => [checked(v - crit * standardErrors[i]), checked(v + crit * standardErrors[i])]);
    const mean = average(y), centered = sum(y.map(v => (v - mean) ** 2)), denominator = intercept ? centered : sum(y.map(v => v * v));
    const rSquared = centered === 0 || denominator === 0 ? null : 1 - sse / denominator;
    const adjustedRSquared = rSquared === null ? null : 1 - (1 - rSquared) * (n - (intercept ? 1 : 0)) / dfResidual;
    const warnings = []; if (!intercept) warnings.push('Without an intercept, R-squared uses the uncentered total sum of squares.');
    if (robust) warnings.push('HC1 intervals use a Student t reference and are approximate in small samples.');
    if (conditionEstimate > 1e6) warnings.push('The standardized design is poorly conditioned; coefficient precision may be reduced.');
    return { coefficients, standardErrors, tStatistics, confidenceIntervals95, residuals, fitted, rSquared, adjustedRSquared, sigma2, dfResidual, n, rank: k, conditionEstimate, covariance, intercept, robust, warnings };
  }
  function timeSeries(values, { lag = 10, window = 5 } = {}) {
    vector(values, 'values', 3, 10000); integer(lag, 0, 2000, 'lag'); integer(window, 1, values.length, 'window');
    const n = values.length, mean = average(values), centered = values.map(v => v - mean), denom = sum(centered.map(v => v * v)), acf = [];
    for (let l = 0; l <= Math.min(lag, n - 1); l++) { let s = 0; for (let i = l; i < n; i++) s += centered[i] * centered[i - l]; acf.push(denom > 0 ? checked(s / denom) : null); }
    const differences = values.slice(1).map((v, i) => checked(v - values[i])), rollingMean = values.map((_, i) => i + 1 < window ? null : average(values.slice(i + 1 - window, i + 1)));
    const warnings = []; let ar1 = null;
    if (n < 4) warnings.push('AR(1) needs at least four observations to estimate residual uncertainty.');
    else { try { const regression = ols(values.slice(1), values.slice(0, -1).map(v => [v])); const [intercept, phi] = regression.coefficients;
      ar1 = { intercept, phi, residualStdDev: Math.sqrt(regression.sigma2), forecast: checked(intercept + phi * values[n - 1]), regression };
      if (Math.abs(phi) >= 1) warnings.push('The fitted AR(1) is not stationary (|phi| >= 1); forecast interpretation is limited.');
    } catch (e) { if (e.code === 'RANK') warnings.push('AR(1) is undefined for a constant or unresolved lagged series.'); else throw e; } }
    if (denom === 0) warnings.push('Autocorrelation is undefined for a constant series.');
    return { differences, rollingMean, acf, ar1, warnings };
  }
  function npv(rate, cashflows) {
    finite(rate, 'rate'); if (rate <= -1) fail('INPUT', 'rate must exceed -1.'); vector(cashflows, 'cashflows', 1, 10000);
    const q = 1 / (1 + rate); let value = 0; for (let i = cashflows.length - 1; i >= 0; i--) value = checked(value * q + cashflows[i]); return value;
  }
  function irr(cashflows, { minRate = -0.9999, maxRate = 100 } = {}) {
    vector(cashflows, 'cashflows', 2, 101); finite(minRate, 'minRate'); finite(maxRate, 'maxRate');
    if (minRate <= -1 || maxRate <= minRate || maxRate > 1e6) fail('INPUT', 'IRR search requires -1 < minRate < maxRate <= 1000000.');
    const nonzero = cashflows.filter(v => v !== 0); if (!nonzero.length) fail('INPUT', 'IRR is indeterminate for all-zero cash flows.');
    let changes = 0; for (let i = 1; i < nonzero.length; i++) if (Math.sign(nonzero[i]) !== Math.sign(nonzero[i - 1])) changes++;
    const a = cashflows.slice(); while (a.length > 1 && a[0] === 0) a.shift(); while (a.length > 1 && a[a.length - 1] === 0) a.pop(); const norm = Math.max(...a.map(Math.abs)); for (let i = 0; i < a.length; i++) a[i] /= norm;
    const lo = 1 / (1 + maxRate), hi = 1 / (1 + minRate);
    // Isolate positive discount-factor roots between derivative critical points;
    // this also finds even-multiplicity (non-sign-changing) roots within precision.
    function value(poly, x) { let v = 0; if (x > 1) { for (let i = 0; i < poly.length; i++) v = v / x + poly[i]; } else { for (let i = poly.length - 1; i >= 0; i--) v = v * x + poly[i]; } return v; }
    function roots(poly) {
      if (poly.length <= 1) return [];
      if (poly.length === 2) { const r = -poly[0] / poly[1]; return r >= lo && r <= hi ? [r] : []; }
      const d = poly.slice(1).map((v, i) => v * (i + 1)), dn = Math.max(...d.map(Math.abs));
      const critical = roots(d.map(v => v / dn)), cuts = [lo, ...critical, hi], found = [], absolute = poly.map(Math.abs);
      const add = x => { if (!found.some(v => Math.abs(v - x) <= 1e-7 * Math.max(1e-6, Math.abs(x)))) found.push(x); };
      for (const x of cuts) if (Math.abs(value(poly, x)) <= 1e-11 * value(absolute, x)) add(x);
      for (let i = 1; i < cuts.length; i++) { let l = cuts[i - 1], r = cuts[i], fl = value(poly, l), fr = value(poly, r); if (fl === 0 || fr === 0 || Math.sign(fl) === Math.sign(fr)) continue;
        for (let j = 0; j < 100; j++) { const m = (l + r) / 2, fm = value(poly, m); if (fm === 0) { l = r = m; break; } if (Math.sign(fm) === Math.sign(fl)) { l = m; fl = fm; } else r = m; if (r - l < 1e-13 * Math.max(1e-6, m)) break; }
        add((l + r) / 2);
      }
      return found.sort((x, y) => x - y);
    }
    const result = changes ? roots(a).map(v => 1 / v - 1).sort((x, y) => x - y) : [], warnings = ['IRR is searched only within the selected rate range; numerical root isolation is not a proof of all real roots.'];
    if (changes > 1) warnings.push('Cash flows change sign more than once: multiple IRRs may exist; do not assume a unique return.');
    if (!result.length) warnings.push('No IRR was found in the selected rate range.');
    return { roots: result, unique: result.length === 1 && changes === 1, warnings };
  }
  function loanPayment(principal, annualRate, years, { paymentsPerYear = 12 } = {}) {
    positive(principal, 'principal'); finite(annualRate, 'annualRate'); if (annualRate < 0) fail('INPUT', 'annualRate must be nonnegative.'); positive(years, 'years'); integer(paymentsPerYear, 1, 366, 'paymentsPerYear');
    const periods = years * paymentsPerYear; integer(periods, 1, 100000, 'number of payments'); const periodRate = annualRate / paymentsPerYear;
    const payment = checked(periodRate === 0 ? principal / periods : principal * periodRate / -Math.expm1(-periods * Math.log1p(periodRate)));
    const totalPaid = checked(payment * periods); return { payment, totalPaid, totalInterest: totalPaid - principal, periods, periodRate };
  }
  function bondPV({ face = 1000, couponRate, yieldRate, years, frequency = 2 }) {
    positive(face, 'face'); finite(couponRate, 'couponRate'); finite(yieldRate, 'yieldRate'); positive(years, 'years'); integer(frequency, 1, 366, 'frequency');
    if (couponRate < 0 || yieldRate / frequency <= -1) fail('INPUT', 'Coupon rate must be nonnegative and periodic yield must exceed -1.');
    const n = years * frequency; integer(n, 1, 10000, 'coupon periods'); const r = yieldRate / frequency, c = face * couponRate / frequency;
    let price = 0, weighted = 0, convex = 0;
    for (let t = 1; t <= n; t++) { const pv = checked((c + (t === n ? face : 0)) * Math.exp(-t * Math.log1p(r))); price += pv; weighted += t / frequency * pv; convex += t * (t + 1) * pv / (frequency * frequency * (1 + r) ** 2); }
    checked(price); if (price <= 0) fail('NUMERICAL', 'Bond price underflow.');
    const macaulayDuration = checked(weighted / price); return { price, macaulayDuration, modifiedDuration: macaulayDuration / (1 + r), convexity: checked(convex / price) };
  }
  function normalCDF(x) {
    const a = Math.abs(x);
    if (a > 38) return x > 0 ? 1 : 0;
    const density = Math.exp(-a * a / 2) / Math.sqrt(2 * Math.PI);
    let tail;
    if (a <= 7) {
      // Positive-term expansion of Phi(a)-1/2, avoiding alternating erf cancellation.
      let term = a, series = a;
      for (let k = 1; k < 250; k++) { term *= a * a / (2 * k + 1); series += term; if (term <= Math.abs(series) * 2e-16) break; }
      tail = Math.max(0, 0.5 - density * series);
    } else {
      // Laplace continued fraction for the upper normal tail (Mills ratio).
      let r = 0; for (let k = 100; k >= 1; k--) r = k / (a + r);
      tail = density / (a + r);
    }
    return x >= 0 ? 1 - tail : tail;
  }
  function blackScholes({ spot, strike, rate, volatility, time, dividendYield = 0 }) {
    positive(spot, 'spot'); positive(strike, 'strike'); finite(rate, 'rate'); finite(dividendYield, 'dividendYield'); finite(volatility, 'volatility'); finite(time, 'time');
    if (volatility < 0 || time < 0) fail('INPUT', 'time and volatility must be nonnegative.');
    const ds = checked(spot * Math.exp(-dividendYield * time)), dk = checked(strike * Math.exp(-rate * time));
    if (time === 0 || volatility === 0) return { call: Math.max(0, ds - dk), put: Math.max(0, dk - ds), callDelta: ds === dk ? null : ds > dk ? Math.exp(-dividendYield * time) : 0, putDelta: ds === dk ? null : ds < dk ? -Math.exp(-dividendYield * time) : 0, gamma: null, vega: null, callTheta: null, putTheta: null, d1: null, d2: null };
    const rootT = Math.sqrt(time), st = volatility * rootT, d1 = checked((Math.log(spot / strike) + (rate - dividendYield + volatility * volatility / 2) * time) / st), d2 = d1 - st;
    const nd1 = normalCDF(d1), nd2 = normalCDF(d2), density = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI), discountQ = Math.exp(-dividendYield * time);
    const result = { call: Math.max(0, ds * nd1 - dk * nd2), put: Math.max(0, dk * normalCDF(-d2) - ds * normalCDF(-d1)), callDelta: discountQ * nd1, putDelta: discountQ * (nd1 - 1), gamma: discountQ * density / (spot * st), vega: ds * density * rootT, callTheta: -ds * density * volatility / (2 * rootT) - rate * dk * nd2 + dividendYield * ds * nd1, putTheta: -ds * density * volatility / (2 * rootT) + rate * dk * normalCDF(-d2) - dividendYield * ds * normalCDF(-d1), d1, d2 };
    Object.values(result).forEach(v => checked(v)); return result;
  }
  function capm({ riskFree, beta, marketReturn }) {
    finite(riskFree,'riskFree'); finite(beta,'beta'); finite(marketReturn,'marketReturn');
    const premium=checked(marketReturn-riskFree);
    return {costOfEquity:checked(riskFree+beta*premium),premium};
  }
  function wacc({ equity, debt, costOfEquity, costOfDebt, taxRate }) {
    finite(equity,'equity'); finite(debt,'debt'); finite(costOfEquity,'costOfEquity'); finite(costOfDebt,'costOfDebt'); finite(taxRate,'taxRate');
    if(equity<0 || debt<0 || equity+debt<=0 || taxRate<0 || taxRate>1) fail('INPUT','Capital amounts must be nonnegative with positive total; taxRate must be between 0 and 1.');
    const total=checked(equity+debt), equityWeight=equity/total, debtWeight=debt/total;
    return {rate:checked(equityWeight*costOfEquity+debtWeight*costOfDebt*(1-taxRate)),equityWeight,debtWeight};
  }
  return Object.freeze({ version: '1.0.0', compile, sample, derivative, integrate, gradientHessian, parseCSV, describe, ols, timeSeries, npv, irr, loanPayment, bondPV, blackScholes, capm, wacc });
});
