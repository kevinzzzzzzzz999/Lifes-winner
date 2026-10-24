import type {ReactNode} from 'react';
export type ModuleArtKind = 'pages'|'calendar'|'checklist'|'graph'|'search'|'board'|'scan'|'review'|'exchange'|'browser'|'clip'|'math'|'media'|'assistant'|'settings'|'python'|'notebook'|'markdown'|'latex';
// Original cut-paper and line compositions sit behind the functional symbols.
// No shared SVG IDs, resources or interactive elements: repeated cards remain
// deterministic, decorative and independent of their accessible control labels.
const compositions:Record<ModuleArtKind,ReactNode> = {
 pages:<><path d="M106 8L149 32L121 88L83 63Z" fill="var(--art-secondary)"/><path d="M13 67A27 27 0 0 0 45 93" stroke="var(--art-color)"/><circle cx="137" cy="82" r="5" fill="var(--art-tertiary)"/></>,
 calendar:<><circle cx="123" cy="73" r="24" fill="var(--art-secondary)"/><path d="M12 24A31 31 0 0 1 57 5M7 30A38 38 0 0 1 62 1" stroke="var(--art-color)"/><path d="M12 76L28 91H12Z" fill="var(--art-tertiary)"/></>,
 checklist:<><path d="M93 7L144 36L117 88L69 62Z" fill="var(--art-secondary)"/><path d="M10 69H29M10 77H25M10 85H21" stroke="var(--art-color)"/><circle cx="136" cy="13" r="5" fill="var(--art-tertiary)"/></>,
 graph:<><ellipse cx="79" cy="51" rx="62" ry="34" transform="rotate(-18 79 51)" stroke="var(--art-color)"/><path d="M10 76A24 24 0 0 0 34 100V76Z" fill="var(--art-secondary)"/><path d="M126 7H151V32A25 25 0 0 1 126 7Z" fill="var(--art-tertiary)"/></>,
 search:<><circle cx="100" cy="39" r="34" fill="var(--art-secondary)"/><path d="M9 71L29 91H54L34 71Z" fill="var(--art-tertiary)"/><path d="M139 17V28M134 22H145" stroke="var(--art-color)"/></>,
 board:<><path d="M17 7H63V35H17Z" transform="rotate(-9 40 21)" fill="var(--art-secondary)"/><path d="M114 57H153V94H114Z" fill="var(--art-tertiary)"/><path d="M3 56C13 40 23 41 32 53" stroke="var(--art-color)"/></>,
 scan:<><path d="M89 4H140V94H89Z" transform="rotate(8 115 49)" fill="var(--art-secondary)"/><path d="M12 27V74M18 27V74M24 34V67" stroke="var(--art-tertiary)"/><circle cx="138" cy="11" r="4" fill="var(--art-color)"/></>,
 review:<><circle cx="47" cy="29" r="26" fill="var(--art-secondary)"/><path d="M69 74C99 56 129 66 149 87L121 94Z" fill="var(--art-tertiary)"/><path d="M11 51C11 72 20 85 39 92" stroke="var(--art-color)"/></>,
 exchange:<><path d="M34 11A37 37 0 0 1 107 17M117 85A37 37 0 0 1 44 81" stroke="var(--art-color)"/><circle cx="81" cy="48" r="22" fill="var(--art-secondary)"/><path d="M131 12H149V30H131Z" fill="var(--art-tertiary)"/></>,
 browser:<><path d="M99 4L150 24L136 61L85 40Z" fill="var(--art-secondary)"/><path d="M10 67H36V93A26 26 0 0 1 10 67Z" fill="var(--art-tertiary)"/><path d="M85 95H147M115 90H147" stroke="var(--art-color)"/></>,
 clip:<><circle cx="107" cy="51" r="39" stroke="var(--art-color)"/><path d="M13 25H41V82H13Z" transform="rotate(-12 27 53)" fill="var(--art-secondary)"/><circle cx="135" cy="14" r="7" fill="var(--art-tertiary)"/></>,
 math:<><path d="M35 87A51 51 0 0 1 135 66L135 87Z" fill="var(--art-secondary)"/><path d="M8 25L22 11L36 25L22 39Z" fill="var(--art-tertiary)"/><circle cx="145" cy="43" r="3" fill="var(--art-color)"/></>,
 media:<><circle cx="80" cy="52" r="37" fill="var(--art-secondary)"/><path d="M33 17C63 3 110 7 139 37M25 85C58 101 109 96 144 69" stroke="var(--art-color)"/><path d="M12 29L30 39L12 49Z" fill="var(--art-tertiary)"/></>,
 assistant:<><path d="M18 74C32 100 80 95 96 69C113 41 132 27 151 34" stroke="var(--art-color)"/><circle cx="123" cy="25" r="24" fill="var(--art-secondary)"/><path d="M8 29L18 19L28 29L18 39Z" fill="var(--art-tertiary)"/></>,
 settings:<><path d="M19 8H60V93H19Z" transform="rotate(9 40 50)" fill="var(--art-secondary)"/><circle cx="123" cy="72" r="21" fill="var(--art-tertiary)"/><path d="M110 9V17M121 9V17M132 9V17" stroke="var(--art-color)"/></>,
 python:<><path d="M22 24L65 2L104 78L61 99Z" fill="var(--art-secondary)"/><path d="M92 8A35 35 0 0 1 143 56" stroke="var(--art-color)"/><circle cx="122" cy="81" r="10" fill="var(--art-tertiary)"/></>,
 notebook:<><path d="M18 4H111V94H18Z" transform="rotate(-5 65 49)" fill="var(--art-secondary)"/><path d="M142 28A22 22 0 0 1 142 72" stroke="var(--art-color)"/><circle cx="130" cy="14" r="7" fill="var(--art-tertiary)"/></>,
 markdown:<><path d="M80 4H142V87H80Z" transform="rotate(8 111 46)" fill="var(--art-secondary)"/><path d="M8 74C25 62 43 73 46 95" stroke="var(--art-color)"/><path d="M120 81L138 93H109Z" fill="var(--art-tertiary)"/></>,
 latex:<><circle cx="84" cy="51" r="39" fill="var(--art-secondary)"/><ellipse cx="84" cy="51" rx="62" ry="23" transform="rotate(-25 84 51)" stroke="var(--art-color)"/><path d="M17 18L28 7L39 18L28 29Z" fill="var(--art-tertiary)"/></>,
};
const drawings:Record<ModuleArtKind,ReactNode> = {
 pages:<><path d="M46 17H104V73H46Z" fill="var(--art-soft)"/><path d="M28 27H86V83H28Z" fill="var(--work-surface)" stroke="currentColor"/><path d="M39 42H74M39 51H74M39 60H60" stroke="currentColor"/><path d="M93 17V60H120V17Z" fill="var(--art-color)"/></>,
 calendar:<><rect x="23" y="16" width="104" height="68" rx="2" fill="var(--work-surface)" stroke="currentColor"/><path d="M23 34H127M49 34V84M75 34V84M101 34V84M23 59H127M42 10V23M108 10V23" stroke="currentColor"/><rect x="76" y="35" width="24" height="23" fill="var(--art-color)"/><circle cx="36" cy="72" r="5" fill="var(--art-soft)"/><circle cx="114" cy="47" r="5" fill="var(--art-soft)"/></>,
 checklist:<><rect x="35" y="13" width="85" height="77" fill="var(--art-soft)"/><rect x="24" y="8" width="84" height="77" fill="var(--work-surface)" stroke="currentColor"/><path d="M54 28H92M54 47H83M54 67H91" stroke="currentColor"/><path d="M34 27L39 32L47 22M34 46L39 51L47 41" fill="none" stroke="var(--art-color)" strokeWidth="3"/><rect x="35" y="62" width="10" height="10" fill="none" stroke="currentColor"/></>,
 graph:<><path d="M31 56L70 25L120 46L97 79L31 56M70 25L97 79" fill="none" stroke="currentColor"/><circle cx="31" cy="56" r="12" fill="var(--art-soft)"/><circle cx="70" cy="25" r="16" fill="var(--art-color)"/><circle cx="120" cy="46" r="9" fill="var(--art-soft)" stroke="currentColor"/><circle cx="97" cy="79" r="11" fill="var(--work-surface)" stroke="currentColor"/></>,
 search:<><path d="M22 26H71M22 42H60M22 59H78M22 76H67" stroke="currentColor"/><circle cx="99" cy="39" r="24" fill="var(--art-soft)" stroke="currentColor"/><path d="M116 56L136 78" stroke="var(--art-color)" strokeWidth="9"/><circle cx="99" cy="39" r="13" fill="var(--work-surface)"/></>,
 board:<><rect x="18" y="17" width="120" height="68" fill="var(--art-soft)"/><rect x="27" y="27" width="31" height="40" fill="var(--work-surface)" stroke="currentColor"/><rect x="73" y="27" width="49" height="23" fill="var(--art-color)"/><path d="M64 67C80 40 90 85 123 62" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M25 11H34M13 21V30M124 91H135M143 71V81" stroke="currentColor"/></>,
 scan:<><path d="M29 31V15H48M108 15H127V31M29 70V85H48M108 85H127V70" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M48 22H109V77H48Z" fill="var(--art-soft)"/><path d="M59 34H96M59 44H99M59 66H94" stroke="currentColor"/><path d="M17 53H139" stroke="var(--art-color)" strokeWidth="4"/></>,
 review:<><path d="M23 19H93V84H23Z" fill="var(--work-surface)" stroke="currentColor"/><path d="M35 34H79M35 48H79M35 64H65" stroke="currentColor"/><path d="M76 21H137V59H108L96 72V59H76Z" fill="var(--art-soft)" stroke="currentColor"/><path d="M86 35H125M86 44H115" stroke="var(--art-color)" strokeWidth="3"/></>,
 exchange:<><path d="M18 13H58V71H18Z" fill="var(--art-soft)"/><path d="M102 31H142V88H102Z" fill="var(--work-surface)" stroke="currentColor"/><path d="M49 32H106L96 22M106 32L96 42M111 66H54L64 56M54 66L64 76" fill="none" stroke="var(--art-color)" strokeWidth="2"/></>,
 browser:<><rect x="18" y="17" width="123" height="70" fill="var(--work-surface)" stroke="currentColor"/><path d="M18 31H141" stroke="currentColor"/><circle cx="26" cy="24" r="2" fill="currentColor"/><circle cx="34" cy="24" r="2" fill="currentColor"/><circle cx="42" cy="24" r="2" fill="currentColor"/><path d="M30 43H74V75H30Z" fill="var(--art-color)"/><path d="M85 46H128M85 57H128M85 68H111" stroke="currentColor"/></>,
 clip:<><path d="M30 13H92V83H30Z" fill="var(--art-soft)"/><path d="M45 30H77M45 41H77M45 52H67" stroke="currentColor"/><path d="M83 28H132V77L108 62L83 77Z" fill="var(--art-color)"/><path d="M31 90H119" stroke="currentColor"/></>,
 math:<><path d="M24 18V81H140M21 29H141M21 54H141M48 13V85M77 13V85M107 13V85M136 13V85" stroke="currentColor" opacity=".26"/><path d="M24 18V81H140" fill="none" stroke="currentColor"/><path d="M27 69C52 69 57 58 69 58S94 74 103 48S119 20 136 19" fill="none" stroke="var(--art-color)" strokeWidth="4"/><circle cx="104" cy="46" r="5" fill="currentColor"/></>,
 media:<><path d="M20 53H139" stroke="currentColor" opacity=".45"/>{[22,35,49,63,77,91,105,119,133].map((x,i)=><rect key={x} x={x} y={53-[12,24,34,18,40,30,15,24,9][i]/2} width="5" height={[12,24,34,18,40,30,15,24,9][i]} fill={i<5?'var(--art-color)':'var(--art-soft)'}/>)}<path d="M20 82H139M20 17H80" stroke="currentColor"/><path d="M111 10L129 20L111 30Z" fill="var(--art-color)"/></>,
 assistant:<><path d="M21 16H110V62H57L41 77V62H21Z" fill="var(--art-soft)"/><path d="M83 48H138V82H119L109 91V82H83Z" fill="var(--work-surface)" stroke="currentColor"/><path d="M40 35H91M40 46H76" stroke="currentColor"/><circle cx="101" cy="65" r="3" fill="var(--art-color)"/><circle cx="113" cy="65" r="3" fill="var(--art-color)"/><circle cx="125" cy="65" r="3" fill="var(--art-color)"/></>,
 settings:<><path d="M24 27H137M24 53H137M24 79H137" stroke="currentColor"/><circle cx="57" cy="27" r="10" fill="var(--art-color)"/><circle cx="109" cy="53" r="10" fill="var(--art-soft)" stroke="currentColor"/><circle cx="76" cy="79" r="10" fill="var(--work-surface)" stroke="currentColor"/></>,
 python:<><path d="M57 24L27 50L57 76M103 24L133 50L103 76" fill="none" stroke="currentColor" strokeWidth="3"/><path d="M92 14L67 88" stroke="var(--art-color)" strokeWidth="12"/><path d="M23 88H48M113 12H138" stroke="var(--art-soft)" strokeWidth="5"/></>,
 notebook:<><rect x="26" y="17" width="113" height="28" fill="var(--art-soft)"/><rect x="26" y="54" width="113" height="29" fill="var(--work-surface)" stroke="currentColor"/><path d="M35 31H63M73 31H117M37 72L50 62L65 75L81 61L92 69L125 58" fill="none" stroke="var(--art-color)" strokeWidth="2"/><path d="M15 17V45M15 54V83" stroke="currentColor"/></>,
 markdown:<><path d="M24 17H94V83H24Z" fill="var(--art-soft)"/><path d="M38 36V64M51 32V60M30 45H60M30 54H60" stroke="var(--art-color)" strokeWidth="3"/><path d="M83 31H137M83 45H137M83 59H127M83 73H137" stroke="currentColor"/></>,
 latex:<><path d="M30 21H68L43 49L68 77H30" fill="none" stroke="var(--art-color)" strokeWidth="5"/><path d="M88 18H133M83 83H137M111 27V70M89 42L100 61L120 31" fill="none" stroke="currentColor" strokeWidth="2"/><circle cx="134" cy="35" r="6" fill="var(--art-soft)"/></>,
};
/** Decorative, deterministic artwork. Meaning is supplied by the visible control title. */
export default function ModuleArtwork({kind,className=''}:{kind:ModuleArtKind;className?:string}){
 return <svg className={`module-art module-art-${kind} ${className}`} viewBox="0 0 160 100" fill="none" aria-hidden="true" focusable="false"><g className="module-art-composition">{compositions[kind]}</g><g className="module-art-symbol">{drawings[kind]}</g></svg>;
}

