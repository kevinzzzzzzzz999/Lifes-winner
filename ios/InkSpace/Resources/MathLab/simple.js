(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const zh = new URLSearchParams(location.search).get('lang') !== 'en';
  const locale = zh ? 'zh' : 'en';
  const t = (chinese, english) => zh ? chinese : english;
  const storageKey = 'inkspace.simple-calculator';
  const input = $('expression'), plot = $('plot');
  const defaultBounds = () => ({ xmin: -10, xmax: 10, ymin: -10, ymax: 10 });
  let mode = 'calc', ans = 0, evaluated = false, inverse = false, graphKeys = false, lastEvaluation = null;
  let drafts = { calc: '', graph: 'sin(x)' }, history = [], bounds = defaultBounds();
  const curveColors = ['#087d76', '#b64e2d', '#6657b8', '#2477bd'];
  let functions = [{ slot: 0, expression: 'sin(x)', enabled: true, ans: 0 }], activeSlot = 0;
  let plotted = null, samples = null, graphDirty = false, pendingExport = false, exportTimer = 0, geometry = null, traceLayer = null, frameRequest = 0;
  let savedTimer = 0, requestedMode = 'calc';
  const number = value => Object.is(value, -0) ? '0' : Number(value.toPrecision(13)).toString();
  const validBounds = box => Object.values(box).every(Number.isFinite) &&
    box.xmax > box.xmin && box.ymax > box.ymin &&
    Number.isFinite(box.xmax - box.xmin) && Number.isFinite(box.ymax - box.ymin);

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved && typeof saved === 'object') {
      if (typeof saved.expression === 'string' && saved.expression.length <= 2048) drafts.calc = saved.expression;
      if (saved.drafts) for (const key of ['calc', 'graph']) {
        if (typeof saved.drafts[key] === 'string' && saved.drafts[key].length <= 2048) drafts[key] = saved.drafts[key];
      }
      if (Number.isFinite(saved.ans)) ans = saved.ans;
      if (Array.isArray(saved.functions)) {
        const slots = new Set();
        const restored = saved.functions.filter(item => item && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 4 &&
          !slots.has(item.slot) && slots.add(item.slot) && typeof item.expression === 'string' && item.expression.length <= 2048)
          .slice(0, 4).map(item => ({ slot: item.slot, expression: item.expression, enabled: item.enabled !== false, ans: Number.isFinite(item.ans) ? item.ans : 0 }));
        if (restored.length) functions = restored.sort((a, b) => a.slot - b.slot);
      } else functions[0].expression = drafts.graph;
      activeSlot = functions.some(item => item.slot === saved.activeSlot) ? saved.activeSlot : functions[0].slot;
      drafts.graph = functions.find(item => item.slot === activeSlot).expression;
      const last = saved.lastEvaluation;
      if (last && typeof last.expression === 'string' && last.expression.length <= 2048 &&
          Number.isFinite(last.value) && Number.isFinite(last.inputAns) && ['rad', 'deg'].includes(last.angle)) {
        lastEvaluation = { expression: last.expression, angle: last.angle, value: last.value, inputAns: last.inputAns };
      }
      if (['rad', 'deg'].includes(saved.angle)) $('angle').value = saved.angle;
      if (saved.mode === 'graph') requestedMode = 'graph';
      if (saved.bounds && ['xmin', 'xmax', 'ymin', 'ymax'].every(key => typeof saved.bounds[key] === 'number')) {
        const candidate = Object.fromEntries(['xmin', 'xmax', 'ymin', 'ymax'].map(key => [key, saved.bounds[key]]));
        if (validBounds(candidate)) bounds = candidate;
      }
      if (Array.isArray(saved.history)) history = saved.history.filter(item => item &&
        typeof item.expression === 'string' && item.expression.length <= 2048 && Number.isFinite(item.value) &&
        ['rad', 'deg'].includes(item.angle)).slice(0, 30);
    }
  } catch { /* Private browsing or old state must not prevent calculation. */ }

  document.documentElement.lang = zh ? 'zh-CN' : 'en';
  document.title = t('科学计算器', 'Scientific Calculator');
  if (!zh) {
    const labels = { calcTab: 'Scientific', graphTab: 'Graph', expressionLabel: 'Expression', draw: 'Plot',
      copyResult: 'Copy result', exportGraph: 'Export graph PNG', exportHint: 'Current axes and legend included',
      functionsTitle: 'Compare functions · up to 4', addFunction: 'Add function', answerLabel: 'Result', resetView: 'Reset', fitY: 'Fit Y', toggleKeys: 'Keys', graphEmpty: 'Enter a function, then Plot',
      graphHelp: 'Drag to pan · Scroll or pinch to zoom · Tap for coordinates', rangeTitle: 'Axis ranges',
      applyRange: 'Apply ranges', keyHint: '2π, 2(3+4) · % = ÷100', historyTitle: 'History',
      historyHelp: 'Tap an entry to use its expression', clearHistory: 'Clear', historyEmpty: 'No calculations yet' };
    for (const [id, text] of Object.entries(labels)) $(id).textContent = text;
    document.querySelector('nav').setAttribute('aria-label', 'Calculator mode');
    $('angle').setAttribute('aria-label', 'Angle unit');
    $('keypad').setAttribute('aria-label', 'Calculator keypad');
    $('graphControls').setAttribute('aria-label', 'Function graph');
    $('zoomOut').setAttribute('aria-label', 'Zoom out');
    $('zoomIn').setAttribute('aria-label', 'Zoom in');
    plot.setAttribute('aria-label', 'Function graph. Drag to pan, scroll or pinch to zoom, arrow keys to pan.');
  }
  input.value = drafts.calc;
  $('result').textContent = number(ans);

  function persist() {
    clearTimeout(savedTimer);
    drafts[mode] = input.value;
    try { localStorage.setItem(storageKey, JSON.stringify({ expression: drafts.calc, drafts, ans,
      angle: $('angle').value, mode, bounds, history, lastEvaluation, functions, activeSlot })); } catch { /* Storage is optional. */ }
  }
  function persistSoon() { clearTimeout(savedTimer); savedTimer = setTimeout(persist, 160); }
  window.addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => { if (document.hidden) persist(); });
  function clearMessage() { $('message').textContent = ''; $('message').classList.remove('warning'); input.removeAttribute('aria-invalid'); }
  function showError(error) {
    const fallback = t('请检查算式和括号。', 'Check the expression and its parentheses.');
    const message = typeof SimpleCalculator.formatError === 'function' ? SimpleCalculator.formatError(error, locale) : fallback;
    $('message').textContent = String(message).slice(0, 240);
    $('message').classList.remove('warning');
    input.setAttribute('aria-invalid', 'true');
    if (mode === 'calc') { $('result').textContent = '—'; $('copyResult').disabled = true; }
  }
  function showWarnings(result) {
    const codes = result.warningCodes || (result.warnings?.length ? ['DISCONTINUITY'] : []);
    if (!codes.length) return;
    const code = codes.includes('NO_REAL_VALUES') ? 'NO_REAL_VALUES' : codes[0];
    $('message').textContent = typeof SimpleCalculator.formatError === 'function' ?
      SimpleCalculator.formatError({ code }, locale) : t('已略过未定义区间。', 'Undefined regions omitted.');
    $('message').classList.add('warning');
  }
  function edited() {
    evaluated = false; clearMessage(); $('actionStatus').textContent = '';
    if (mode === 'calc') { $('result').textContent = '—'; $('copyResult').disabled = true; }
    else { activeFunction().expression = input.value; graphDirty = true; $('exportGraph').disabled = true; actionStatus(t('函数已修改；点按绘图更新。', 'Function changed. Tap Plot to update.')); renderFunctionList(); }
    drafts[mode] = input.value; persistSoon();
  }
  input.addEventListener('input', edited);
  input.addEventListener('pointerdown', () => { evaluated = false; });
  input.addEventListener('beforeinput', event => {
    if (!evaluated || mode !== 'calc' || !event.inputType.startsWith('insert')) return;
    if (input.selectionStart !== input.selectionEnd) { evaluated = false; return; }
    const text = event.data || '';
    if (/^[+\-−*/×÷^%!]/.test(text)) input.value = ans < 0 ? '(' + String(ans) + ')' : String(ans);
    else input.value = '';
    input.setSelectionRange(input.value.length, input.value.length);
    evaluated = false;
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); clear(); }
    // Embedded app hosts may block implicit form submission. Handle the editor's
    // Enter directly so keyboard calculation and plotting do not depend on it.
    if (event.key === '=' || event.key === 'Enter' || event.key === 'Return') { event.preventDefault(); submit(); }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete'].includes(event.key)) evaluated = false;
  });

  const keySpecs = [
    ['sin', 'sin', 'function'], ['cos', 'cos', 'function'], ['tan', 'tan', 'function'], ['(', '(', 'function'], [')', ')', 'function'],
    ['ln', 'ln', 'function'], ['log', 'log', 'function'], ['sqrt', '√', 'function'], ['square', 'x²', 'function'], ['^', 'xʸ', 'function'],
    ['pi', 'π', 'function'], ['e', 'e', 'function'], ['!', 'n!', 'function'], ['%', '%', 'function'], ['reciprocal', '1/x', 'function'],
    ['7', '7', ''], ['8', '8', ''], ['9', '9', ''], ['/', '÷', 'operator'], ['AC', 'AC', 'clear'],
    ['4', '4', ''], ['5', '5', ''], ['6', '6', ''], ['*', '×', 'operator'], ['backspace', '⌫', 'function'],
    ['1', '1', ''], ['2', '2', ''], ['3', '3', ''], ['-', '−', 'operator'], ['ans', 'Ans', 'function'],
    ['sign', '±', 'function'], ['0', '0', ''], ['.', '.', ''], ['+', '+', 'operator'], ['=', '=', 'equals']
  ];
  const keyButtons = new Map();
  for (const [key, label, className] of keySpecs) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.key = key; button.textContent = label; button.className = className;
    if (key === '%') button.title = t('百分数：50% = 0.5', 'Percent: 50% = 0.5');
    if (key === '!') button.title = t('阶乘：5! = 120', 'Factorial: 5! = 120');
    if (key === 'log') button.title = t('以 10 为底的对数', 'Base-10 logarithm');
    if (key === 'ln') button.title = t('自然对数', 'Natural logarithm');
    if (key === 'backspace') button.setAttribute('aria-label', t('退格', 'Backspace'));
    if (key === 'AC') button.setAttribute('aria-label', t('全部清除', 'All clear'));
    // Keep the insertion point when clicking keys, including in WKWebView.
    button.addEventListener('pointerdown', event => event.preventDefault());
    button.addEventListener('click', () => pressKey(key));
    $('keys').append(button); keyButtons.set(key, button);
  }
  function setInput(value, start = value.length, end = start) {
    input.value = value; input.setSelectionRange(start, end); edited();
  }
  function replaceSelection(text, caretOffset = text.length) {
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    if (input.value.length - (end - start) + text.length > 2048) return;
    setInput(input.value.slice(0, start) + text + input.value.slice(end), start + caretOffset);
  }
  function clear() {
    setInput(''); $('result').textContent = '0';
    if (mode === 'graph') { activeFunction().expression = ''; renderGraph(); }
    persist();
  }
  function pressKey(key) {
    if (key === '=') return submit();
    if (key === 'AC') return clear();
    if (key === 'backspace') {
      const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
      setInput(input.value.slice(0, start === end ? Math.max(0, start - 1) : start) + input.value.slice(end), start === end ? Math.max(0, start - 1) : start);
      return;
    }
    if (key === 'sign' && mode === 'graph') key = 'x';
    if (key === 'e' && inverse) key = 'abs';
    const isFunction = ['sin', 'cos', 'tan', 'ln', 'log', 'sqrt', 'abs'].includes(key);
    if (evaluated && mode === 'calc') {
      const continues = ['+', '-', '*', '/', '^', '!', '%', 'square', 'reciprocal', 'sign'].includes(key) || isFunction;
      input.value = continues ? (ans < 0 ? '(' + String(ans) + ')' : String(ans)) : '';
      input.setSelectionRange(isFunction ? 0 : input.value.length, input.value.length);
      evaluated = false;
    }
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    const selection = input.value.slice(start, end);
    if (isFunction) {
      const functionName = inverse && ['sin', 'cos', 'tan'].includes(key) ? 'a' + key : key;
      replaceSelection(functionName + '(' + selection + ')', selection ? functionName.length + selection.length + 2 : functionName.length + 1);
    } else if (key === 'square') {
      replaceSelection(selection ? '(' + selection + ')^2' : '^2');
    } else if (key === 'reciprocal' || key === 'sign') {
      const operand = selection || input.value || (mode === 'calc' ? String(ans) : 'x');
      const text = key === 'reciprocal' ? '1/(' + operand + ')' : (operand.startsWith('-(') && operand.endsWith(')') ? operand.slice(2, -1) : '-(' + operand + ')');
      if (selection) replaceSelection(text); else setInput(text);
    } else if (key === ')' && !selection && input.value[start] === ')') {
      input.setSelectionRange(start + 1, start + 1); edited();
    } else if ((key === '!' || key === '%') && selection) replaceSelection('(' + selection + ')' + key);
    else replaceSelection(key);
  }
  $('inverse').addEventListener('click', () => {
    inverse = !inverse; $('inverse').setAttribute('aria-pressed', String(inverse));
    for (const key of ['sin', 'cos', 'tan']) keyButtons.get(key).textContent = inverse ? key + '⁻¹' : key;
    keyButtons.get('e').textContent = inverse ? 'abs' : 'e';
  });
  // Hardware keyboards continue to work after using any keypad button.
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.target.matches('input,select') || event.target === plot) return;
    if (event.key === 'Escape') { event.preventDefault(); clear(); }
    else if (event.key === 'Backspace') { event.preventDefault(); pressKey('backspace'); }
    else if (event.key === 'Enter' || event.key === '=') { event.preventDefault(); submit(); }
    else if (event.key.length === 1 && /^[0-9a-zA-Z.+\-*/^()%!]$/.test(event.key)) {
      event.preventDefault(); pressKey(event.key); input.focus({ preventScroll: true });
    }
  });
  $('form').addEventListener('submit', event => { event.preventDefault(); submit(); });
  $('draw').addEventListener('click', event => { event.preventDefault(); submit(); });
  function renderHistory() {
    $('history').replaceChildren(...history.map(item => {
      const li = document.createElement('li'), button = document.createElement('button'); button.type = 'button';
      const expression = document.createElement('span'); expression.className = 'history-expression'; expression.textContent = item.expression;
      const angle = document.createElement('span'); angle.className = 'history-angle'; angle.textContent = item.angle.toUpperCase(); expression.append(angle);
      const result = document.createElement('span'); result.className = 'history-answer'; result.textContent = '= ' + number(item.value);
      button.append(expression, result); button.addEventListener('click', () => {
        if (mode !== 'calc') setMode('calc'); $('angle').value = item.angle; updateAngle();
        setInput(item.expression); ans = item.value; $('result').textContent = number(item.value); evaluated = true; $('copyResult').disabled = false;
        lastEvaluation = Number.isFinite(item.inputAns) ? { ...item } : null;
        persist(); input.focus({ preventScroll: true });
      }); li.append(button); return li;
    }));
    $('historyCount').textContent = history.length ? String(history.length) : '';
    $('historyEmpty').hidden = history.length > 0; $('clearHistory').disabled = !history.length;
  }
  $('clearHistory').addEventListener('click', () => { history = []; renderHistory(); persist(); });
  function updateAngle() { $('angleHint').textContent = $('angle').value === 'deg' ? t('角度', 'Degrees') : t('弧度', 'Radians'); }
  $('angle').addEventListener('change', () => {
    const recalculate = mode === 'calc' && evaluated && lastEvaluation && lastEvaluation.expression === input.value;
    updateAngle(); evaluated = false; clearMessage();
    if (mode === 'graph') renderGraph();
    if (mode === 'calc') {
      $('result').textContent = '—'; $('copyResult').disabled = true;
      if (recalculate) submit(lastEvaluation.inputAns);
    }
    persist();
  });
  function setMode(next) {
    if (next !== mode) { drafts[mode] = input.value; mode = next; input.value = drafts[mode]; input.setSelectionRange(input.value.length, input.value.length); }
    document.body.dataset.mode = mode; evaluated = false; clearMessage();
    $('graphControls').hidden = mode !== 'graph'; $('draw').hidden = mode !== 'graph';
    $('answerRow').hidden = mode === 'graph'; $('resultActions').hidden = mode === 'graph'; $('copyResult').disabled = true; $('keypad').hidden = mode === 'graph' && !graphKeys;
    if (mode === 'calc') $('result').textContent = input.value.trim() ? '—' : '0';
    $('expressionLabel').textContent = mode === 'graph' ? t('函数 y = f(x)', 'Function y = f(x)') : t('输入算式', 'Expression');
    input.placeholder = mode === 'graph' ? 'y = sin(x)' : '50ln(42) / (ln(42) + 1)';
    for (const key of ['calc', 'graph']) { $(key + 'Tab').classList.toggle('active', mode === key); $(key + 'Tab').setAttribute('aria-selected', String(mode === key)); }
    keyButtons.get('sign').textContent = mode === 'graph' ? 'x' : '±';
    keyButtons.get('=').textContent = mode === 'graph' ? t('绘图', 'Plot') : '=';
    if (mode === 'graph') { renderFunctionList(); renderGraph(); }
    persist();
  }
  $('calcTab').addEventListener('click', () => setMode('calc'));
  $('graphTab').addEventListener('click', () => setMode('graph'));
  $('toggleKeys').addEventListener('click', () => { graphKeys = !graphKeys; $('keypad').hidden = !graphKeys; $('toggleKeys').setAttribute('aria-expanded', String(graphKeys)); });
  function submit(previousAns = ans) {
    clearMessage();
    try {
      if (mode === 'calc') {
        const expression = input.value, angle = $('angle').value;
        ans = SimpleCalculator.calculate(expression, { angle, ans: previousAns });
        lastEvaluation = { expression, angle, inputAns: previousAns, value: ans };
        $('result').textContent = number(ans); evaluated = true; $('copyResult').disabled = false;
        const latest = history[0];
        if (!latest || latest.expression !== expression || latest.value !== ans || latest.angle !== angle) {
          history.unshift({ expression, value: ans, angle, inputAns: previousAns }); history.splice(30); renderHistory();
        }
      } else {
        activeFunction().expression = input.value; activeFunction().ans = ans;
        renderGraph();
      }
      persist();
    } catch (error) {
      evaluated = false;
      if (mode === 'graph') { activeFunction().expression = ''; renderGraph(); }
      showError(error);
    }
  }

  function svg(name, attrs = {}, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function updateRanges() { for (const key of ['xmin', 'xmax', 'ymin', 'ymax']) $(key).value = Number(bounds[key].toPrecision(11)).toString(); }
  function activeFunction() { return functions.find(item => item.slot === activeSlot) || functions[0]; }
  function renderFunctionList() {
    $('functionList').replaceChildren(...functions.map(item => {
      const row = document.createElement('div'); row.className = 'function-row' + (item.slot === activeSlot ? ' selected' : '');
      const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = item.enabled;
      toggle.id = 'curveVisible' + item.slot; toggle.setAttribute('aria-label', t('显示函数 ', 'Show function ') + (item.slot + 1));
      toggle.addEventListener('change', () => { item.enabled = toggle.checked; renderGraph(); persist(); });
      const edit = document.createElement('button'); edit.type = 'button'; edit.id = 'curveEdit' + item.slot;
      edit.style.color = curveColors[item.slot]; edit.textContent = 'f' + (item.slot + 1) + '(x) = ' + (item.expression || t('输入函数', 'Enter a function'));
      edit.setAttribute('aria-pressed', String(item.slot === activeSlot));
      edit.addEventListener('click', () => { activeSlot = item.slot; input.value = item.expression; drafts.graph = item.expression; renderFunctionList(); renderGraph(); persist(); input.focus(); });
      const remove = document.createElement('button'); remove.type = 'button'; remove.id = 'curveRemove' + item.slot;
      remove.textContent = '×'; remove.disabled = functions.length === 1; remove.setAttribute('aria-label', t('移除函数 ', 'Remove function ') + (item.slot + 1));
      remove.addEventListener('click', () => { functions = functions.filter(value => value.slot !== item.slot); if (activeSlot === item.slot) { activeSlot = functions[0].slot; input.value = activeFunction().expression; } renderFunctionList(); renderGraph(); persist(); });
      row.append(toggle, edit, remove); return row;
    }));
    $('addFunction').disabled = functions.length >= 4;
    $('expressionLabel').textContent = t('编辑函数 ', 'Edit function ') + 'f' + (activeSlot + 1) + '(x)';
  }
  $('addFunction').addEventListener('click', () => {
    if (functions.length >= 4) return;
    const slot = [0, 1, 2, 3].find(value => !functions.some(item => item.slot === value));
    functions.push({ slot, expression: '', enabled: true, ans }); functions.sort((a, b) => a.slot - b.slot); activeSlot = slot; input.value = ''; drafts.graph = '';
    renderFunctionList(); renderGraph(); persist(); input.focus();
  });
  function renderGraph() {
    if (graphDirty) actionStatus('');
    samples = []; const errors = [];
    for (const item of functions) {
      if (!item.enabled || !item.expression.trim()) continue;
      try {
        const result = SimpleCalculator.graph(item.expression, { angle: $('angle').value, ans: item.ans, min: bounds.xmin, max: bounds.xmax, count: 1201 });
        samples.push({ ...result, slot: item.slot, expression: item.expression, color: curveColors[item.slot] });
      } catch (error) { errors.push('f' + (item.slot + 1) + ': ' + SimpleCalculator.formatError(error, locale)); }
    }
    plotted = samples.length > 0; graphDirty = false; clearMessage();
    if (errors.length) { $('message').textContent = errors.join(' · '); }
    else showWarnings({ warningCodes: samples.flatMap(item => item.warningCodes || []) });
    $('exportGraph').disabled = pendingExport || !samples.some(item => item.segments.some(segment => segment.length > 1));
    renderFunctionList(); drawGraph();
  }
  function queueGraph() {
    if (frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      try { renderGraph(); persistSoon(); } catch (error) { showError(error); }
    });
  }
  function ticks(min, max, target) {
    const raw = (max - min) / target, power = 10 ** Math.floor(Math.log10(raw));
    const fraction = raw / power, step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
    if (!Number.isFinite(step) || step <= 0) return [];
    const first = Math.ceil(min / step), last = Math.floor(max / step), result = [];
    for (let i = first; i <= last && result.length < 30; i++) result.push(Number((i * step).toPrecision(12)));
    return result;
  }
  function tickText(value) {
    if (Math.abs(value) < 1e-12) return '0';
    if (Math.abs(value) >= 1e5 || Math.abs(value) < 1e-3) return value.toExponential(1).replace('e+', 'e');
    return Number(value.toPrecision(5)).toString();
  }
  function drawGraph() {
    if (mode !== 'graph') return;
    const rect = plot.getBoundingClientRect();
    const width = Math.max(220, rect.width || 350), height = Math.max(180, rect.height || 288);
    const left = 45, right = width - 15, top = 16, bottom = height - 29;
    const xspan = bounds.xmax - bounds.xmin, yspan = bounds.ymax - bounds.ymin;
    const px = x => left + (x - bounds.xmin) / xspan * (right - left);
    const py = y => bottom - Math.max(-10000, Math.min(10000, (y - bounds.ymin) / yspan)) * (bottom - top);
    geometry = { width, height, left, right, top, bottom, px, py };
    plot.setAttribute('viewBox', '0 0 ' + width + ' ' + height); plot.replaceChildren();
    const defs = svg('defs'), clip = svg('clipPath', { id: 'curve-clip' });
    clip.append(svg('rect', { x: left, y: top, width: right - left, height: bottom - top })); defs.append(clip); plot.append(defs);
    for (const x of ticks(bounds.xmin, bounds.xmax, Math.max(3, Math.floor((right - left) / 65)))) {
      plot.append(svg('line', { x1: px(x), y1: top, x2: px(x), y2: bottom, stroke: '#e6ece7' }),
        svg('text', { x: px(x), y: bottom + 18, 'text-anchor': 'middle' }, tickText(x)));
    }
    for (const y of ticks(bounds.ymin, bounds.ymax, Math.max(3, Math.floor((bottom - top) / 48)))) {
      plot.append(svg('line', { x1: left, y1: py(y), x2: right, y2: py(y), stroke: '#e6ece7' }),
        svg('text', { x: left - 6, y: py(y) + 4, 'text-anchor': 'end' }, tickText(y)));
    }
    plot.append(svg('rect', { x: left, y: top, width: right - left, height: bottom - top, fill: 'none', stroke: '#dce6df' }));
    if (bounds.ymin <= 0 && bounds.ymax >= 0) plot.append(svg('line', { x1: left, y1: py(0), x2: right, y2: py(0), stroke: '#a0b3a6' }));
    if (bounds.xmin <= 0 && bounds.xmax >= 0) plot.append(svg('line', { x1: px(0), y1: top, x2: px(0), y2: bottom, stroke: '#a0b3a6' }));
    plot.append(svg('text', { x: right + 3, y: bottom + 18, class: 'axis-label' }, 'x'),
      svg('text', { x: left - 10, y: top - 5, class: 'axis-label' }, 'y'));
    const curves = svg('g', { 'clip-path': 'url(#curve-clip)' });
    for (const result of samples || []) for (const segment of result.segments) {
      const finite = segment.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (finite.length < 2) continue;
      const path = finite.map((point, index) => (index ? 'L' : 'M') + px(point.x).toFixed(2) + ',' + py(point.y).toFixed(2)).join(' ');
      curves.append(svg('path', { d: path, class: 'curve', stroke: result.color, 'data-function': result.slot }));
    }
    plot.append(curves); traceLayer = svg('g', { 'clip-path': 'url(#curve-clip)' }); plot.append(traceLayer);
    $('graphEmpty').hidden = Boolean(plotted);
    $('graphLegend').replaceChildren(...(samples || []).map(item => {
      const legend = document.createElement('span'); legend.style.color = item.color;
      legend.textContent = 'f' + (item.slot + 1) + '(x) = ' + item.expression.replace(/^\s*y\s*=\s*/i, ''); return legend;
    }));
    $('plottedExpression').textContent = $('angle').value.toUpperCase();
    $('plottedExpression').title = $('plottedExpression').textContent;
    $('trace').textContent = 'x — · y —'; updateRanges();
  }
  function setBounds(next) {
    if (!validBounds(next)) return false;
    const xs = next.xmax - next.xmin, ys = next.ymax - next.ymin;
    if (xs < 1e-10 || ys < 1e-10 || xs > 1e15 || ys > 1e15 || Object.values(next).some(v => Math.abs(v) > 1e16)) return false;
    bounds = next; queueGraph(); return true;
  }
  $('applyRange').addEventListener('click', () => {
    const next = Object.fromEntries(['xmin', 'xmax', 'ymin', 'ymax'].map(key => [key, $(key).value.trim() === '' ? NaN : Number($(key).value)]));
    if (!setBounds(next)) {
      $('message').textContent = t('范围无效：最大值须大于最小值，跨度须在 10⁻¹⁰ 到 10¹⁵ 之间。', 'Use finite ranges with max > min and a span between 10⁻¹⁰ and 10¹⁵.');
      $('message').classList.remove('warning'); return;
    }
    clearMessage();
  });
  function resetView() { bounds = defaultBounds(); clearMessage(); queueGraph(); }
  $('resetView').addEventListener('click', resetView);
  function zoom(factor, point) {
    if (!geometry) return;
    const g = geometry, anchor = point || { x: (g.left + g.right) / 2, y: (g.top + g.bottom) / 2 };
    const fx = Math.max(0, Math.min(1, (anchor.x - g.left) / (g.right - g.left)));
    const fy = Math.max(0, Math.min(1, (anchor.y - g.top) / (g.bottom - g.top)));
    const xs = bounds.xmax - bounds.xmin, ys = bounds.ymax - bounds.ymin;
    const x = bounds.xmin + fx * xs, y = bounds.ymax - fy * ys;
    setBounds({ xmin: x - fx * xs * factor, xmax: x + (1 - fx) * xs * factor,
      ymin: y - (1 - fy) * ys * factor, ymax: y + fy * ys * factor });
  }
  $('zoomIn').addEventListener('click', () => zoom(0.75));
  $('zoomOut').addEventListener('click', () => zoom(1 / 0.75));
  $('fitY').addEventListener('click', () => {
    if (!samples?.length) return;
    const ys = samples.flatMap(item => item.points).filter(p => Number.isFinite(p.y)).map(p => p.y).sort((a, b) => a - b);
    if (!ys.length) return;
    // A pole has no finite vertical extent; trim only its divergent sampled tails.
    const trim = samples.some(item => item.warningCodes?.includes('DISCONTINUITY')) ? Math.floor(ys.length * 0.02) : 0;
    let min = ys[trim], max = ys[ys.length - 1 - trim];
    const pad = max > min ? (max - min) * 0.1 : Math.max(1, Math.abs(min) * 0.1);
    if (!setBounds({ ...bounds, ymin: min - pad, ymax: max + pad })) showError({ code: 'INVALID_RANGE' });
  });
  function localPoint(event) {
    const rect = plot.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * geometry.width / rect.width,
      y: (event.clientY - rect.top) * geometry.height / rect.height };
  }
  function traceAt(point) {
    if (!geometry || !samples?.length || !traceLayer) return;
    const g = geometry; traceLayer.replaceChildren();
    if (point.x < g.left || point.x > g.right || point.y < g.top || point.y > g.bottom) return;
    const ratio = (point.x - g.left) / (g.right - g.left), values = [];
    let x;
    for (const result of samples) {
      const sample = result.points[Math.max(0, Math.min(result.points.length - 1, Math.round(ratio * (result.points.length - 1))))];
      x = sample.x; values.push('f' + (result.slot + 1) + ' ' + (Number.isFinite(sample.y) ? Number(sample.y.toPrecision(6)) : t('未定义', 'undefined')));
      if (Number.isFinite(sample.y) && sample.y >= bounds.ymin && sample.y <= bounds.ymax) traceLayer.append(svg('circle', { cx: g.px(sample.x), cy: g.py(sample.y), r: 4, fill: result.color, stroke: '#fff', 'stroke-width': 1.5 }));
    }
    $('trace').textContent = 'x ' + Number(x.toPrecision(6)) + ' · ' + values.join(' · ');
    traceLayer.append(svg('line', { x1: g.px(x), y1: g.top, x2: g.px(x), y2: g.bottom, class: 'trace-line' }));
  }
  plot.addEventListener('wheel', event => {
    if (!geometry) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 300 : 1;
    zoom(Math.exp(Math.max(-0.6, Math.min(0.6, event.deltaY * scale * 0.002))), localPoint(event));
  }, { passive: false });
  const pointers = new Map(); let gesture = null;
  function beginGesture() {
    const values = [...pointers.values()];
    if (!values.length) { gesture = null; plot.classList.remove('dragging'); return; }
    const center = values.length > 1 ? { x: (values[0].x + values[1].x) / 2, y: (values[0].y + values[1].y) / 2 } : values[0];
    gesture = { bounds: { ...bounds }, center, distance: values.length > 1 ? Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y) : 0, moved: false };
  }
  plot.addEventListener('pointerdown', event => {
    if (!geometry || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault(); plot.focus({ preventScroll: true });
    pointers.set(event.pointerId, localPoint(event)); plot.setPointerCapture(event.pointerId); beginGesture();
    traceAt(localPoint(event));
  });
  plot.addEventListener('pointermove', event => {
    if (!geometry) return;
    const point = localPoint(event);
    if (!pointers.has(event.pointerId)) { if (event.pointerType === 'mouse') traceAt(point); return; }
    pointers.set(event.pointerId, point);
    if (!gesture) return;
    const values = [...pointers.values()], base = gesture.bounds, g = geometry;
    const center = values.length > 1 ? { x: (values[0].x + values[1].x) / 2, y: (values[0].y + values[1].y) / 2 } : values[0];
    let factor = 1;
    if (values.length > 1 && gesture.distance > 0) factor = gesture.distance / Math.max(1, Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y));
    if (!gesture.moved && Math.hypot(center.x - gesture.center.x, center.y - gesture.center.y) < 3 && Math.abs(factor - 1) < 0.015) return;
    gesture.moved = true; plot.classList.add('dragging');
    const xs = base.xmax - base.xmin, ys = base.ymax - base.ymin;
    const anchorX = base.xmin + (gesture.center.x - g.left) / (g.right - g.left) * xs;
    const anchorY = base.ymax - (gesture.center.y - g.top) / (g.bottom - g.top) * ys;
    const xmin = anchorX - (center.x - g.left) / (g.right - g.left) * xs * factor;
    const ymax = anchorY + (center.y - g.top) / (g.bottom - g.top) * ys * factor;
    setBounds({ xmin, xmax: xmin + xs * factor, ymin: ymax - ys * factor, ymax });
  });
  function finishPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    if (!gesture?.moved && geometry) traceAt(localPoint(event));
    pointers.delete(event.pointerId); beginGesture(); persistSoon();
  }
  plot.addEventListener('pointerup', finishPointer); plot.addEventListener('pointercancel', finishPointer);
  plot.addEventListener('lostpointercapture', event => { pointers.delete(event.pointerId); beginGesture(); });
  plot.addEventListener('keydown', event => {
    const key = event.key; if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(key)) return;
    event.preventDefault();
    if (key === 'Home') return resetView();
    if (key === '+' || key === '=') return zoom(0.75);
    if (key === '-') return zoom(1 / 0.75);
    const dx = (bounds.xmax - bounds.xmin) * 0.1 * (key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0);
    const dy = (bounds.ymax - bounds.ymin) * 0.1 * (key === 'ArrowDown' ? -1 : key === 'ArrowUp' ? 1 : 0);
    setBounds({ xmin: bounds.xmin + dx, xmax: bounds.xmax + dx, ymin: bounds.ymin + dy, ymax: bounds.ymax + dy });
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (mode === 'graph') queueGraph(); }).observe(plot);
  else window.addEventListener('resize', () => { if (mode === 'graph') queueGraph(); });
  function actionStatus(message) { $('actionStatus').textContent = message; }
  $('copyResult').addEventListener('click', async () => {
    if ($('copyResult').disabled || !Number.isFinite(ans)) return;
    const text = number(ans), bridge = window.webkit?.messageHandlers?.calculatorCopy;
    try {
      if (bridge) { bridge.postMessage({ text }); return; }
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'calculator-copy', text }, location.origin === 'null' ? '*' : location.origin); return;
      }
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement('textarea'); field.value = text; field.setAttribute('readonly', '');
        field.style.position = 'fixed'; field.style.left = '-9999px'; document.body.append(field); field.select();
        const copied = document.execCommand('copy'); field.remove(); if (!copied) throw Error('Clipboard unavailable');
      }
      actionStatus(t('结果已复制。', 'Result copied.'));
    } catch { actionStatus(t('未能复制；可长按结果选择并复制。', 'Could not copy. Select the result and copy it.')); }
  });
  function exportPayload(payload) {
    const ios = window.webkit?.messageHandlers?.mathLabExport;
    if (ios || window.parent !== window) {
      pendingExport = true; $('exportGraph').disabled = true;
      actionStatus(t('请选择保存位置。', 'Choose a save location.'));
      try {
        if (ios) ios.postMessage(payload);
        else window.parent.postMessage({ type: 'math-lab-export', ...payload }, location.origin === 'null' ? '*' : location.origin);
      } catch (error) { pendingExport = false; throw error; }
      clearTimeout(exportTimer);
      // The save picker can stay open longer than a minute. Keep its request
      // active so the eventual save, cancellation, or error is still handled.
      exportTimer = setTimeout(() => { actionStatus(t('尚未收到保存结果，请检查保存窗口。', 'No save result received yet. Check the save dialog.')); }, 60000);
    } else {
      const a = document.createElement('a'); a.href = 'data:image/png;base64,' + payload.dataBase64;
      a.download = payload.name; document.body.append(a); a.click(); a.remove();
      actionStatus(t('已交给浏览器下载，请在下载位置查看。', 'Sent to the browser. Check your downloads.'));
    }
  }
  window.addEventListener('message', event => {
    const ios = Boolean(window.webkit?.messageHandlers?.mathLabExport);
    if (ios ? event.source !== window && event.source !== window.parent : event.source !== window.parent || event.origin !== location.origin) return;
    if (event.data?.type === 'calculator-copy-result') { actionStatus(event.data.copied ? t('结果已复制。', 'Result copied.') : t('未能复制结果。', 'Could not copy result.')); return; }
    if (event.data?.type === 'math-lab-visibility' && event.data.visible && mode === 'graph') { queueGraph(); return; }
    if (!pendingExport || event.data?.type !== 'math-lab-export-result') return;
    pendingExport = false; clearTimeout(exportTimer); $('exportGraph').disabled = graphDirty || !samples?.length;
    actionStatus(event.data.error ? String(event.data.error).slice(0, 240) : event.data.saved ? t('函数图已保存。', 'Graph saved.') : t('已取消保存。', 'Save canceled.'));
  });
  $('exportGraph').addEventListener('click', async () => {
    if (pendingExport || graphDirty || !samples?.length || !geometry) return;
    $('exportGraph').disabled = true;
    try {
      const g = geometry, width = Math.max(640, Math.min(1200, Math.round(g.width))), scale = width / g.width;
      const chartHeight = Math.round(g.height * scale), lineHeight = 23, legend = [];
      for (const item of samples) {
        const text = 'f' + (item.slot + 1) + '(x) = ' + item.expression;
        const maxChars = Math.max(40, Math.floor((width - 48) / 9));
        for (let start = 0; start < text.length; start += maxChars) legend.push({ color: item.color, text: text.slice(start, start + maxChars) });
      }
      const height = chartHeight + 78 + legend.length * lineHeight;
      const exported = svg('svg', { xmlns: 'http://www.w3.org/2000/svg', width, height, viewBox: '0 0 ' + width + ' ' + height });
      exported.append(svg('rect', { width, height, fill: '#fff' }), svg('text', { x: 24, y: 28, 'font-family': 'sans-serif', 'font-size': 17, fill: '#203731' }, t('函数对照', 'Function comparison') + ' · ' + $('angle').value.toUpperCase()));
      const chart = plot.cloneNode(true); chart.setAttribute('x', '0'); chart.setAttribute('y', '42'); chart.setAttribute('width', width); chart.setAttribute('height', chartHeight);
      chart.removeAttribute('id'); chart.removeAttribute('tabindex'); chart.querySelectorAll('.trace-line').forEach(node => node.parentNode.remove());
      chart.querySelectorAll('text').forEach(node => { node.setAttribute('font-family', 'sans-serif'); node.setAttribute('font-size', '11'); node.setAttribute('fill', '#52655b'); });
      chart.querySelectorAll('.curve').forEach(node => { node.setAttribute('fill', 'none'); node.setAttribute('stroke-width', '2.2'); node.setAttribute('stroke-linejoin', 'round'); });
      exported.append(chart);
      legend.forEach((item, index) => exported.append(svg('text', { x: 24, y: chartHeight + 65 + index * lineHeight, 'font-family': 'monospace', 'font-size': 14, fill: item.color }, item.text)));
      const source = new XMLSerializer().serializeToString(exported), bytes = new TextEncoder().encode(source);
      let binary = ''; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
      const image = new Image(); await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = 'data:image/svg+xml;base64,' + btoa(binary); });
      const canvas = document.createElement('canvas'); canvas.width = width * 2; canvas.height = height * 2;
      const context = canvas.getContext('2d'); if (!context) throw Error('Canvas unavailable');
      context.scale(2, 2); context.drawImage(image, 0, 0, width, height);
      const dataBase64 = canvas.toDataURL('image/png').split(',')[1];
      if (!dataBase64 || dataBase64.length * 3 / 4 > 8 * 1024 * 1024) throw Error('Oversized graph');
      exportPayload({ name: 'Function-comparison.png', mime: 'image/png', dataBase64 });
    } catch { actionStatus(t('导出失败，请重试。', 'Export failed. Please retry.')); }
    finally { if (!pendingExport) $('exportGraph').disabled = graphDirty || !samples?.length; }
  });

  updateAngle(); renderHistory(); updateRanges(); setMode(requestedMode);
  if (mode === 'calc' && lastEvaluation && lastEvaluation.expression === input.value &&
      lastEvaluation.angle === $('angle').value && lastEvaluation.value === ans) {
    $('result').textContent = number(ans); evaluated = true; $('copyResult').disabled = false;
  }
})();
