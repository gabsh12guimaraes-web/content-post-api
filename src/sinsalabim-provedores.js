import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { registrarConsumo } from './provedores/index.js';
export const ambienteSinsa=()=>process.env.SHOTSTACK_SANDBOX==='sim'?'stage':'v1';
const chaveShotstack=ambiente=>ambiente==='stage'?(process.env.SHOTSTACK_SANDBOX_API_KEY||process.env.SHOTSTACK_API_KEY):process.env.SHOTSTACK_API_KEY;
export const sinsaConfigurado=()=>!!(process.env.GROQ_API_KEY&&chaveShotstack(ambienteSinsa()));
export const urlShotstack=(ambiente=ambienteSinsa())=>`https://api.shotstack.io/edit/${ambiente==='stage'?'stage':'v1'}`;
function comando(args,tempo=60000) {return new Promise((ok,fail)=>{
  const p=spawn(ffmpeg,args,{stdio:['ignore','ignore','pipe']});let erro='';
  const timer=setTimeout(()=>{p.kill('SIGKILL');fail(new Error('Não conseguimos preparar o vídeo a tempo. Tente um arquivo menor.'));},tempo);
  p.stderr.on('data',d=>{erro=(erro+d).slice(-12000);});p.on('error',()=>{clearTimeout(timer);fail(new Error('Não foi possível preparar o vídeo.'));});p.on('close',code=>{clearTimeout(timer);ok({code,erro});});
});}
export async function examinarSinsa(arq) {
  const r=await comando(['-hide_banner','-i',arq],15000),m=r.erro.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duracao=m?+m[1]*3600 + +m[2]*60 + +m[3]:0;
  if(!r.erro.includes('Video:') || !duracao)throw Object.assign(new Error('Este arquivo não contém um vídeo válido. Exporte em MP4 e envie novamente.'),{status:400});
  if(duracao>300 || duracao<1)throw Object.assign(new Error('Envie um vídeo de 1 segundo a 5 minutos.'),{status:400});
  return {duracao,audio:r.erro.includes('Audio:')};
}
// Miniatura JPEG de até 384 px para a IA ver a foto do banco.
export async function miniaturaSinsa(arq) {
  const pasta=await fs.mkdtemp(path.join(os.tmpdir(),'sinsa-mini-'));
  try {const saida=path.join(pasta,'mini.jpg');const r=await comando(['-hide_banner','-y','-i',arq,'-frames:v','1','-vf','scale=384:384:force_original_aspect_ratio=decrease','-q:v','5',saida],15000);if(r.code!==0)return null;return await fs.readFile(saida);}
  finally {await fs.rm(pasta,{recursive:true,force:true});}
}
export async function transcreverSinsa(org,arq,temAudio) {
  if(!temAudio)return {texto:'',palavras:[]};
  const pasta=await fs.mkdtemp(path.join(os.tmpdir(),'sinsa-'));
  try {
    const saida=path.join(pasta,'audio.m4a');const r=await comando(['-hide_banner','-y','-i',arq,'-vn','-ac','1','-ar','16000','-c:a','aac','-b:a','32k','-t','300',saida]);
    if(r.code!==0)throw new Error('Não foi possível ler o áudio do vídeo.');
    const form=new FormData();form.set('file',new Blob([await fs.readFile(saida)],{type:'audio/mp4'}),'audio.m4a');form.set('model','whisper-large-v3-turbo');form.set('response_format','verbose_json');form.append('timestamp_granularities[]','word');form.append('timestamp_granularities[]','segment');
    const resp=await fetch('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`},body:form,signal:AbortSignal.timeout(120000)});
    if(!resp.ok)throw new Error('A transcrição está indisponível. Tente novamente em alguns instantes.');
    const j=await resp.json();const palavras=(j.words||[]).filter(w=>typeof w.word==='string'&&Number.isFinite(w.start)&&Number.isFinite(w.end)&&w.end>w.start).slice(0,3500).map(w=>({texto:w.word.slice(0,70),inicio:w.start,fim:w.end}));
    await registrarConsumo(org,'groq',{tipo:'minuto',quantidade:Math.max(10,Number(j.duration||0))/60});
    return {texto:String(j.text||'').slice(0,25000),palavras};
  } finally {await fs.rm(pasta,{recursive:true,force:true});}
}
export async function enviarRenderSinsa(timeline,ambiente=ambienteSinsa()) {
  let r;
  try {r=await fetch(`${urlShotstack(ambiente)}/render`,{method:'POST',redirect:'error',headers:{'content-type':'application/json','x-api-key':chaveShotstack(ambiente)},body:JSON.stringify(timeline),signal:AbortSignal.timeout(45000)});}
  catch {throw Object.assign(new Error('Não foi possível confirmar o envio da exportação. Para evitar uma cobrança duplicada, confira com o suporte antes de tentar novamente.'),{incerto:true});}
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw Object.assign(new Error(r.status===401||r.status===403?'O serviço de edição precisa ser configurado pela equipe.':'O serviço de edição não aceitou a exportação. Tente novamente mais tarde.'),{incerto:r.status>=500});
  if(!j.response?.id)throw Object.assign(new Error('O serviço não confirmou o número da exportação. Confira com o suporte antes de tentar novamente.'),{incerto:true});
  return j.response.id;
}
export async function consultarRenderSinsa(id,ambiente=ambienteSinsa()) {
  if(!/^[\w-]{1,100}$/.test(id))throw new Error('Exportação inválida.');
  const r=await fetch(`${urlShotstack(ambiente)}/render/${id}`,{headers:{'x-api-key':chaveShotstack(ambiente)},redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error('Não conseguimos consultar a exportação agora.');
  const j=await r.json();return j.response || {};
}
// Só aceita o resultado vindo do provedor; nunca uma URL fornecida pelo chat.
export async function baixarRenderSinsa(url) {
  let u;try{u=new URL(url);}catch{throw new Error('O serviço não entregou um vídeo válido.');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||!(/(^|\.)(shotstack\.io|shotstack\.com|amazonaws\.com|cloudfront\.net)$/.test(u.hostname)))throw new Error('O endereço do vídeo exportado não é válido.');
  const r=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(120000)});
  if(!r.ok||!String(r.headers.get('content-type')).startsWith('video/'))throw new Error('Não foi possível baixar o vídeo exportado.');
  const partes=[];let total=0;for await(const parte of r.body){total+=parte.length;if(total>100*1024*1024)throw Object.assign(new Error('O vídeo exportado ficou muito grande. Peça uma versão mais curta.'),{permanente:true});partes.push(parte);}
  const dados=Buffer.concat(partes);if(dados.length<=25*1024*1024)return dados;
  // Mantém o limite do volume sem cobrar outra renderização no provedor.
  const pasta=await fs.mkdtemp(path.join(os.tmpdir(),'sinsa-mp4-'));
  try {
    const entrada=path.join(pasta,'entrada.mp4'),saida=path.join(pasta,'final.mp4');await fs.writeFile(entrada,dados);
    const convertido=await comando(['-hide_banner','-y','-i',entrada,'-t','60','-c:v','libx264','-preset','veryfast','-b:v','2400k','-maxrate','2600k','-bufsize','4800k','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart',saida],180000);
    if(convertido.code!==0)throw Object.assign(new Error('Não foi possível preparar o MP4 final. Tente uma edição mais curta.'),{permanente:true});
    const final=await fs.readFile(saida);if(final.length>25*1024*1024)throw Object.assign(new Error('O vídeo final ficou muito grande. Peça uma edição mais curta.'),{permanente:true});return final;
  }finally{await fs.rm(pasta,{recursive:true,force:true});}
}
