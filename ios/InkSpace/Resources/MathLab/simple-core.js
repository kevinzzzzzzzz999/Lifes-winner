/* Offline scientific calculator. Bounded parser; no eval or generated code.
 * Deliberately separate from MathLabEngine so workbench formulas retain their semantics.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SimpleCalculator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const messages = {
    EMPTY_EXPRESSION: ['请输入算式。', 'Enter an expression.'],
    EXPRESSION_TOO_LONG: ['算式最多可输入 2048 个字符。', 'Use at most 2048 characters.'],
    EXPRESSION_TOO_COMPLEX: ['算式过于复杂，请拆分计算。', 'This expression is too complex; calculate it in smaller parts.'],
    INVALID_CHARACTER: ['算式中有不支持的字符。', 'The expression contains an unsupported character.'],
    INVALID_NUMBER: ['数字格式无效或数值过大。', 'A number is invalid or too large.'],
    EXPECTED_VALUE: ['这里需要数字、常量或带括号的函数。', 'A number, constant, or function with parentheses is needed here.'],
    MISSING_PARENTHESIS: ['缺少右括号“)”；请检查括号是否成对。', 'A closing parenthesis is missing; check the parentheses.'],
    UNEXPECTED_TOKEN: ['请检查运算符和括号；相邻数字之间需要运算符。', 'Check the operators and parentheses; adjacent numbers need an operator.'],
    UNKNOWN_IDENTIFIER: ['无法识别“{name}”。', '“{name}” is not a recognized name.'],
    FUNCTION_PARENTHESES: ['函数 {name} 需要括号，例如 {name}(2)。', 'Use parentheses with {name}, for example {name}(2).'],
    ARGUMENT_COUNT: ['函数 {name} 的参数个数不正确。', 'The number of arguments for {name} is incorrect.'],
    VARIABLE_NOT_ALLOWED: ['x 用于函数绘图；计算数值时请将 x 替换为数字。', 'Use x in Graph mode; replace x with a number for a calculation.'],
    DIVISION_BY_ZERO: ['不能除以零。', 'Division by zero is undefined.'],
    DOMAIN_ERROR: ['算式在实数范围内无定义，请检查函数的输入。', 'This expression is undefined for real numbers; check the function inputs.'],
    FACTORIAL_DOMAIN: ['阶乘只支持 0 到 170 的整数。', 'Factorial accepts whole numbers from 0 to 170.'],
    OVERFLOW: ['结果超出可表示的数值范围。', 'The result exceeds the supported number range.'],
    INVALID_ANGLE: ['角度模式必须是 RAD 或 DEG。', 'Choose RAD or DEG for the angle mode.'],
    INVALID_ANS: ['上次结果无效，请重新计算。', 'The previous answer is invalid; calculate a new answer.'],
    INVALID_RANGE: ['绘图区间必须是有限数值，最大值需大于最小值。', 'Use finite graph limits with a maximum greater than the minimum.'],
    INVALID_COUNT: ['绘图采样点数必须是 3 到 10000 的整数。', 'The sample count must be an integer from 3 to 10000.'],
    DISCONTINUITY: ['已略过无定义点或疑似间断点；有限采样不能保证发现所有间断点。', 'Undefined points or suspected discontinuities were omitted; finite sampling cannot detect every discontinuity.'],
    NO_REAL_VALUES: ['所选区间内没有可绘制的实数值。', 'No real values can be plotted in the selected interval.'],
    UNKNOWN_ERROR: ['无法计算，请检查算式。', 'Unable to calculate; check the expression.']
  };
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  function formatError(error, locale = 'zh') {
    const entry = error && own(messages, error.code) ? messages[error.code] : messages.UNKNOWN_ERROR;
    return entry[String(locale).toLowerCase().startsWith('en') ? 1 : 0]
      .replace(/\{(\w+)\}/g, (_, key) => String(error && error.details && error.details[key] || ''));
  }
  function fail(code, position, details) {
    const error = new Error(formatError({ code, details }, 'en'));
    error.name = 'CalculatorError';
    error.code = code;
    if (Number.isInteger(position)) error.position = position + 1;
    error.details = details || {};
    throw error;
  }
  function finite(value, position) {
    if (Number.isNaN(value)) fail('DOMAIN_ERROR', position);
    if (!Number.isFinite(value)) fail('OVERFLOW', position);
    return value;
  }
  const functions = Object.freeze({
    sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1,
    dsin: 1, dcos: 1, dtan: 1, dasin: 1, dacos: 1, datan: 1,
    sqrt: 1, cbrt: 1, abs: 1, exp: 1, ln: 1, log: 1, log10: 1, log2: 1,
    sinh: 1, cosh: 1, tanh: 1, floor: 1, ceil: 1, round: 1,
    min: -1, max: -1, hypot: -1, pow: 2
  });
  const functionAliases = Object.freeze({ arcsin: 'asin', arccos: 'acos', arctan: 'atan' });
  const superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  const operators = { '×': '*', '·': '*', '÷': '/', '−': '-', '–': '-', '＋': '+', '－': '-', '（': '(', '）': ')', '％': '%' };
  function tokenize(source) {
    const tokens = [];
    let index = 0;
    while (index < source.length) {
      const position = index, character = source[index];
      if (/\s/.test(character)) { index++; continue; }
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(index));
      if (match) {
        const value = Number(match[0]);
        if (!Number.isFinite(value)) fail('INVALID_NUMBER', position);
        tokens.push({ type: 'number', value, position });
        index += match[0].length;
        if (source[index] === '.') fail('INVALID_NUMBER', index);
      } else if (superscripts.includes(character) || character === '⁻' || character === '⁺') {
        let digits = '', negative = false;
        if (character === '⁻' || character === '⁺') { negative = character === '⁻'; index++; }
        while (index < source.length && superscripts.includes(source[index])) digits += superscripts.indexOf(source[index++]);
        if (!digits) fail('INVALID_NUMBER', position);
        tokens.push({ type: 'superscript', value: Number(digits) * (negative ? -1 : 1), position });
      } else if (character === 'π' || character === 'Π') {
        tokens.push({ type: 'id', value: 'pi', position }); index++;
      } else if (character === '√') {
        tokens.push({ type: 'root', position }); index++;
      } else {
        const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
        if (identifier) { tokens.push({ type: 'id', value: identifier[0].toLowerCase(), position }); index += identifier[0].length; }
        else if (character === '*' && source[index + 1] === '*') { tokens.push({ type: '^', position }); index += 2; }
        else if ('+-*/^(),!%'.includes(character) || own(operators, character)) {
          tokens.push({ type: operators[character] || character, position }); index++;
        } else fail('INVALID_CHARACTER', position);
      }
      if (tokens.length > 512) fail('EXPRESSION_TOO_COMPLEX', position);
    }
    tokens.push({ type: 'end', position: source.length });
    return tokens;
  }
  function compile(expression, graphMode) {
    if (typeof expression !== 'string' || !expression.trim()) fail('EMPTY_EXPRESSION');
    if (expression.length > 2048) fail('EXPRESSION_TOO_LONG');
    // Keep character positions aligned with the entered expression.
    const source = expression.replace(/^\s*y\s*=\s*/i, prefix => ' '.repeat(prefix.length));
    const tokens = tokenize(source);
    let index = 0, depth = 0;
    const peek = () => tokens[index].type;
    const node = (op, token, parts = {}) => ({ op, position: token.position, ...parts });
    function nested(fn) {
      if (++depth > 64) fail('EXPRESSION_TOO_COMPLEX', tokens[index].position);
      const result = fn(); depth--; return result;
    }
    function close() {
      if (peek() !== ')') fail('MISSING_PARENTHESIS', tokens[index].position);
      index++;
    }
    function sum() {
      let left = product();
      while (peek() === '+' || peek() === '-') { const token = tokens[index++]; left = node(token.type, token, { left, right: product() }); }
      return left;
    }
    function product() {
      let left = unary();
      while (true) {
        const token = tokens[index];
        if (peek() === '*' || peek() === '/') { index++; left = node(token.type, token, { left, right: unary() }); }
        // Juxtaposition has the same priority as explicit multiplication, left to right.
        else if (peek() === 'id' || peek() === '(' || peek() === 'root' ||
          (peek() === 'number' && [')', '!', '%', 'superscript', 'id'].includes(tokens[index - 1].type))) {
          left = node('*', token, { left, right: unary() });
        } else break;
      }
      return left;
    }
    function unary() {
      if (peek() === '+' || peek() === '-') {
        const token = tokens[index++]; return node(token.type === '+' ? 'positive' : 'negative', token, { value: nested(unary) });
      }
      if (peek() === 'root') { const token = tokens[index++]; return node('call', token, { name: 'sqrt', args: [nested(unary)] }); }
      return power();
    }
    function power() {
      const left = postfix();
      if (peek() === '^') { const token = tokens[index++]; return node('^', token, { left, right: nested(unary) }); }
      return left;
    }
    function postfix() {
      let value = atom();
      while (peek() === '!' || peek() === '%' || peek() === 'superscript') {
        const token = tokens[index++];
        value = token.type === 'superscript'
          ? node('^', token, { left: value, right: node('literal', token, { value: token.value }) })
          : node(token.type, token, { value });
      }
      return value;
    }
    function atom() {
      const token = tokens[index++];
      if (token.type === 'number') return node('literal', token, { value: token.value });
      if (token.type === '(') { const value = nested(sum); close(); return value; }
      if (token.type !== 'id') fail('EXPECTED_VALUE', token.position);
      const name = token.value;
      const functionName = own(functionAliases, name) ? functionAliases[name] : name;
      if (own(functions, functionName)) {
        if (peek() !== '(') fail('FUNCTION_PARENTHESES', token.position, { name });
        index++;
        const args = [];
        if (peek() !== ')') {
          args.push(nested(sum));
          while (peek() === ',') { index++; args.push(nested(sum)); }
        }
        close();
        if ((functions[functionName] > 0 && args.length !== functions[functionName]) ||
          (functions[functionName] < 0 && (args.length < 1 || args.length > 32))) fail('ARGUMENT_COUNT', token.position, { name });
        return node('call', token, { name: functionName, args });
      }
      if (name === 'pi' || name === 'e') return node('literal', token, { value: name === 'pi' ? Math.PI : Math.E });
      if (name === 'ans' || (name === 'x' && graphMode)) return node('variable', token, { name });
      if (name === 'x') fail('VARIABLE_NOT_ALLOWED', token.position);
      fail('UNKNOWN_IDENTIFIER', token.position, { name });
    }
    const ast = sum();
    if (peek() !== 'end') fail('UNEXPECTED_TOKEN', tokens[index].position);

    // Track denominators themselves, including removable holes. A value-only jump
    // heuristic cannot see (x-a)/(x-a), nor a squared denominator with equal signs.
    const guards = [];
    function mark(value, kind = 'zero') {
      if (value.guards && value.guards.some(id => guards[id] === kind)) return;
      if (!value.guards) value.guards = [];
      value.guards.push(guards.length); guards.push(kind);
    }
    function zeroFactors(value) {
      mark(value);
      if (value.op === '*') { zeroFactors(value.left); zeroFactors(value.right); }
      else if (value.op === '^' && value.right.op === 'literal' && value.right.value > 0) zeroFactors(value.left);
      else if (value.op === 'positive' || value.op === 'negative') zeroFactors(value.value);
      else if (value.op === 'call' && ['abs', 'sqrt', 'cbrt'].includes(value.name)) zeroFactors(value.args[0]);
      else if (value.op === 'call' && value.name === 'pow' && value.args[1].op === 'literal' && value.args[1].value > 0) zeroFactors(value.args[0]);
    }
    function walk(value) {
      if (value.op === '/') zeroFactors(value.right);
      if (value.op === '^' && (value.right.op === 'negative' || (value.right.op === 'literal' && value.right.value < 0))) zeroFactors(value.left);
      if (value.op === 'call') {
        if (value.name === 'tan' || value.name === 'dtan') { value.poleGuard = guards.length; guards.push('zero'); }
        if (['ln', 'log', 'log10', 'log2'].includes(value.name)) zeroFactors(value.args[0]);
        if (value.name === 'pow' && (value.args[1].op === 'negative' ||
          (value.args[1].op === 'literal' && value.args[1].value < 0))) zeroFactors(value.args[0]);
        if (['floor', 'ceil', 'round'].includes(value.name)) mark(value, 'step');
        value.args.forEach(walk);
      }
      if (value.left) walk(value.left);
      if (value.right) walk(value.right);
      if (value.value && typeof value.value === 'object') walk(value.value);
    }
    if (graphMode) walk(ast);
    function evaluate(value, scope, angle, trace) {
      let result;
      const inner = child => evaluate(child, scope, angle, trace);
      switch (value.op) {
        case 'literal': result = value.value; break;
        case 'variable': result = scope[value.name]; break;
        case 'positive': result = inner(value.value); break;
        case 'negative': result = -inner(value.value); break;
        case '%': result = inner(value.value) / 100; break;
        case '!': {
          const input = inner(value.value);
          if (!Number.isInteger(input) || input < 0 || input > 170) fail('FACTORIAL_DOMAIN', value.position);
          result = 1; for (let n = 2; n <= input; n++) result *= n;
          break;
        }
        case '+': result = inner(value.left) + inner(value.right); break;
        case '-': result = inner(value.left) - inner(value.right); break;
        case '*': result = inner(value.left) * inner(value.right); break;
        case '/': {
          const left = inner(value.left), right = inner(value.right);
          if (right === 0) fail('DIVISION_BY_ZERO', value.position);
          result = left / right; break;
        }
        case '^': {
          const left = inner(value.left), right = inner(value.right);
          if (left === 0 && right < 0) fail('DIVISION_BY_ZERO', value.position);
          if (left === 0 && right === 0) fail('DOMAIN_ERROR', value.position);
          result = Math.pow(left, right); break;
        }
        case 'call': {
          const args = value.args.map(inner), input = args[0];
          const explicitDegrees = /^d(?:a?sin|a?cos|a?tan)$/.test(value.name);
          const name = explicitDegrees ? value.name.slice(1) : value.name;
          const degrees = explicitDegrees || angle === 'deg';
          if (['sin', 'cos', 'tan'].includes(name)) {
            // Reduce degrees before converting to avoid a false finite tan(90 + 360n).
            // Exact quarter turns also avoid displaying sin(pi) as a rounding residue.
            const reduced = input % (degrees ? 360 : 2 * Math.PI);
            const quarterTurns = reduced / (degrees ? 90 : Math.PI / 2);
            const quadrant = ((quarterTurns % 4) + 4) % 4;
            const radians = degrees ? reduced * (Math.PI / 180) : input;
            const cosine = Number.isInteger(quarterTurns) ? [1, 0, -1, 0][quadrant] : Math.cos(radians);
            if (name === 'tan') {
              const denominator = cosine;
              if (trace && value.poleGuard !== undefined) trace[value.poleGuard] = denominator;
              if (Math.abs(denominator) <= 8 * Number.EPSILON) fail('DOMAIN_ERROR', value.position);
            }
            result = name === 'cos' ? cosine : Number.isInteger(quarterTurns)
              ? (name === 'tan' ? 0 : [0, 1, 0, -1][quadrant]) : Math[name](radians);
          } else if (['asin', 'acos', 'atan'].includes(name)) {
            result = Math[name](input) * (degrees ? 180 / Math.PI : 1);
          } else if (name === 'ln' || name === 'log' || name === 'log10' || name === 'log2') {
            if (input <= 0) fail('DOMAIN_ERROR', value.position);
            result = name === 'ln' ? Math.log(input) : name === 'log2' ? Math.log2(input) : Math.log10(input);
          } else if (name === 'pow') {
            if (input === 0 && args[1] <= 0) fail(args[1] === 0 ? 'DOMAIN_ERROR' : 'DIVISION_BY_ZERO', value.position);
            result = Math.pow(...args);
          } else result = Math[name](...args);
          break;
        }
      }
      finite(result, value.position);
      if (trace && value.guards) for (const id of value.guards) trace[id] = result;
      return result;
    }
    return { evaluate: (scope, angle, trace) => evaluate(ast, scope, angle, trace), guards };
  }
  function options(angle, ans) {
    if (angle !== 'rad' && angle !== 'deg') fail('INVALID_ANGLE');
    if (typeof ans !== 'number' || !Number.isFinite(ans)) fail('INVALID_ANS');
  }
  function calculate(expression, { angle = 'rad', ans = 0 } = {}) {
    options(angle, ans);
    const result = compile(expression, false).evaluate({ ans }, angle);
    return Object.is(result, -0) ? 0 : result;
  }
  function graph(expression, { angle = 'rad', ans = 0, min = -10, max = 10, count = 1001 } = {}) {
    options(angle, ans);
    if (![min, max].every(value => typeof value === 'number' && Number.isFinite(value)) ||
      max <= min || !Number.isFinite(max - min)) fail('INVALID_RANGE');
    if (!Number.isInteger(count) || count < 3 || count > 10000) fail('INVALID_COUNT');
    const compiled = compile(expression, true), points = [], segments = [];
    let current = [], previous = null, omitted = false;
    function sample(x) {
      const trace = [];
      try {
        const y = compiled.evaluate({ x, ans }, angle, trace);
        return { point: { x, y: Object.is(y, -0) ? 0 : y }, trace };
      }
      catch (error) {
        if (!['DOMAIN_ERROR', 'DIVISION_BY_ZERO', 'OVERFLOW', 'FACTORIAL_DOMAIN'].includes(error.code)) throw error;
        return { point: { x, y: null }, trace };
      }
    }
    function guardCrossing(left, right) {
      return compiled.guards.some((kind, id) => {
        const a = left.trace[id], b = right.trace[id];
        if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
        return kind === 'step' ? a !== b : a === 0 || b === 0 || Math.sign(a) !== Math.sign(b);
      });
    }
    function interrupted(left, right) {
      let before = left;
      // Interior probes find poles and domain holes between ordinary sample points.
      for (const fraction of [0.25, 0.5, 0.75, 1]) {
        const after = fraction === 1 ? right : sample(left.point.x + (right.point.x - left.point.x) * fraction);
        if (after.point.y === null || guardCrossing(before, after)) return true;
        before = after;
      }
      return false;
    }
    for (let index = 0; index < count; index++) {
      const item = sample(min + (max - min) * (index / (count - 1)));
      points.push(item.point);
      if (item.point.y === null || (previous && previous.point.y !== null && interrupted(previous, item))) {
        if (current.length) segments.push(current);
        current = []; omitted = true;
      }
      if (item.point.y !== null) current.push(item.point);
      previous = item;
    }
    if (current.length) segments.push(current);
    const warningCodes = [];
    if (!points.some(point => point.y !== null)) warningCodes.push('NO_REAL_VALUES');
    else if (omitted) warningCodes.push('DISCONTINUITY');
    return { points, segments, warningCodes, warnings: warningCodes.map(code => formatError({ code }, 'en')) };
  }
  return Object.freeze({ version: '2.0.0', calculate, graph, formatError });
});
