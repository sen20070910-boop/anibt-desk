'use strict';
let helpLoaded=false;
window.AniBTHelp={async open(){
  if(helpLoaded)return;
  try{
    const result=await api('help');const lines=result.text.split('\n');let code=false,html='';
    for(const line of lines){
      if(line.startsWith('```')){html+=code?'</code></pre>':'<pre><code>';code=!code;continue;}
      if(code){html+=escape(line)+'\n';continue;}
      if(/^#{1,3} /.test(line)){const level=line.match(/^#+/)[0].length+1;html+=`<h${level}>${escape(line.replace(/^#+ /,''))}</h${level}>`;}
      else if(line.startsWith('- '))html+='<p class="help-item">• '+escape(line.slice(2))+'</p>';
      else if(line.trim())html+='<p>'+escape(line).replace(/`([^`]+)`/g,'<code>$1</code>')+'</p>';
    }
    $('help-content').innerHTML=html;helpLoaded=true;
  }catch(e){text('help-content','说明暂时无法打开：'+e.message);}
}};