/** A larger composition stays in the header's reserved right-hand art space. */
export function WorkspaceArtwork(){
 return <svg className="home-header-art" viewBox="0 0 320 160" fill="none" aria-hidden="true" focusable="false">
  <path className="home-art-grid" d="M172 12V149M198 12V149M224 12V149M250 12V149M276 12V149M166 25H302M166 51H302M166 77H302M166 103H302M166 129H302"/>
  <path className="home-art-paper-plane" d="M129 39L209 18L233 110L153 131Z"/>
  <path className="home-art-moss-plane" d="M98 49H169V120A71 71 0 0 1 98 49Z"/>
  <path className="home-art-stone-plane" d="M244 37A34 34 0 0 1 278 71V113H210V71A34 34 0 0 1 244 37Z"/>
  <path className="home-art-cutout" d="M236 83H261V113H236Z"/>
  <path className="home-art-orbit" d="M29 146C80 141 93 115 117 83S177 30 249 30H308"/>
  <path className="home-art-gold-line" d="M48 151C108 148 131 121 158 91S208 58 299 58"/>
  <path className="home-art-fold-line" d="M135 42L181 72L204 25M181 72L219 109"/>
  <circle className="home-art-clay-plane" cx="279" cy="126" r="15"/>
  <circle className="home-art-ring" cx="86" cy="113" r="18"/>
  <circle className="home-art-gold-dot" cx="299" cy="30" r="4"/>
  <path className="home-art-baseline" d="M111 149H309M292 83V99M284 91H300"/>
 </svg>;
}

