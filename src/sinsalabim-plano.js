// A IA propõe dados; só operações conhecidas chegam ao renderizador.
const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
const num = (v, min, max, pad = min) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : pad;
export const ESTILOS_SINSA = ['clean', 'dinamico', 'comercial'];
export const duracaoPlano = p => Math.round(p.cortes.reduce((t,c) => t+c.fim-c.inicio,0)*1000)/1000;
export function limparPlanoSinsa(r, duracao, banco = [], palavras = []) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.cortes)) throw new Error('A edição veio incompleta. Peça um novo ajuste.');
  const cortes=[];let total=0;
  for(const c of r.cortes.slice(0,40)) {
    const inicio=num(c.inicio,0,duracao),fim=num(c.fim,inicio,duracao);
    if(fim-inicio<0.3 || inicio < (cortes.at(-1)?.fim || 0)-0.02) continue;
    const tamanho=Math.min(fim-inicio,60-total);if(tamanho<0.3)break;
    cortes.push({inicio:+inicio.toFixed(3),fim:+(inicio+tamanho).toFixed(3),zoom:c.zoom===true});total+=tamanho;
    if(total>=59.99)break;
  }
  if(!cortes.length)throw new Error('Não encontramos trechos válidos para a edição. Tente explicar seu objetivo de outra forma.');
  const cor=/^#[0-9a-f]{6}$/i.test(r.cor || '')?r.cor:'#ff5478';
  const imagens=new Set(banco.map(b=>b.id));
  const apoios=(Array.isArray(r.apoios)?r.apoios:[]).slice(0,5).filter(a=>imagens.has(a.banco)).map(a=>({banco:a.banco,inicio:num(a.inicio,0,Math.max(0,total-0.3)),duracao:num(a.duracao,0.5,Math.min(5,total))})).filter(a=>a.inicio+a.duracao<=total+0.01);
  const p={titulo:str(r.titulo,100)||'Meu vídeo',resumo:str(r.resumo,600),estilo:ESTILOS_SINSA.includes(r.estilo)?r.estilo:'dinamico',cor,cortes,legendas:r.legendas!==false,tituloTela:str(r.tituloTela,80),chamada:str(r.chamada,80),legenda:str(r.legenda,1600),hashtags:str(r.hashtags,500),apoios,avisos:(Array.isArray(r.avisos)?r.avisos:[]).map(a=>str(a,180)).filter(Boolean).slice(0,4)};
  p.correcoes=(Array.isArray(r.correcoes)?r.correcoes:[]).slice(0,50).filter(c=>Number.isInteger(c.indice)&&c.indice>=0&&c.indice<palavras.length&&str(c.texto,70)).map(c=>({indice:c.indice,texto:str(c.texto,70)}));
  const corrigidas=new Map(p.correcoes.map(c=>[c.indice,c.texto]));
  p.palavras=[];let offset=0;
  for(const c of cortes) {
    for(const [indice,w] of palavras.entries()) {
      // Não sobrepor duas falas nem incluir palavras cortadas ao meio.
      if(w.inicio<c.inicio-0.02 || w.fim>c.fim+0.02)continue;
      p.palavras.push({texto:corrigidas.get(indice)||str(w.texto,70),inicio:+(offset+w.inicio-c.inicio).toFixed(3),fim:+(offset+w.fim-c.inicio).toFixed(3)});
    }
    offset+=c.fim-c.inicio;
  }
  p.duracao=duracaoPlano(p);return p;
}
export function gruposLegendas(p) {
  const grupos=[];let grupo=[];
  for(const w of p.palavras || []) {
    if(grupo.length && (grupo.length>=5 || w.inicio-grupo.at(-1).fim>0.65)) {grupos.push(grupo);grupo=[];}
    grupo.push(w);
  }
  if(grupo.length)grupos.push(grupo);return grupos;
}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function timelineSinsa(plano, video, imagens=[]) {
  let t=0;
  const videos=plano.cortes.map(c=>{const clip={asset:{type:'video',src:video,trim:c.inicio,volume:1},start:+t.toFixed(3),length:+(c.fim-c.inicio).toFixed(3),fit:'crop',...(c.zoom?{effect:'zoomIn'}:{})};t+=c.fim-c.inicio;return clip;});
  const apoios=plano.apoios.map(a=>({asset:{type:'image',src:imagens.find(i=>i.id===a.banco)?.url},start:a.inicio,length:a.duracao,fit:'crop',transition:{in:'fade',out:'fade'}})).filter(a=>a.asset.src);
  const legendas=plano.legendas?gruposLegendas(plano).map(g=>{
    const inicio=Math.max(0,g[0].inicio),fim=Math.min(t,g.at(-1).fim+0.08);
    const palavras=g.map(w=>`<span style="--atraso:${Math.max(0,w.inicio-inicio).toFixed(3)}s;--duracao:${Math.max(0.04,w.fim-w.inicio).toFixed(3)}s">${esc(w.texto)}</span>`).join(' ');
    return {asset:{type:'html5',html:`<div class="leg ${plano.estilo}">${palavras}</div>`,css:`html,body{margin:0;width:1080px;height:1920px;background:transparent;overflow:hidden}.leg{position:absolute;left:76px;right:76px;bottom:380px;text-align:center;font:800 62px/1.22 Arial,sans-serif;color:#fff;text-shadow:0 3px 8px #000,0 0 3px #000}.leg.comercial{padding:24px;border-radius:22px;background:#111827d9}.leg.clean{font-size:54px;font-weight:700}span{display:inline-block;animation:marca var(--duracao) linear var(--atraso) 1}@keyframes marca{0%,99%{color:${plano.cor};transform:translateY(-3px)}100%{color:white;transform:none}}`},start:inicio,length:Math.max(0.05,fim-inicio)};
  }):[];
  const cards=[];
  for(const [texto,inicio,tamanho] of [[plano.tituloTela,0,Math.min(3,t/2)],[plano.chamada,t-Math.min(3,t/2),Math.min(3,t/2)]]) {
    if(!texto)continue;
    cards.push({asset:{type:'html5',html:`<div>${esc(texto)}</div>`,css:`html,body{margin:0;width:1080px;height:1920px;background:transparent}div{position:absolute;top:220px;left:76px;right:76px;padding:26px;border-radius:24px;background:#111827e8;border-left:10px solid ${plano.cor};color:white;font:800 62px/1.15 Arial,sans-serif;text-align:center;box-sizing:border-box;animation:entrar .3s ease-out both}@keyframes entrar{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}`},start:inicio,length:tamanho});
  }
  return {timeline:{background:'#0a0c15',tracks:[{clips:cards},{clips:legendas},{clips:apoios},{clips:videos}].filter(x=>x.clips.length)},output:{format:'mp4',resolution:'1080',aspectRatio:'9:16',fps:30}};
}
