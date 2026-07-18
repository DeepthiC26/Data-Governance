const fs=require('fs');
const strip=(s)=>s.replace(/if \(typeof module[\s\S]*$/,'');
const parts={
  '/*__ENGINE__*/':strip(fs.readFileSync('engine.js','utf8')),
  '/*__ML__*/':strip(fs.readFileSync('ml.js','utf8')),
  '/*__CHAT__*/':strip(fs.readFileSync('chat.js','utf8')),
  '/*__REVIEW__*/':strip(fs.readFileSync('review.js','utf8')),
};
let tpl=fs.readFileSync('app-template.html','utf8');
for(const [ph,code] of Object.entries(parts)){
  tpl=tpl.replace(ph, ()=>code); // function replacement: $&,$1 NOT interpreted
}
fs.writeFileSync('data-governance.html',tpl);
// validate
const block=tpl.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/<\/?script>/g,'');
new (require('vm').Script)(block);
const od=(tpl.match(/<div/g)||[]).length,cd=(tpl.match(/<\/div>/g)||[]).length;
const left=(tpl.match(/\/\*__(ENGINE|ML|CHAT|CONSENSUS)__\*\//g)||[]).length;
console.log('built:',(tpl.length/1024).toFixed(1)+'KB | script OK | divs',od+'/'+cd,od===cd?'BAL':'MISMATCH','| placeholders',left);
console.log('regex intact:', tpl.includes("replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')"));