export function SectionArtwork({kind}:{kind:'layers'|'bridge'|'orbit'|'rhythm'}){
 const patterns={
  layers:<><path d="M9 17L23 3L37 17L23 31Z" fill="var(--art-secondary)"/><path d="M29 17L43 3L57 17L43 31Z" stroke="currentColor"/><path d="M49 17L63 3L77 17L63 31Z" fill="var(--art-soft)"/></>,
  bridge:<><path d="M8 27V19A14 14 0 0 1 36 19V27" stroke="currentColor"/><path d="M33 27V19A14 14 0 0 1 61 19V27Z" fill="var(--art-secondary)"/><path d="M58 27V19A14 14 0 0 1 86 19V27" stroke="var(--art-color)"/></>,
  orbit:<><ellipse cx="46" cy="17" rx="35" ry="11" transform="rotate(-13 46 17)" stroke="currentColor"/><circle cx="46" cy="17" r="11" fill="var(--art-soft)"/><circle cx="76" cy="8" r="4" fill="var(--art-secondary)"/></>,
  rhythm:<><path d="M10 26V8H24V26Z" fill="var(--art-soft)"/><path d="M35 26V3H49V26Z" fill="var(--art-secondary)"/><path d="M60 26V13H74V26Z" fill="var(--art-tertiary)"/><path d="M6 30H84" stroke="currentColor"/></>,
 };
 return <svg className={`home-section-art home-section-art-${kind}`} viewBox="0 0 92 34" fill="none" aria-hidden="true" focusable="false">{patterns[kind]}</svg>;
}
