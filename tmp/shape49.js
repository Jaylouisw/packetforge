
const fs=require('fs');
let bad=0;
for (const f of process.argv.slice(2)){
  const lines=fs.readFileSync(f,'utf8').split(/\r?\n/); let cols=null;
  for (let i=0;i<lines.length;i++){
    const l=lines[i];
    if (/^\s*\|/.test(l) && /\|\s*$/.test(l)) {
      const body=l.trim().replace(/^\|/,'').replace(/\|$/,'');
      if (/^[\s:|-]+$/.test(body)) continue;
      let cells=1,inTick=false;
      for (let k=0;k<body.length;k++){const c=body[k];
        if(c==='`') inTick=!inTick; else if(c==='\\'){k++;continue;} else if(c==='|'&&!inTick) cells++;}
      if (cols===null){cols=cells;continue;}
      if (cells!==cols){bad++;console.log(f+':'+(i+1)+' '+cells+' cells, expected '+cols);}
    } else cols=null;
  }
}
console.log(bad?bad+' shape problem(s)':'tables clean');
