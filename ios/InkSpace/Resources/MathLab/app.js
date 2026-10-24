/* Offline math workspace. All computation is delegated to MathLabEngine. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const colors = ['#087f7a','#ce6a38','#6564ad','#c04972','#4e829f','#8b7a31','#577847','#966156'];
  const keys = ['functions','calculus','multivariable','statistics','regression','finance'];
  const csvDemo = 'period,income,consumption,price\n1,30,25,8\n2,35,28,9\n3,32,26,7\n4,40,33,10\n5,42,34,9\n6,45,36,12\n7,48,40,10\n8,50,41,11\n9,55,43,13\n10,54,44,11\n11,60,47,12\n12,64,50,14';
  const defaults = {
    functions:{expressions:'sin(x)\nx^2/10',xMin:'-10',xMax:'10',yMin:'',yMax:''},
    calculus:{expression:'sin(x)',point:'1',order:'1',lower:'0',upper:String(Math.PI),xMin:'-1',xMax:'7',yMin:'',yMax:''},
    multivariable:{expression:'x^2+y^2',pointX:'1',pointY:'2',xMin:'-3',xMax:'3',yMin:'-3',yMax:'3'},
    statistics:{csv:csvDemo,header:true,column:'2',timeSeries:false,lag:'5',window:'3',chart:'series',xMin:'',xMax:'',yMin:'',yMax:''},
    regression:{csv:csvDemo,header:true,yColumn:'2',xColumns:[1],intercept:true,robust:false,chart:'fit',xMin:'',xMax:'',yMin:'',yMax:''},
    finance:{mode:'npv',cashflows:'-10000, 3000, 3500, 4200, 2500',rate:'0.08',principal:'300000',annualRate:'0.05',years:'25',paymentsPerYear:'12',face:'1000',couponRate:'0.05',yieldRate:'0.04',bondYears:'10',frequency:'2',spot:'100',strike:'100',optionRate:'0.05',volatility:'0.2',time:'1',dividendYield:'0',riskFree:'0.03',beta:'1.2',marketReturn:'0.08',equity:'600000',debt:'400000',costOfEquity:'0.09',costOfDebt:'0.05',taxRate:'0.25',xMin:'',xMax:'',yMin:'',yMax:''}
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  let state = {schema:'inkspace-mathlab',version:1,activeTab:'functions',language:'zh',parameters:clone(defaults)};
  let result = null, dirty = false, parsedCSV = null, pendingExport = false, exportTimer, chartState, storageUnavailable = false;
  const storeKey = 'inkspace.mathLab.worksheet.v1';
  const T = (zh,en) => state.language === 'en' ? en : zh;
  const labels = () => [T('函数图像','Functions'),T('微积分','Calculus'),T('多元函数','Multivariable'),T('统计 / CSV','Statistics / CSV'),T('回归','Regression'),T('金融','Finance')];
  const p = () => state.parameters[state.activeTab];
  function validateWorksheet(value) {
    if (!value || value.schema !== 'inkspace-mathlab' || value.version !== 1 || !value.parameters) throw new Error(T('这不是受支持的数学工作表。','This is not a supported math worksheet.'));
    const next = {schema:'inkspace-mathlab',version:1,activeTab:keys.includes(value.activeTab)?value.activeTab:'functions',language:value.language==='en'?'en':'zh',parameters:clone(defaults)};
    for (const tab of keys) for (const [key, def] of Object.entries(defaults[tab])) {
      const candidate = value.parameters[tab]?.[key];
      if (candidate === undefined) continue;
      if (Array.isArray(def)) {
        if (!Array.isArray(candidate) || candidate.length > 32 || candidate.some(v=>!Number.isInteger(v)||v<0||v>=64)) throw new Error(T('工作表中的列选择无效。','Invalid column selection in worksheet.'));
        next.parameters[tab][key] = [...new Set(candidate)];
      } else if (typeof candidate !== typeof def || (typeof candidate==='string' && candidate.length>(key==='csv'?2097152:4096))) throw new Error(T('工作表参数的格式或大小无效。','Invalid worksheet parameter type or size.'));
      else next.parameters[tab][key] = candidate;
    }
    return next;
  }
  try { const saved=localStorage.getItem(storeKey); if(saved) state=validateWorksheet(JSON.parse(saved)); } catch (_) { storageUnavailable = true; }
  const lang = new URLSearchParams(location.search).get('lang'); if(lang) state.language=lang==='en'?'en':'zh';
  function persist(){try{localStorage.setItem(storeKey,JSON.stringify(state));storageUnavailable=false;return true;}catch(_){storageUnavailable=true;status(T('输入仍在本次会话中。','Inputs remain in this session.'));return false;}}
  function status(text='',error=false){const node=$('status');if(node){node.textContent=text+(storageUnavailable?' '+T('草稿无法自动保留，请导出工作表后再关闭。','Drafts cannot be retained automatically; export a worksheet before closing.'):'');node.classList.toggle('error',error||storageUnavailable);}}
  function warningText(message){if(state.language==='en')return message;const translations={
    'Undefined values or suspected discontinuities were omitted. Sampling does not prove continuity.':'已跳过无定义或疑似不连续的位置。采样图像不能证明函数连续。',
    'Without an intercept, R-squared uses the uncentered total sum of squares.':'未包含截距：R² 使用未中心化的总平方和，不宜直接与含截距模型的 R² 比较。',
    'HC1 intervals use a Student t reference and are approximate in small samples.':'HC1 区间使用 Student t 参考分布；小样本时仍是近似结果。',
    'The standardized design is poorly conditioned; coefficient precision may be reduced.':'标准化后的设计矩阵条件较差，回归系数的精度可能降低。',
    'AR(1) needs at least four observations to estimate residual uncertainty.':'AR(1) 至少需要 4 个观测值来估计残差的不确定性。',
    'The fitted AR(1) is not stationary (|phi| >= 1); forecast interpretation is limited.':'拟合的 AR(1) 不平稳（|φ| ≥ 1），预测结果的解释受到限制。',
    'AR(1) is undefined for a constant or unresolved lagged series.':'对于常数序列或无法区分的滞后序列，AR(1) 无法定义。',
    'Autocorrelation is undefined for a constant series.':'常数序列的自相关系数无法定义。',
    'IRR is searched only within the selected rate range; numerical root isolation is not a proof of all real roots.':'IRR 仅在指定利率区间内查找；数值求根不保证已找到所有实根。',
    'Cash flows change sign more than once: multiple IRRs may exist; do not assume a unique return.':'现金流多次正负变号，可能存在多个 IRR，不能假定回报率唯一。',
    'No IRR was found in the selected rate range.':'在指定利率区间内未找到 IRR。'
  };return translations[message]||message;}
  function errorText(error){const summaries={INPUT:'输入不符合计算要求',EXPRESSION:'公式无法识别',LIMIT:'输入超出本地计算限制',CSV:'CSV 格式无效',NUMERICAL:'数值计算无法给出可靠结果',CONVERGENCE:'数值计算未收敛',RANK:'回归变量无法独立识别'};return state.language!=='en'&&summaries[error.code]?summaries[error.code]+'。'+error.message:error.message;}
  function num(name){const value=p()[name]; if(typeof value!=='string'||!value.trim()||!Number.isFinite(Number(value))) throw new Error(T('请填写有效数字：','Enter a finite number: ')+name);return Number(value);}
  function bounds(a,b){const min=num(a),max=num(b);if(!(max>min)) throw new Error(T('范围上限必须大于下限。','The upper bound must be greater than the lower bound.'));return [min,max];}
  const fmt=(v,digits=7)=>v==null||!Number.isFinite(v)?'—':Number(v).toLocaleString(state.language==='en'?'en-US':'zh-CN',{maximumSignificantDigits:digits});
  const metric=(name,value,note='')=>({name,value:typeof value==='number'?fmt(value):value??'—',note});
  function field(key,label,options={}){const val=p()[key];return `<label class="field"><span>${esc(label)}</span>${options.textarea?`<textarea name="${key}" rows="${options.rows||3}" spellcheck="false">${esc(val)}</textarea>`:`<input name="${key}" type="${options.type||'text'}" ${options.numeric?'inputmode="decimal"':''} value="${esc(val)}" ${options.placeholder?`placeholder="${esc(options.placeholder)}"`:''}>`}${options.help?`<small>${esc(options.help)}</small>`:''}</label>`;}
  const number=(key,label,help)=>field(key,label,{numeric:true,help});
  const pair=(a,b)=>`<div class="field-row">${a}${b}</div>`;
  function select(key,label,options){return `<label class="field"><span>${esc(label)}</span><select name="${key}">${options.map(([v,l])=>`<option value="${esc(v)}" ${String(p()[key])===String(v)?'selected':''}>${esc(l)}</option>`).join('')}</select></label>`;}
  const check=(key,label)=>`<label class="check"><input type="checkbox" name="${key}" ${p()[key]?'checked':''}>${esc(label)}</label>`;
  function expressionHelp(){return `<details class="help"><summary>${T('公式怎么写','Expression guide')}</summary><p>${T('乘法写成 2*x，乘方写成 x^2。支持 sin、cos、tan、asin、acos、atan、sqrt、exp、log / ln、log10、abs、min、max、pow，以及 pi、e。三角函数使用弧度。','Write multiplication as 2*x and powers as x^2. Supports sin, cos, tan, asin, acos, atan, sqrt, exp, log / ln, log10, abs, min, max, pow, pi and e. Angles are in radians.')}</p></details>`;}
  function csvControls(regression=false){
    const s=p();let html=field('csv',T('粘贴 CSV 数据','Paste CSV data'),{textarea:true,rows:5})+check('header',T('第一行是列名','First row contains column names'))+`<div class="data-actions"><button type="button" data-action="csv-import">${T('导入 CSV','Import CSV')}</button><button type="button" data-action="csv-parse">${T('读取列','Read columns')}</button></div>`;
    if(!parsedCSV) return html+`<p class="hint">${T('更改数据后，点“读取列”选择要分析的列。','After changing data, choose Read columns to select variables.')}</p>`;
    const headers=parsedCSV.headers, options=headers.map((h,i)=>[String(i),h]);
    html+=`<p class="data-summary">${T('数据行','Rows')}: ${parsedCSV.rows.length} · ${T('列','Columns')}: ${headers.length}</p>`;
    if(regression){html+=select('yColumn',T('因变量 Y','Response Y'),options)+`<span class="hint">${T('解释变量 X（可多选）','Predictors X (multiple)')}</span><div class="checks">${headers.map((h,i)=>`<label class="check"><input type="checkbox" name="xColumns" value="${i}" ${s.xColumns.includes(i)?'checked':''} ${String(i)===s.yColumn?'disabled':''}>${esc(h)}</label>`).join('')}</div>`+check('intercept',T('包含截距','Include intercept'))+check('robust',T('HC1 稳健标准误','HC1 robust standard errors'));}
    else {html+=select('column',T('数值列','Numeric column'),options)+check('timeSeries',T('同时分析时间序列','Include time-series analysis'))+(s.timeSeries?pair(number('window',T('移动平均窗口','Moving-average window')),number('lag',T('自相关最大滞后','Maximum ACF lag'))):'');}
    return html;
  }
  function params(){const tab=state.activeTab;let html='';
    if(tab==='functions') html=field('expressions',T('函数 · 每行一个','Functions · one per line'),{textarea:true,rows:4,help:T('使用变量 x；最多 8 个函数。','Use x; up to 8 functions.')})+pair(number('xMin','x '+T('下限','min')),number('xMax','x '+T('上限','max')))+`<div class="examples"><button type="button" data-example="trig">sin / cos</button><button type="button" data-example="market">${T('需求 / 供给','Demand / supply')}</button><button type="button" data-example="singular">1 / x</button></div>`+expressionHelp();
    if(tab==='calculus') html=field('expression','f(x)')+pair(number('point',T('求导位置 x','Derivative at x')),select('order',T('导数阶数','Derivative order'),[['1',T('一阶导数','First derivative')],['2',T('二阶导数','Second derivative')]]))+pair(number('lower',T('积分下限 a','Integral from a')),number('upper',T('积分上限 b','Integral to b')))+`<p class="hint">${T('数值求导与定积分；结果是近似值，不是符号化简。','Numerical derivatives and definite integrals; results are approximations, not symbolic simplifications.')}</p>`+expressionHelp();
    if(tab==='multivariable') html=field('expression',T('表达式或隐式方程','Expression or implicit equation'),{help:'x^2+y^2   /   x^2+y^2=1'})+pair(number('pointX',T('分析点 x','Evaluate at x')),number('pointY',T('分析点 y','Evaluate at y')))+pair(number('xMin','x '+T('下限','min')),number('xMax','x '+T('上限','max')))+pair(number('yMin','y '+T('下限','min')),number('yMax','y '+T('上限','max')))+`<p class="hint">${T('用颜色表示高度 z；输入等式时，深色轮廓线表示方程。支持梯度与 Hessian 矩阵。','Color represents height z; a dark contour traces an equation. Includes gradients and Hessian matrices.')}</p>`+`<div class="examples"><button type="button" data-example="circle">x² + y² = 1</button><button type="button" data-example="surface">${T('曲面热图','Surface heatmap')}</button></div>`+expressionHelp();
    if(tab==='statistics'||tab==='regression') html=csvControls(tab==='regression');
    if(tab==='finance'){
      html=select('mode',T('计算模型','Model'),[['npv',T('现金流 · NPV / IRR','Cash flows · NPV / IRR')],['loan',T('等额还款','Loan payments')],['bond',T('债券估值','Bond valuation')],['option',T('欧式期权 · Black–Scholes','European option · Black–Scholes')],['capm','CAPM'],['wacc','WACC']]);
      if(p().mode==='npv') html+=field('cashflows',T('现金流 · 从第 0 期开始','Cash flows · starting at period 0'),{textarea:true,rows:3,help:T('用逗号、空格或换行分隔；支出填负数。','Separate by commas, spaces or lines; outflows are negative.')})+number('rate',T('每期折现率','Discount rate per period'),'0.08 = 8%');
      if(p().mode==='loan') html+=number('principal',T('贷款本金','Principal'))+number('annualRate',T('名义年利率','Nominal annual rate'),'0.05 = 5%')+pair(number('years',T('年数','Years')),number('paymentsPerYear',T('每年付款次数','Payments / year')));
      if(p().mode==='bond') html+=number('face',T('面值','Face value'))+pair(number('couponRate',T('年票面利率','Annual coupon rate')),number('yieldRate',T('年到期收益率','Annual yield')))+pair(number('bondYears',T('距到期年数','Years to maturity')),number('frequency',T('每年付息次数','Coupons / year')));
      if(p().mode==='capm') html+=number('riskFree',T('无风险利率','Risk-free rate'))+number('beta','β')+number('marketReturn',T('预期市场回报率','Expected market return'));
      if(p().mode==='wacc') html+=pair(number('equity',T('股权市值 E','Market equity E')),number('debt',T('债务市值 D','Market debt D')))+pair(number('costOfEquity',T('股权成本 Re','Cost of equity Re')),number('costOfDebt',T('债务成本 Rd','Cost of debt Rd')))+number('taxRate',T('公司税率 T','Corporate tax rate T'));
      if(p().mode==='option') html+=pair(number('spot',T('标的价格 S','Spot S')),number('strike',T('行权价格 K','Strike K')))+pair(number('optionRate',T('无风险年利率','Risk-free annual rate')),number('dividendYield',T('连续股息率','Continuous dividend yield')))+pair(number('volatility',T('年波动率','Annual volatility')),number('time',T('距到期年数','Years to expiry')));
      html+=`<p class="hint">${T('利率与波动率均用小数：0.05 表示 5%。结果使用输入金额的相同单位。','Rates and volatility use decimals: 0.05 means 5%. Monetary results use the input currency units.')}</p>`;
    }
    return html;
  }
  function renderShell(){
    document.documentElement.lang=state.language==='en'?'en':'zh-Hans';document.title=T('数学工作台 · 人生赢家',"Math workspace · Life's winner");
    $('math-lab').innerHTML=`<header class="topbar"><div><h1>${T('数学工作台','Math workspace')}</h1><p>${T('画图、计算与分析 · 本机离线运行','Plot, calculate and analyze · Runs locally offline')}</p></div><div class="actions"><button type="button" data-action="import">${T('导入工作表','Import worksheet')}</button><button type="button" data-action="worksheet">${T('导出工作表','Export worksheet')}</button><button type="button" data-action="language" aria-label="${T('切换为英语','Switch to Chinese')}">${T('English','中文')}</button></div></header><nav class="tabs" role="tablist" aria-label="${T('计算工具','Calculation tools')}">${keys.map((key,i)=>`<button type="button" class="tab" role="tab" id="tab-${key}" aria-controls="workspace" aria-selected="${state.activeTab===key}" data-tab="${key}">${labels()[i]}</button>`).join('')}</nav><p class="status" id="status" role="status" aria-live="polite"></p><main id="workspace" class="workspace" role="tabpanel" aria-labelledby="tab-${state.activeTab}"></main><input class="file-hidden" id="worksheet-file" type="file" accept=".json,application/json"><input class="file-hidden" id="csv-file" type="file" accept=".csv,text/csv,text/plain">`;
    renderPane();
  }
  function readColumns(announce=false){
    try{parsedCSV=engine().parseCSV(p().csv,{header:p().header});const n=parsedCSV.headers.length;
      if(state.activeTab==='statistics'){if(+p().column>=n)p().column='0';}
      else {if(+p().yColumn>=n)p().yColumn=String(Math.min(1,n-1));p().xColumns=p().xColumns.filter(i=>i<n&&String(i)!==p().yColumn);}
      if(announce)status(T('已读取列。缺失值会明确排除，不会当作 0。','Columns loaded. Missing values are excluded, never treated as zero.'));
      return true;
    }catch(e){parsedCSV=null;status(errorText(e),true);return false;}
  }
  function renderPane(){
    const isCSV=['statistics','regression'].includes(state.activeTab);if(isCSV&&!parsedCSV)readColumns();
    $('workspace').innerHTML=`<form id="parameters" class="parameters"><h2>${labels()[keys.indexOf(state.activeTab)]}</h2><p class="intro">${T('调整参数，再查看结果。','Adjust parameters, then see the results.')}</p>${params()}<button class="primary run" type="submit">${T('计算并更新','Calculate & update')}</button><button type="button" class="run" data-action="example">${T('恢复本页示例','Restore this example')}</button></form><section class="content" aria-label="${T('计算结果','Results')}"><div class="result-head"><h2>${T('结果','Results')}</h2><div class="actions"><button data-action="csv-export" type="button" ${!result||dirty?'disabled':''}>${T('导出 CSV','Export CSV')}</button><button data-action="png-export" type="button" ${!result?.chart||dirty?'disabled':''}>${T('导出图像','Export PNG')}</button></div></div><div id="results"></div><p class="footer-note">${T('工作表保存输入参数；CSV 保存本次结果；图像导出为 PNG。计算在本机完成，不会上传你的数据。','Worksheets contain input parameters; CSV contains the current results; charts export as PNG. Computation stays on your device.')}</p></section>`;
    renderResults();
  }
  function tableHTML(headers,rows,preview=false){return `<div class="table-wrap ${preview?'preview':''}"><table><thead><tr>${headers.map(h=>`<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(v=>`<td>${esc(typeof v==='number'?fmt(v):v??'—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;}
  function chartRanges(){if(state.activeTab==='multivariable')return '';return `<details class="ranges"><summary>${T('调整图像范围','Adjust chart bounds')}</summary><div class="range-fields">${['xMin','xMax','yMin','yMax'].map(key=>field(key,key.replace('Min',T(' 下限',' min')).replace('Max',T(' 上限',' max')),{numeric:true,placeholder:T('自动','Auto')})).join('')}</div><button data-action="chart-range" type="button">${T('更新范围','Update bounds')}</button></details>`;}
  function renderResults(){
    const node=$('results');if(!result){node.innerHTML=`<div class="empty-result"><strong>${T('准备好探索了吗？','Ready to explore?')}</strong>${T('填写左侧参数，点击“计算并更新”。','Enter parameters and choose Calculate & update.')}</div>`;return;}
    node.innerHTML=(dirty?`<div class="notice warning">${T('输入已更改。当前是上一次的结果，请重新计算。','Inputs changed. These are the previous results; calculate again.')}</div>`:'')+(result.notices||[]).map(n=>`<div class="notice ${n.warning?'warning':''}">${esc(n.text||n)}</div>`).join('')+(result.metrics?.length?`<dl class="metrics">${result.metrics.map(m=>`<div class="metric"><dt>${esc(m.name)}</dt><dd>${esc(m.value)}${m.note?`<small>${esc(m.note)}</small>`:''}</dd></div>`).join('')}</dl>`:'')+(result.chart?`<div class="chart-panel"><div class="chart-header"><strong>${esc(result.chart.title)}</strong>${state.activeTab==='regression'?select('chart','',[['fit',T('观测值与拟合值','Observed & fitted')],['residual',T('残差图','Residual plot')]]):''}${state.activeTab==='statistics'&&p().timeSeries?select('chart','',[['series',T('序列 / 移动平均','Series / rolling mean')],['acf',T('自相关 ACF','Autocorrelation ACF')]]):''}</div><div class="chart-wrap"><canvas id="plot" aria-label="${esc(result.chart.title)}" role="img"></canvas></div><div id="legend" class="legend"></div><div class="cursor-readout" id="coordinates"></div>${chartRanges()}</div>`:'')+(result.table?`<h3>${esc(result.table.title||'')}</h3>${tableHTML(result.table.headers,result.table.rows)}`:'')+(result.preview?`<details class="help"><summary>${T('数据预览（前 8 行）','Data preview (first 8 rows)')}</summary>${tableHTML(result.preview.headers,result.preview.rows,true)}</details>`:'');
    if(result.chart)requestAnimationFrame(drawChart);
  }
  function engine(){if(!window.MathLabEngine)throw new Error(T('本地计算组件尚未加载，请重新打开工作台。','The local calculation component did not load. Reopen the workspace.'));return window.MathLabEngine;}
  function getChartSample(expression,min,max){return engine().sample(expression,{min,max,count:801});}
  function calculate(){
    try {const E=engine(),s=p(),tab=state.activeTab;let next={metrics:[],notices:[],csvRows:[]};
      if(tab==='functions'){
        const [min,max]=bounds('xMin','xMax'),exprs=s.expressions.split('\n').map(x=>x.trim()).filter(Boolean);if(!exprs.length||exprs.length>8)throw new Error(T('请填写 1 至 8 个函数。','Enter 1 to 8 functions.'));
        const samples=exprs.map(expression=>({expression,...getChartSample(expression,min,max)}));
        next.chart={title:T('函数图像','Function plots'),series:samples.map((sample,i)=>({name:sample.expression,segments:sample.segments,color:colors[i]})),xBounds:[min,max]};
        next.csvRows=[['x',...exprs],...samples[0].points.map((pt,i)=>[pt.x,...samples.map(sample=>sample.points[i].y)])];
        next.notices=[{text:T('图像按离散点采样；渐近线附近或窄小区间可能遗漏细节，不能据此证明连续性。','Plots use discrete samples. Fine features and behavior near asymptotes may be missed; sampling does not prove continuity.')}];
        samples.forEach(v=>v.warnings.forEach(w=>next.notices.push({text:warningText(w),warning:true})));
      } else if(tab==='calculus'){
        const x=num('point'),der=E.derivative(s.expression,x,{order:Number(s.order)}),integral=E.integrate(s.expression,num('lower'),num('upper'));
        next.metrics=[metric(s.order==='2'?"f″(x)":"f′(x)",der.value,T('数值近似','Numerical approximation')),metric(T('导数误差估计','Derivative error estimate'),der.errorEstimate),metric(T('定积分','Definite integral'),integral.value),metric(T('积分误差估计','Integral error estimate'),integral.errorEstimate)];
        const [min,max]=bounds('xMin','xMax'),sample=getChartSample(s.expression,min,max);next.chart={title:s.expression,series:[{name:'f(x)',segments:sample.segments}],xBounds:[min,max]};
        next.notices=[{text:T('仅支持有限闭区间上的连续函数定积分；不计算无穷区间、奇点积分或主值。误差是算法估计，不是严格上界。','Definite integration requires a continuous function on a finite closed interval. Improper, singular and principal-value integrals are unsupported. Error estimates are not rigorous bounds.')}];
        next.csvRows=[['quantity','value'],['derivative',der.value],['derivative_error_estimate',der.errorEstimate],['integral',integral.value],['integral_error_estimate',integral.errorEstimate]];
      } else if(tab==='multivariable'){
        const [xmin,xmax]=bounds('xMin','xMax'),[ymin,ymax]=bounds('yMin','yMax'),formula=multivariableFormula(s.expression),f=E.compile(formula.expression,['x','y']),diff=E.gradientHessian(formula.expression,{x:num('pointX'),y:num('pointY')}),cells=[],rows=[['x','y','z']];let missing=0;
        for(let j=0;j<51;j++)for(let i=0;i<51;i++){const x=xmin+(xmax-xmin)*i/50,y=ymin+(ymax-ymin)*j/50,z=f({x,y}),value=Number.isFinite(z)?z:null;if(value===null)missing++;cells.push({x,y,z:value});rows.push([x,y,value]);}
        if(missing===cells.length)throw new Error(T('所选范围内没有有限函数值。','No finite function values in this range.'));
        next.chart={title:formula.implicit?T('隐式方程 · 数值零等高线','Implicit equation · numerical zero contour'):T('高度热图 · 颜色表示 z','Height heatmap · color represents z'),implicit:formula.implicit,heatmap:cells,xBounds:[xmin,xmax],yBounds:[ymin,ymax],grid:51};
        next.metrics=[metric(formula.implicit?'F(x,y) − G(x,y)':'f(x, y)',diff.value),metric('∂f / ∂x',diff.gradient.x),metric('∂f / ∂y',diff.gradient.y)];
        next.table={title:T('Hessian 矩阵 · 数值近似','Hessian matrix · numerical approximation'),headers:['','∂ / ∂x','∂ / ∂y'],rows:[['∂ / ∂x',...diff.hessian[0]],['∂ / ∂y',...diff.hessian[1]]]};
        next.notices=[{text:T('热图使用 51 × 51 网格；白色格子表示函数在该点无定义或超出数值范围。梯度和 Hessian 为局部数值近似。','The heatmap uses a 51 × 51 grid. White cells are undefined or out of numeric range. Gradient and Hessian are local numerical approximations.')+(missing?` ${T('无效格点','Invalid grid points')}: ${missing}`:'')}];if(formula.implicit)next.notices.push({text:T('等式两边相减得到残差；深色线是残差为 0 的数值轮廓，局部梯度与 Hessian 也针对这个残差。有限网格可能遗漏很小的环或孤立解。','The two sides are subtracted to form a residual. The dark line is its numerical zero contour; derivatives also refer to this residual. A finite grid may miss tiny loops or isolated solutions.')});next.csvRows=rows;
      } else if(tab==='statistics') {
        if(!readColumns())return;const col=parsedCSV.numericColumns[Number(s.column)];if(!col)throw new Error(T('请选择数值列。','Select a numeric column.'));
        const values=col.values.filter(v=>v!==null),d=E.describe(values),excluded=col.values.length-values.length;
        next.metrics=[metric(T('有效数据','Valid rows'),d.count),metric(T('均值','Mean'),d.mean),metric(T('中位数','Median'),d.median),metric(T('样本标准差','Sample SD'),d.sampleStdDev),metric(T('最小值','Minimum'),d.min),metric(T('最大值','Maximum'),d.max),metric('Q1',d.q1),metric('Q3',d.q3)];
        next.notices=[{text:`${T('已排除','Excluded')} ${excluded} ${T('行（空白或非数值），未按 0 处理。分位数使用线性插值；标准差使用 n−1。','rows with missing/non-numeric values, not replaced by zero. Quantiles use linear interpolation; sample SD uses n−1.')}`,warning:excluded>0}];
        next.chart={title:col.name,series:[{name:col.name,points:col.values.map((v,i)=>({x:i+1,y:v})),color:colors[0]}]};
        next.csvRows=[['quantity','value'],...Object.entries(d)];
        if(s.timeSeries){if(excluded)throw new Error(T('时间序列需要等间隔且完整的数值。当前列有缺失或非数值行；请先修复数据，避免把时间间隔拼接。关闭“同时分析时间序列”可做描述统计。','Time-series analysis requires complete, equally spaced values. Resolve missing/non-numeric rows first so time gaps are not silently joined. Disable time-series analysis for descriptive statistics.'));
          const ts=E.timeSeries(values,{lag:num('lag'),window:num('window')});next.timeSeries=ts;next.values=values;next.columnName=col.name;
          next.notices.push({text:T('按 CSV 行顺序、等间隔观测分析。AR(1) 是简单的一步预测，不检验平稳性，不保证预测准确。','Rows are treated as equally spaced observations in CSV order. AR(1) is a simple one-step forecast; stationarity is not tested and forecast accuracy is not guaranteed.')});
          ts.warnings.forEach(w=>next.notices.push({text:warningText(w),warning:true}));if(ts.ar1)next.metrics.push(metric('AR(1) φ',ts.ar1.phi),metric(T('下一期预测','Next-period forecast'),ts.ar1.forecast));
          next.csvRows=[['period','value','rolling_mean','difference'],...values.map((v,i)=>[i+1,v,ts.rollingMean[i],i?ts.differences[i-1]:null])];setStatsChart(next);
        }
        next.preview={headers:parsedCSV.headers,rows:parsedCSV.rows.slice(0,8)};
      } else if(tab==='regression'){
        if(!readColumns())return;const yi=Number(s.yColumn),xs=s.xColumns.filter(i=>i!==yi);if(!xs.length)throw new Error(T('请至少选择一个解释变量 X。','Choose at least one predictor X.'));
        const columns=parsedCSV.numericColumns,keep=parsedCSV.rows.map((_,i)=>i).filter(i=>[yi,...xs].every(c=>columns[c]?.values[i]!=null)),y=keep.map(i=>columns[yi].values[i]),X=keep.map(i=>xs.map(c=>columns[c].values[i])),fit=E.ols(y,X,{intercept:s.intercept,robust:s.robust});
        const names=[...(s.intercept?[T('截距','Intercept')]:[]),...xs.map(i=>parsedCSV.headers[i])];next.fit=fit;next.x=X;next.y=y;next.xName=parsedCSV.headers[xs[0]];next.yName=parsedCSV.headers[yi];
        next.metrics=[metric('R²',fit.rSquared),metric(T('调整 R²','Adjusted R²'),fit.adjustedRSquared),metric(T('有效行数','Rows used'),fit.n),metric(T('残差自由度','Residual df'),fit.dfResidual)];
        next.table={title:s.robust?T('系数 · HC1 稳健标准误','Coefficients · HC1 robust SE'):T('系数 · 常规标准误','Coefficients · conventional SE'),headers:[T('变量','Variable'),T('系数','Coefficient'),'SE','t','95% CI '+T('下限','lower'),'95% CI '+T('上限','upper')],rows:names.map((name,i)=>[name,fit.coefficients[i],fit.standardErrors[i],fit.tStatistics[i],...(fit.confidenceIntervals95[i]||[null,null])])};
        next.notices=[{text:`${T('完整配对行','Complete paired rows')}: ${keep.length} / ${parsedCSV.rows.length}. ${T('缺失或非数值行已剔除。置信区间使用 Student t；相关关系不代表因果关系。','Missing/non-numeric rows are excluded. Confidence intervals use Student t; association does not establish causation.')}`,warning:keep.length<parsedCSV.rows.length},...fit.warnings.map(w=>({text:warningText(w),warning:true}))];
        if(xs.length>1)next.notices.push({text:T('图中横轴是第一个解释变量；拟合值同时包含所有所选变量的影响，因此不会连成一条直线。','The chart uses the first predictor on the x-axis. Fitted values include all selected predictors, so they need not form a straight line.')});
        next.csvRows=[['row',next.yName,'fitted','residual',...xs.map(i=>parsedCSV.headers[i])],...y.map((v,i)=>[keep[i]+1,v,fit.fitted[i],fit.residuals[i],...X[i]])];next.preview={headers:parsedCSV.headers,rows:parsedCSV.rows.slice(0,8)};setRegressionChart(next);
      } else if(tab==='finance')next=financeResult(E);
      result=next;dirty=false;persist();status(T('已计算。结果基于当前输入。','Calculated using the current inputs.'));renderPane();
    }catch(e){result=null;dirty=false;renderPane();$('results').innerHTML=`<div class="notice error" role="alert">${esc(T('未能计算：','Could not calculate: ')+errorText(e))}</div>`;status(T('请检查输入与模型适用范围。','Check the inputs and model assumptions.'),true);}
  }
  function multivariableFormula(source){const parts=source.split('=');if(parts.length===1)return {expression:source,implicit:false};if(parts.length!==2||parts.some(v=>!v.trim()))throw new Error(T('等式格式应为：x^2+y^2=1。','Use an equation such as x^2+y^2=1.'));return {expression:'('+parts[0]+')-('+parts[1]+')',implicit:true};}
  function setStatsChart(r){r.chart=p().chart==='acf'?{title:T('自相关 ACF','Autocorrelation ACF'),series:[{name:'ACF',points:r.timeSeries.acf.map((v,i)=>({x:i,y:v})),scatter:true}],yBounds:[-1,1]}:{title:r.columnName,series:[{name:r.columnName,points:r.values.map((v,i)=>({x:i+1,y:v}))},{name:T('移动平均','Rolling mean'),points:r.timeSeries.rollingMean.map((v,i)=>({x:i+1,y:v})),color:colors[1]}]};}
  function setRegressionChart(r){r.chart=p().chart==='residual'?{title:T('残差与拟合值','Residuals vs fitted values'),xLabel:T('拟合值','Fitted'),yLabel:T('残差','Residual'),series:[{name:T('残差','Residual'),points:r.fit.residuals.map((v,i)=>({x:r.fit.fitted[i],y:v})),scatter:true}]}:{title:r.yName+' / '+r.xName,xLabel:r.xName,yLabel:r.yName,series:[{name:T('观测值','Observed'),points:r.y.map((v,i)=>({x:r.x[i][0],y:v})),scatter:true},{name:T('拟合值','Fitted'),points:r.fit.fitted.map((v,i)=>({x:r.x[i][0],y:v})),scatter:true,color:colors[1]}]};}
  function financeResult(E){const s=p(),r={metrics:[],notices:[],csvRows:[]};
    if(s.mode==='npv'){
      const input=s.cashflows.trim(),hasComma=/[,，]/.test(input),tokens=hasComma?input.split(/[,，]/).map(v=>v.trim()):input.split(/\s+/);if(hasComma&&tokens.some(v=>!v||/\s/.test(v)))throw new Error(T('逗号之间必须有一个数字；缺失期请显式输入 0，不能留空。','Each comma-separated period needs one number. Enter 0 explicitly for a zero cash flow; do not leave missing periods.'));if(tokens.some(v=>!v.trim()||!Number.isFinite(Number(v))))throw new Error(T('现金流必须全部是数字。','Every cash flow must be a finite number.'));const cash=tokens.map(Number),npv=E.npv(num('rate'),cash),irr=E.irr(cash);
      r.metrics=[metric('NPV',npv),metric(T('找到的 IRR','IRR roots found'),irr.roots.length?irr.roots.map(v=>fmt(v*100)+'%').join(' · '):T('未找到','None found')),metric(T('期数（含第 0 期）','Periods (including t=0)'),cash.length)];
      r.notices=[{text:T('第 0 期立即发生；后续现金流等间隔。IRR 仅在 −99.99% 至 10,000% 的每期利率范围内查找；“未找到”不证明不存在其他根。不支持不规则日期的 XIRR。','Cash flow 0 occurs now; subsequent periods are equally spaced. IRR searches periodic rates from −99.99% to 10,000%; no root found does not prove none exists elsewhere. Irregular-date XIRR is unsupported.')},...irr.warnings.map(w=>({text:warningText(w),warning:true}))];
      r.chart={title:T('每期现金流','Cash flows by period'),series:[{name:T('现金流','Cash flow'),points:cash.map((v,i)=>({x:i,y:v})),scatter:true}]};r.csvRows=[['quantity','period','value'],['NPV','',npv],...irr.roots.map((v,i)=>['IRR',i+1,v]),...cash.map((v,i)=>['cashflow',i,v])];
    } else if(s.mode==='loan'){
      const v=E.loanPayment(num('principal'),num('annualRate'),num('years'),{paymentsPerYear:num('paymentsPerYear')});r.metrics=[metric(T('每期还款','Payment per period'),v.payment),metric(T('总利息','Total interest'),v.totalInterest),metric(T('总还款','Total paid'),v.totalPaid),metric(T('付款期数','Payment periods'),v.periods)];r.notices=[{text:T('固定名义利率、期末等额付款；不含手续费、税费或提前还款。','Fixed nominal interest with equal end-of-period payments; excludes fees, taxes and prepayments.')}];r.csvRows=[['quantity','value'],...Object.entries(v)];
    } else if(s.mode==='bond'){
      const config={face:num('face'),couponRate:num('couponRate'),yieldRate:num('yieldRate'),years:num('bondYears'),frequency:num('frequency')},v=E.bondPV(config);r.metrics=[metric(T('债券价格','Bond price'),v.price),metric(T('麦考利久期','Macaulay duration'),v.macaulayDuration,T('年','Years')),metric(T('修正久期','Modified duration'),v.modifiedDuration),metric(T('凸性','Convexity'),v.convexity)];r.notices=[{text:T('固定票息、规则付息、期末兑付，不计应计利息与信用违约。收益率为名义年利率。','Fixed regular coupons and redemption at maturity, excluding accrued interest and credit default. Yield is a nominal annual rate.')}];r.csvRows=[['quantity','value'],...Object.entries(v)];
    } else if(s.mode==='option'){
      const config={spot:num('spot'),strike:num('strike'),rate:num('optionRate'),volatility:num('volatility'),time:num('time'),dividendYield:num('dividendYield')},v=E.blackScholes(config);r.metrics=[metric(T('看涨期权','Call'),v.call),metric(T('看跌期权','Put'),v.put),metric('Call Δ',v.callDelta),metric('Put Δ',v.putDelta),metric('Γ',v.gamma),metric('Vega',v.vega,T('波动率变化 1.0','Per 1.0 volatility')),metric('Call Θ',v.callTheta,T('每年','Per year')),metric('Put Θ',v.putTheta,T('每年','Per year'))];r.notices=[{text:T('仅欧式期权；假设波动率与利率恒定、连续股息、无摩擦交易。不是美式期权模型。Vega 以波动率变动 1.0 为单位，Theta 以年为单位；边界处未定义的希腊值显示 —。','European options only, assuming constant volatility/rates, continuous dividends and frictionless trading. Not an American-option model. Vega is per 1.0 volatility, theta per year; undefined boundary Greeks display —.')}];r.csvRows=[['quantity','value'],...Object.entries(v)];
      const points=Array.from({length:101},(_,i)=>{const spot=config.spot*(.25+1.5*i/100);return {spot,...E.blackScholes({...config,spot})};});r.chart={title:T('期权价格随标的价格变化','Option value vs spot'),xLabel:T('标的价格','Spot'),series:[{name:T('看涨','Call'),points:points.map(v=>({x:v.spot,y:v.call}))},{name:T('看跌','Put'),points:points.map(v=>({x:v.spot,y:v.put})),color:colors[1]}]};
    }else if(s.mode==='capm'){const v=E.capm({riskFree:num('riskFree'),beta:num('beta'),marketReturn:num('marketReturn')});r.metrics=[metric(T('股权成本 Re','Cost of equity Re'),fmt(v.costOfEquity*100)+'%'),metric(T('市场风险溢价','Market risk premium'),fmt(v.premium*100)+'%')];r.notices=[{text:T('Re = Rf + β × (Rm − Rf)。输入应使用一致的期限与市场口径；模型不保证实际收益。','Re = Rf + β × (Rm − Rf). Use consistent horizons and market definitions; this model does not guarantee realized returns.')}];r.csvRows=[['quantity','value'],...Object.entries(v)];
    }else if(s.mode==='wacc'){const v=E.wacc({equity:num('equity'),debt:num('debt'),costOfEquity:num('costOfEquity'),costOfDebt:num('costOfDebt'),taxRate:num('taxRate')});r.metrics=[metric('WACC',fmt(v.rate*100)+'%'),metric(T('股权权重','Equity weight'),fmt(v.equityWeight*100)+'%'),metric(T('债务权重','Debt weight'),fmt(v.debtWeight*100)+'%')];r.notices=[{text:T('WACC = E/(E+D) × Re + D/(E+D) × Rd × (1−T)。权重使用股权与债务的市值；假设税盾可使用，不含优先股。','WACC = E/(E+D) × Re + D/(E+D) × Rd × (1−T). Weights use market values of equity and debt; assumes a usable tax shield and excludes preferred shares.')}];r.csvRows=[['quantity','value'],...Object.entries(v)];
    }else throw new Error(T('请选择支持的模型。','Choose a supported model.'));return r;
  }
  function finiteRange(values){let min=Infinity,max=-Infinity;for(const v of values)if(Number.isFinite(v)){min=Math.min(min,v);max=Math.max(max,v);}if(!Number.isFinite(min))return [-1,1];if(min===max){const pad=Math.max(1,Math.abs(min)*.1);return [min-pad,max+pad];}return [min,max];}
  function chosenRange(key,fallback,padding=false){let [min,max]=fallback;if(padding){const pad=(max-min)*.07;min-=pad;max+=pad;}for(const [i,suffix]of ['Min','Max'].entries()){const raw=p()[key+suffix];if(raw!==undefined&&String(raw).trim()){const v=Number(raw);if(!Number.isFinite(v))throw new Error(T('图像范围必须是有限数字。','Chart bounds must be finite numbers.'));if(i)max=v;else min=v;}}if(!(max>min))throw new Error(T('图像范围上限必须大于下限。','Chart upper bounds must exceed lower bounds.'));return [min,max];}
  function drawChart(){
    const canvas=$('plot');if(!canvas||!result?.chart)return;
    try{
      const spec=result.chart,rect=canvas.getBoundingClientRect(),width=Math.max(rect.width,220),height=Math.max(rect.height,220),dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas unavailable');ctx.scale(dpr,dpr);ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
      const pad={left:64,right:spec.heatmap?72:24,top:22,bottom:45};let pw=width-pad.left-pad.right,ph=height-pad.top-pad.bottom;if(spec.implicit){const unit=Math.min(pw/(spec.xBounds[1]-spec.xBounds[0]),ph/(spec.yBounds[1]-spec.yBounds[0])),adjusted=unit*(spec.xBounds[1]-spec.xBounds[0]);pad.left+=(pw-adjusted)/2;pw=adjusted;ph=unit*(spec.yBounds[1]-spec.yBounds[0]);}
      const points=(spec.series||[]).flatMap(v=>v.points||v.segments?.flat()||[]),xb=spec.heatmap?spec.xBounds:chosenRange('x',spec.xBounds||finiteRange(points.map(v=>v.x)),!spec.xBounds),yb=spec.heatmap?spec.yBounds:chosenRange('y',spec.yBounds||finiteRange(points.map(v=>v.y)),!spec.yBounds);
      const tx=x=>pad.left+(x-xb[0])/(xb[1]-xb[0])*pw,ty=y=>pad.top+ph-(y-yb[0])/(yb[1]-yb[0])*ph;
      ctx.font='11px -apple-system, sans-serif';ctx.lineWidth=1;ctx.textBaseline='middle';
      for(let i=0;i<=5;i++){const x=xb[0]+(xb[1]-xb[0])*i/5,y=yb[0]+(yb[1]-yb[0])*i/5;ctx.strokeStyle='#e9efec';ctx.beginPath();ctx.moveTo(tx(x),pad.top);ctx.lineTo(tx(x),pad.top+ph);ctx.moveTo(pad.left,ty(y));ctx.lineTo(pad.left+pw,ty(y));ctx.stroke();ctx.fillStyle='#60736e';ctx.textAlign='center';ctx.fillText(fmt(x,4),tx(x),pad.top+ph+18);ctx.textAlign='right';ctx.fillText(fmt(y,4),pad.left-9,ty(y));}
      ctx.save();ctx.beginPath();ctx.rect(pad.left,pad.top,pw,ph);ctx.clip();
      if(spec.heatmap){
        const [zmin,zmax]=finiteRange(spec.heatmap.map(c=>c.z)),n=spec.grid,cellW=pw/(n-1),cellH=ph/(n-1);
        for(const cell of spec.heatmap)if(cell.z!==null){const t=Math.max(0,Math.min(1,(cell.z-zmin)/(zmax-zmin)));ctx.fillStyle=`hsl(${220-190*t} 62% ${76-32*t}%)`;ctx.fillRect(tx(cell.x)-cellW/2,ty(cell.y)-cellH/2,cellW+1,cellH+1);}
        // Marching squares with interpolated edge crossings; zero contour exposes implicit equations.
        ctx.strokeStyle=spec.implicit?'#1c252c':'#fff';ctx.lineWidth=spec.implicit?2.6:1.6;ctx.beginPath();
        for(let j=0;j<n-1;j++)for(let i=0;i<n-1;i++){
          const c=[spec.heatmap[j*n+i],spec.heatmap[j*n+i+1],spec.heatmap[(j+1)*n+i+1],spec.heatmap[(j+1)*n+i]];if(c.some(v=>v.z===null))continue;
          const crossings=[];for(let k=0;k<4;k++){const a=c[k],b=c[(k+1)%4];if((a.z<=0&&b.z>0)||(a.z>0&&b.z<=0)){const t=-a.z/(b.z-a.z);crossings.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});}}
          if(crossings.length===2){ctx.moveTo(tx(crossings[0].x),ty(crossings[0].y));ctx.lineTo(tx(crossings[1].x),ty(crossings[1].y));}else if(crossings.length===4){const average=c.reduce((sum,v)=>sum+v.z,0)/4,pairing=(average>0)===(c[0].z>0)?[[0,1],[2,3]]:[[0,3],[1,2]];for(const [a,b]of pairing){ctx.moveTo(tx(crossings[a].x),ty(crossings[a].y));ctx.lineTo(tx(crossings[b].x),ty(crossings[b].y));}}
        }ctx.stroke();ctx.restore();
        const gx=pad.left+pw+18,gradient=ctx.createLinearGradient(0,pad.top+ph,0,pad.top);for(let i=0;i<=10;i++){const t=i/10;gradient.addColorStop(t,`hsl(${220-190*t} 62% ${76-32*t}%)`);}ctx.fillStyle=gradient;ctx.fillRect(gx,pad.top,10,ph);ctx.textAlign='left';ctx.fillStyle='#60736e';ctx.fillText(fmt(zmax,3),gx+14,pad.top+6);ctx.fillText(fmt(zmin,3),gx+14,pad.top+ph-6);
        $('legend').innerHTML=`<span>${esc(spec.implicit?T('深色线：方程的数值零等高线','Dark line: numerical zero contour'):T('白线：f(x,y) = 0','White line: f(x,y) = 0'))}</span>`;
      } else {
        if(yb[0]<=0&&yb[1]>=0){ctx.strokeStyle='#a9bcb4';ctx.beginPath();ctx.moveTo(pad.left,ty(0));ctx.lineTo(pad.left+pw,ty(0));ctx.stroke();}
        if(xb[0]<=0&&xb[1]>=0){ctx.strokeStyle='#a9bcb4';ctx.beginPath();ctx.moveTo(tx(0),pad.top);ctx.lineTo(tx(0),pad.top+ph);ctx.stroke();}
        spec.series.forEach((series,index)=>{ctx.strokeStyle=series.color||colors[index%colors.length];ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=2;
          if(series.scatter){for(const point of series.points||[]){if(!Number.isFinite(point.x)||!Number.isFinite(point.y))continue;ctx.beginPath();ctx.arc(tx(point.x),ty(point.y),3.3,0,Math.PI*2);ctx.fill();}}
          else for(const segment of series.segments||[series.points||[]]){ctx.beginPath();let started=false;for(const point of segment){if(!Number.isFinite(point.x)||!Number.isFinite(point.y)){started=false;continue;}if(started)ctx.lineTo(tx(point.x),ty(point.y));else ctx.moveTo(tx(point.x),ty(point.y));started=true;}ctx.stroke();}
        });ctx.restore();$('legend').innerHTML=spec.series.map((s,i)=>`<span><i class="swatch" style="background:${colors.includes(s.color)?s.color:colors[i%colors.length]}"></i>${esc(s.name)}</span>`).join('');
      }
      ctx.strokeStyle='#b9cbc3';ctx.strokeRect(pad.left,pad.top,pw,ph);ctx.fillStyle='#526b62';ctx.textAlign='center';ctx.fillText(spec.xLabel||'x',pad.left+pw/2,height-7);ctx.save();ctx.translate(13,pad.top+ph/2);ctx.rotate(-Math.PI/2);ctx.fillText(spec.yLabel||'y',0,0);ctx.restore();
      chartState={xb,yb,pad,pw,ph};canvas.onpointermove=e=>{const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(x<pad.left||x>pad.left+pw||y<pad.top||y>pad.top+ph){$('coordinates').textContent='';return;}$('coordinates').textContent=`x ${fmt(xb[0]+(x-pad.left)/pw*(xb[1]-xb[0]))}  ·  y ${fmt(yb[1]-(y-pad.top)/ph*(yb[1]-yb[0]))}`;};canvas.onpointerleave=()=>{$('coordinates').textContent='';};
    }catch(e){status(errorText(e),true);chartState=null;}
  }
  function markDirty(){if(result&&!dirty){dirty=true;const warning=document.createElement('div');warning.className='notice warning';warning.textContent=T('输入已更改。当前是上一次的结果，请重新计算。','Inputs changed. These are the previous results; calculate again.');$('results').prepend(warning);document.querySelectorAll('[data-action="csv-export"],[data-action="png-export"]').forEach(v=>v.disabled=true);}persist();}
  const encodeBase64=bytes=>{let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(binary);};
  function textPayload(name,mime,text){return {name,mime,dataBase64:encodeBase64(new TextEncoder().encode(text))};}
  function exportPayload(payload){
    const size=payload.dataBase64.length*3/4;if(size>8*1024*1024)throw new Error(T('导出内容超过 8 MB；请减少数据后再试。','Export exceeds 8 MB; reduce the data and try again.'));
    if(pendingExport){status(T('请先完成当前的保存对话框。','Finish the current save dialog first.'));return;}
    const ios=window.webkit?.messageHandlers?.mathLabExport;
    if(ios||window.parent!==window){pendingExport=true;status(T('等待选择保存位置…','Waiting for a save location…'));try{if(ios)ios.postMessage(payload);else window.parent.postMessage({type:'math-lab-export',...payload},location.origin==='null'?'*':location.origin);}catch(e){pendingExport=false;throw e;}clearTimeout(exportTimer);exportTimer=setTimeout(()=>{pendingExport=false;status(T('尚未收到保存结果；请检查保存对话框。','No save result received yet; check the save dialog.'));},60000);}
    else {const binary=atob(payload.dataBase64),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:payload.mime})),a=document.createElement('a');a.href=url;a.download=payload.name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);status(T('已交给浏览器下载，请在下载位置查看。','Sent to the browser; check your downloads.'));}
  }
  window.addEventListener('message',e=>{if(e.data?.type==='math-lab-visibility'&&e.data.visible===true&&e.source===window.parent&&e.origin===location.origin){requestAnimationFrame(drawChart);return;}if(!pendingExport||e.data?.type!=='math-lab-export-result')return;const isIOS=Boolean(window.webkit?.messageHandlers?.mathLabExport);if(isIOS){if(e.source!==window&&e.source!==window.parent)return;}else if(e.source!==window.parent||e.origin!==location.origin)return;pendingExport=false;clearTimeout(exportTimer);status(e.data.error?String(e.data.error):e.data.saved?T('已保存。','Saved.'):T('已取消保存。','Save canceled.'),Boolean(e.data.error));});
  function csvText(rows){return '\uFEFF'+rows.map(row=>row.map(value=>{let text=value==null?'':String(value);if(typeof value==='string'&&/^[=+@\-\t\r]/.test(text))text="'"+text;return /[",\n\r]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;}).join(',')).join('\r\n');}
  document.addEventListener('submit',e=>{if(e.target.id==='parameters'){e.preventDefault();calculate();}});
  document.addEventListener('input',e=>{const el=e.target,key=el.name;if(!key||!Object.prototype.hasOwnProperty.call(p(),key)||el.type==='checkbox'||el.tagName==='SELECT')return;p()[key]=el.value;if(key==='csv')parsedCSV=null;markDirty();});
  document.addEventListener('change',e=>{const el=e.target,key=el.name;if(el.id==='worksheet-file'||el.id==='csv-file'){void importFile(el);return;}if(!key||!Object.prototype.hasOwnProperty.call(p(),key))return;
    if(key==='xColumns'){p().xColumns=Array.from(document.querySelectorAll('input[name="xColumns"]:checked')).map(v=>Number(v.value));}
    else if(el.type==='checkbox')p()[key]=el.checked;else p()[key]=el.value;
    if(key==='chart'&&result&&!dirty){if(state.activeTab==='regression')setRegressionChart(result);else if(result.timeSeries)setStatsChart(result);persist();renderResults();return;}
    if(key==='header'){parsedCSV=null;readColumns();}
    if(key==='yColumn')p().xColumns=p().xColumns.filter(i=>String(i)!==p().yColumn);
    markDirty();if(['header','yColumn','timeSeries','mode'].includes(key))renderPane();
  });
  document.addEventListener('click',e=>{const button=e.target.closest('button');if(!button||button.disabled)return;try{
    if(button.dataset.tab){state.activeTab=button.dataset.tab;result=null;dirty=false;parsedCSV=null;persist();renderShell();calculate();return;}
    if(button.dataset.example){const kind=button.dataset.example;if(kind==='circle'||kind==='surface'){Object.assign(p(),{expression:kind==='circle'?'x^2+y^2=1':'sin(x)*cos(y)',pointX:'0.5',pointY:'0.5',xMin:'-3',xMax:'3',yMin:'-3',yMax:'3'});renderPane();calculate();return;}Object.assign(p(),kind==='trig'?{expressions:'sin(x)\ncos(x)',xMin:'-6.283185307179586',xMax:'6.283185307179586',yMin:'',yMax:''}:kind==='market'?{expressions:'100-2*x\n10+3*x',xMin:'0',xMax:'40',yMin:'0',yMax:'140'}:{expressions:'1/x',xMin:'-5',xMax:'5',yMin:'-10',yMax:'10'});renderPane();calculate();return;}
    const action=button.dataset.action;
    if(action==='language'){state.language=state.language==='en'?'zh':'en';persist();renderShell();if(result&&!dirty)calculate();}
    if(action==='example'){state.parameters[state.activeTab]=clone(defaults[state.activeTab]);result=null;dirty=false;parsedCSV=null;persist();renderPane();calculate();}
    if(action==='import')$('worksheet-file').click();if(action==='csv-import')$('csv-file').click();
    if(action==='csv-parse'){if(readColumns(true)){markDirty();renderPane();}}
    if(action==='worksheet')exportPayload(textPayload('Math-worksheet.json','application/json',JSON.stringify(state,null,2)));
    if(action==='csv-export'&&result&&!dirty)exportPayload(textPayload(`Math-${state.activeTab}.csv`,'text/csv',csvText(result.csvRows||[])));
    if(action==='png-export'&&result?.chart&&!dirty){drawChart();if(!chartState)throw new Error(T('请先修正图像范围。','Correct the chart bounds first.'));exportPayload({name:`Math-${state.activeTab}.png`,mime:'image/png',dataBase64:$('plot').toDataURL('image/png').split(',')[1]});}
    if(action==='chart-range')calculate();
  }catch(err){status(errorText(err),true);}});
  async function importFile(input){const file=input.files?.[0];input.value='';if(!file)return;try{
    const limit=input.id==='csv-file'?2*1024*1024:8*1024*1024;if(file.size>limit)throw new Error(T('文件太大，请使用更小的文件。','This file is too large; choose a smaller file.'));
    const text=await file.text();if(input.id==='worksheet-file'){const next=validateWorksheet(JSON.parse(text));state=next;result=null;dirty=false;parsedCSV=null;persist();renderShell();calculate();status(T('已导入工作表并重新计算。','Worksheet imported and recalculated.'));}
    else {if(!['statistics','regression'].includes(state.activeTab))return;p().csv=text;parsedCSV=null;if(readColumns(true)){result=null;dirty=false;persist();renderPane();status(T('已载入 CSV，请选择列后计算。','CSV loaded. Select columns and calculate.'));}else{markDirty();renderPane();}}
  }catch(err){status(errorText(err),true);}}
  document.addEventListener('keydown',e=>{if(e.target.getAttribute?.('role')!=='tab'||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const tabs=Array.from(document.querySelectorAll('[role=tab]')),index=tabs.indexOf(e.target),next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].click();document.querySelectorAll('[role=tab]')[next].focus();});
  let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(drawChart,100);});
  renderShell();calculate();
})();
