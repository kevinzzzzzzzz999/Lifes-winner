/* Offline, bounded Markdown. Raw HTML is visible source, never executable markup.
 * Marked 17.0.5 (MIT); KaTeX 0.18.7 is shared with the formula renderer. */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let assets = { images: {}, links: {} };
  const reference = (href, isWiki) => (isWiki ? 'wiki:' : 'md:') + href;
  const math = (text, displayMode) => {
    if (text.length > 20000) return `<code class="math-error">${escape(text)}</code>`;
    try { return katex.renderToString(text, {displayMode, throwOnError:true, trust:false, strict:'error', maxExpand:1000, maxSize:20}); }
    catch (_) { return `<code class="math-error">${escape(text)}</code>`; }
  };
  const parser = new marked.Marked({gfm:true, breaks:false, async:false});
  parser.use({extensions:[
    { name:'inkMathBlock', level:'block', start:src => src.indexOf('$$'),
      tokenizer(src) { const match=/^\$\$[ \t]*\n([\s\S]+?)\n\$\$[ \t]*(?:\n|$)/.exec(src) || /^\$\$([^\n]+?)\$\$[ \t]*(?:\n|$)/.exec(src); if(match) return {type:'inkMathBlock',raw:match[0],text:match[1]}; },
      renderer(token) { return math(token.text,true); } },
    { name:'inkMathInline', level:'inline', start:src => src.indexOf('$'),
      tokenizer(src) { const match=/^\$(?!\$|\s)((?:\\.|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(src); if(match) return {type:'inkMathInline',raw:match[0],text:match[1]}; },
      renderer(token) { return math(token.text,false); } },
    { name:'inkWiki', level:'inline', start:src => src.search(/!?\[\[/),
      tokenizer(src) { const match=/^(!?)\[\[([^\]\n]+)\]\]/.exec(src); if(!match) return;
        const pieces=match[2].split('|'); return {type:'inkWiki',raw:match[0],href:pieces[0],text:pieces.slice(1).join('|')||pieces[0],isImage:match[1]==='!'}; },
      renderer(token) { const key=reference(token.href,true);
        if(token.isImage) return image(key,token.text);
        return link(key,escape(token.text)); } }
  ],renderer:{
    html(token) { return escape(token.text); },
    image(token) { return image(reference(token.href,false),token.text); },
    link(token) { return link(reference(token.href,false),this.parser.parseInline(token.tokens)); }
  }});
  function image(key, alt) {
    const source=assets.images[key];
    return typeof source==='string' && /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(source)
      ? `<img src="${source}" alt="${escape(alt)}">`
      : `<span class="missing-image">${escape(assets.labels?.missingImage ?? 'Image not loaded: ')}${escape(alt||key.slice(key.indexOf(':')+1))}</span>`;
  }
  function link(key, label) {
    const target=assets.links[key];
    if(typeof target!=='string' || !/^(https?:\/\/|mailto:|obsidian:\/\/open\?)/i.test(target)) return label;
    return `<a href="${escape(target)}" rel="noreferrer noopener">${label}</a>`;
  }
  window.inkMarkdownReferences = text => {
    const result=[], seen=new Set(); let count=0;
    const tokens=parser.lexer(text);
    parser.walkTokens(tokens, token => {
      if(++count>200000) throw new Error('Markdown token budget exceeded');
      if(token.type==='image'||token.type==='link'||token.type==='inkWiki') {
        const isWiki=token.type==='inkWiki', isImage=token.type==='image'||token.isImage===true;
        const key=reference(token.href,isWiki), identity=(isImage?'image:':'link:')+key;
        if(!seen.has(identity)) { seen.add(identity); result.push({key,href:token.href,isImage,isWiki}); }
      }
    });
    if(result.length>4096) throw new Error('Markdown reference budget exceeded');
    return result;
  };
  window.inkMarkdownRender = async (text, prepared) => {
    assets=prepared;
    const html=parser.parse(text);
    if(html.length>24*1024*1024) throw new Error('Markdown output budget exceeded');
    document.getElementById('document').innerHTML=html;
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map(image => image.complete ? Promise.resolve() : new Promise(resolve => { image.onload=resolve; image.onerror=resolve; })));
    // Reading layout flushes it without requestAnimationFrame, which WebKit can
    // suspend for an offscreen conversion view.
    void document.body.offsetHeight;
    return {height:document.documentElement.scrollHeight, text:document.body.innerText.length,
            imageCount:document.images.length, mathCount:document.querySelectorAll('.katex').length};
  };
})();
