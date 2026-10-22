import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
process.env.DATABASE_URL='pglite:memoria';
process.env.CHAVE_MESTRA=crypto.randomBytes(32).toString('base64');
process.env.GROQ_API_KEY='groq-somente-teste';process.env.SHOTSTACK_API_KEY='shotstack-somente-teste';
process.env.URL_PUBLICA='https://api.example.com';
const pasta=await fs.mkdtemp(path.join(os.tmpdir(),'sinsa-test-'));process.env.PASTA_ARQUIVOS=pasta;
const video=path.join(pasta,'original.mp4');
execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=180x320:r=15:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-shortest','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-y',video]);
const dados=await fs.readFile(video);
const {conectar,db,desconectar}=await import('../src/db.js');
const {criarApp}=await import('../src/app.js');
const {cifrar}=await import('../src/cripto.js');
const {processarSinsalabim,cotaSinsa}=await import('../src/sinsalabim.js');
const {limparPlanoSinsa,timelineSinsa}=await import('../src/sinsalabim-plano.js');
await conectar();const app=await criarApp();const originalFetch=globalThis.fetch;
let transcricoes=0,renders=0,analises=0,recusar=false,falhaRender=false,incerto=false;
const planoBase={titulo:'Um conteúdo que conecta',resumo:'Cortei a pausa e destaquei as palavras.',estilo:'dinamico',cor:'#ff5478',cortes:[{inicio:0,fim:1.9,zoom:true}],legendas:true,tituloTela:'Uma boa ideia',chamada:'Conheça a marca',legenda:'Conteúdo feito com cuidado.',hashtags:'#marca',apoios:[],avisos:[]};
globalThis.fetch=async(url,op={})=>{
 const u=String(url);
 if(u==='https://api.groq.com/openai/v1/audio/transcriptions'){
  transcricoes++;assert.equal(op.headers.Authorization,'Bearer groq-somente-teste');assert.equal(op.body.get('model'),'whisper-large-v3-turbo');
  return Response.json({text:'Olá mundo, vamos criar.',duration:2,words:[{word:'Olá',start:.1,end:.4},{word:'mundo',start:.5,end:.8},{word:'vamos',start:1,end:1.3},{word:'criar',start:1.4,end:1.8}]});
 }
 if(u==='https://api.anthropic.com/v1/messages'){
  analises++;const req=JSON.parse(op.body);assert(req.system.includes('Sinsalabim'));assert.equal(req.model,'claude-opus-5-5','usa o modelo padrão da plataforma');assert.equal(op.headers['x-api-key'] && op.headers['anthropic-version'],'2023-06-01');assert(req.max_tokens>=16000);const conteudo=req.messages[0].content;assert(conteudo.some(c=>c.type==='image'),'manda quadros do vídeo');assert(conteudo.some(c=>c.type==='text'&&c.text.includes('transcricao')),'manda a transcrição');return Response.json({content:[{type:'text',text:JSON.stringify(planoBase)}],usage:{input_tokens:300,output_tokens:200},stop_reason:'end_turn'});
 }
 if(/^https:\/\/api.shotstack.io\/edit\/(v1|stage)\/render$/.test(u)){
  renders++;assert.equal(op.headers['x-api-key'],u.includes('/stage/')?'shotstack-sandbox-teste':'shotstack-somente-teste');const t=JSON.parse(op.body);assert.equal(t.output.aspectRatio,'9:16');assert(t.timeline.tracks.some(t=>t.clips.some(c=>c.asset.type==='html5')));
  if(incerto)throw new Error('timeout');if(recusar)return Response.json({message:'chave-secreta-nao-repetir'},{status:400});
  return Response.json({response:{id:'render-'+renders}});
 }
 if(/^https:\/\/api.shotstack.io\/edit\/(v1|stage)\/render\//.test(u)){assert.equal(op.headers['x-api-key'],u.includes('/stage/')?'shotstack-sandbox-teste':'shotstack-somente-teste');return Response.json({response:{status:falhaRender?'failed':'done',url:'https://render.shotstack.io/teste.mp4'}});}
 if(u==='https://render.shotstack.io/teste.mp4')return new Response(dados,{headers:{'content-type':'video/mp4'}});
 throw new Error('URL externa não autorizada no teste: '+u);
};
const api=async(body,token)=>{const r=await app.inject({method:'POST',url:'/api',payload:body,headers:token?{'x-pauta-token':token}:{}});return {status:r.statusCode,...r.json()};};
const esperar=async fn=>{for(let i=0;i<300;i++){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,20));}throw new Error('Tarefa de teste não terminou');};
const a=await api({acao:'cadastrar',nome:'Clara',email:'sinsa@example.com',senha:'senha-teste-123',organizacao:'Marca A'}),token=a.token,org=a.organizacao.id;
const b=await api({acao:'cadastrar',nome:'Outra pessoa',email:'outra@example.com',senha:'senha-teste-123',organizacao:'Marca B'});
await db().query("insert into integracoes(org_id,provedor,valor_cifrado) values($1,'anthropic',$2)",[org,cifrar('chave-mock-claude')]);
await db().query("insert into integracoes(org_id,provedor,valor_cifrado) values($1,'anthropic',$2)",[b.organizacao.id,cifrar('outra-chave-mock')]);
let banco,edicao;
after(async()=>{await esperar(async()=>!(await db().query("select 1 from tarefas where status in ('pendente','rodando')")).rows.length);globalThis.fetch=originalFetch;await app.close();await desconectar();await fs.rm(pasta,{recursive:true,force:true});});

test('plano recusa operações livres, limita duração, valida banco e escapa texto nas animações',()=>{
 const p=limparPlanoSinsa({...planoBase,cortes:[{inicio:-20,fim:90},{inicio:1,fim:3}],apoios:[{banco:'de-outra-org',inicio:0,duracao:1}],tituloTela:'<script>alert(1)</script>'},120,[],[]);
 assert.equal(p.duracao,60);assert.equal(p.apoios.length,0);const timeline=timelineSinsa(p,'https://api.example.com/f/a/b');assert(!JSON.stringify(timeline).includes('<script>'));assert(JSON.stringify(timeline).includes('&lt;script&gt;'));
 assert.throws(()=>limparPlanoSinsa({cortes:[]},2),/trechos válidos/);
});
test('upload real e análise com transcrição e imagens, isolados por organização',async()=>{
 banco=await api({acao:'enviarImagemBanco',tipo:'video/mp4',nome:'original.mp4',base64:dados.toString('base64'),descrever:false},token);assert.equal(banco.status,200);
 const pedido=crypto.randomUUID(),r=await api({acao:'criarSinsalabim',pedido,banco:banco.id,mensagem:'Corte as pausas e coloque legendas.'},token);assert.equal(r.status,200);edicao=r.id;
 assert.equal((await api({acao:'criarSinsalabim',pedido,banco:banco.id,mensagem:'Corte as pausas e coloque legendas.'},token)).id,edicao);
 await esperar(async()=>{const e=await api({acao:'obterSinsalabim',id:edicao},token);return e.edicao?.status==='pronto'&&e;});
 assert.equal(transcricoes,1);assert.equal(analises,1);
 const e=(await api({acao:'obterSinsalabim',id:edicao},token)).edicao;assert.equal(e.plano.palavras.length,4);assert.equal(e.versao,1);
 assert.equal((await api({acao:'obterSinsalabim',id:edicao},b.token)).status,404);
 assert.equal((await api({acao:'criarSinsalabim',pedido:crypto.randomUUID(),banco:banco.id,mensagem:'Quero editar este vídeo.'},b.token)).status,404);
 assert.equal((await api({acao:'listarSinsalabim'},b.token)).edicoes.length,0);assert.equal((await cotaSinsa(org)).usadas,0);
});
test('chat reaproveita transcrição e exige confirmação e versão da prévia para exportar',async()=>{
 assert.equal((await api({acao:'ajustarSinsalabim',id:edicao,mensagem:'Deixe o vídeo mais dinâmico.'},token)).status,200);
 await esperar(async()=>(await api({acao:'obterSinsalabim',id:edicao},token)).edicao?.versao===2);
 assert.equal(transcricoes,1);assert.equal(analises,2);
 assert.equal((await api({acao:'exportarSinsalabim',id:edicao,pedido:crypto.randomUUID(),versao:2},token)).status,400);
 assert.equal((await api({acao:'exportarSinsalabim',id:edicao,pedido:crypto.randomUUID(),versao:1,confirmado:true},token)).status,409);assert.equal(renders,0);
});
test('exportação é idempotente, persiste o MP4 no banco e envia para revisão sem publicar',async()=>{
 const pedido=crypto.randomUUID(),body={acao:'exportarSinsalabim',id:edicao,pedido,versao:2,confirmado:true};
 const [x,y]=await Promise.all([api(body,token),api(body,token)]);assert.equal(x.status,200);assert.equal(x.id,y.id);
 await esperar(async()=>(await db().query('select status from sinsalabim_exportacoes where id=$1',[x.id])).rows[0].status==='renderizando');assert.equal(renders,1);
 await processarSinsalabim();const r=(await db().query('select * from sinsalabim_exportacoes where id=$1',[x.id])).rows[0];assert.equal(r.status,'feito');assert(r.arquivo_id);assert(r.banco_id);
 const repetida=await api({...body,pedido:crypto.randomUUID()},token);assert.equal(repetida.id,x.id);assert.equal(renders,1);assert.equal((await cotaSinsa(org)).usadas,1);
 const data=new Date(Date.now()+86400000).toISOString();const p=await api({acao:'revisarSinsalabim',exportacao:x.id,data},token);assert.equal(p.status,200);
 assert.equal((await api({acao:'revisarSinsalabim',exportacao:x.id,data},token)).id,p.id);
 const post=(await db().query('select * from posts where id=$1',[p.id])).rows[0];assert.equal(post.status,'EmRevisao');assert.equal(post.legenda,planoBase.legenda);assert.equal(post.artes_prontas,true);assert.equal(post.clipes['1'],r.arquivo_id);
 assert.equal((await db().query("select count(*)::int n from uso where org_id=$1 and tipo='post'",[org])).rows[0].n,1);
 assert.equal((await api({acao:'revisarSinsalabim',exportacao:x.id,data},b.token)).status,409);
 assert.equal((await api({acao:'removerImagemBanco',id:r.banco_id},token)).status,200);assert((await db().query('select id from arquivos where id=$1',[r.arquivo_id])).rows.length);
});
test('o limite mensal reserva no máximo cinco exportações sob concorrência',async()=>{
 const ids=[];for(let i=0;i<6;i++)ids.push((await db().query("insert into sinsalabim_edicoes(org_id,criado_por,pedido,arquivo_id,nome,status,plano,versao) select org_id,criado_por,$2,arquivo_id,'Outra edição','pronto',plano,1 from sinsalabim_edicoes where id=$1 returning id",[edicao,crypto.randomUUID()])).rows[0].id);
 const r=await Promise.all(ids.map(id=>api({acao:'exportarSinsalabim',id,pedido:crypto.randomUUID(),versao:1,confirmado:true},token)));
 assert.equal(r.filter(x=>x.status===200).length,4);assert.equal(r.filter(x=>x.status===402).length,2);assert.equal((await cotaSinsa(org)).usadas,5);
 await esperar(async()=>!(await db().query("select 1 from sinsalabim_exportacoes where status in ('pendente','enviando')")).rows.length);
 falhaRender=true;await processarSinsalabim();falhaRender=false;assert.equal((await cotaSinsa(org)).usadas,1);
});
test('rejeição definitiva libera a cota; envio incerto não é repetido automaticamente',async()=>{
 const id=(await db().query("select id from sinsalabim_edicoes where id<>$1 limit 1",[edicao])).rows[0].id;
 recusar=true;const x=await api({acao:'exportarSinsalabim',id,pedido:crypto.randomUUID(),versao:1,confirmado:true},token);
 await esperar(async()=>(await db().query('select status from sinsalabim_exportacoes where id=$1',[x.id])).rows[0].status==='erro');recusar=false;assert.equal((await cotaSinsa(org)).usadas,1);
 incerto=true;const y=await api({acao:'exportarSinsalabim',id,pedido:crypto.randomUUID(),versao:1,confirmado:true},token);
 await esperar(async()=>(await db().query('select status from sinsalabim_exportacoes where id=$1',[y.id])).rows[0].status==='incerto');incerto=false;
 assert.equal((await cotaSinsa(org)).usadas,2);assert(!(await db().query('select erro from sinsalabim_exportacoes where id=$1',[x.id])).rows[0].erro.includes('chave-secreta'));
});
test('sem chaves a opção informa indisponibilidade sem expor credenciais',async()=>{
 delete process.env.GROQ_API_KEY;
 const r=await api({acao:'listarSinsalabim'},token);assert.equal(r.configurado,false);assert(!JSON.stringify(r).includes('shotstack-somente-teste'));
 assert.equal((await api({acao:'criarSinsalabim',pedido:crypto.randomUUID(),banco:banco.id,mensagem:'Mais uma edição.'},token)).status,503);
 process.env.GROQ_API_KEY='groq-somente-teste';
});
test('retoma um envio interrompido sem fazer outra cobrança no provedor',async()=>{
 const {enfileirar}=await import('../src/tarefas/fila.js');
 const e=(await db().query('select * from sinsalabim_edicoes where id=$1',[edicao])).rows[0];
 const r=(await db().query("insert into sinsalabim_exportacoes(org_id,edicao_id,pedido,versao,plano,status) values($1,$2,$3,2,$4,'enviando') returning id",[org,e.id,crypto.randomUUID(),JSON.stringify(e.plano)])).rows[0];
 const antes=renders;await enfileirar(org,'sinsalabimExportar',{exportacao:r.id},a.usuario.id);
 await esperar(async()=>(await db().query('select status from sinsalabim_exportacoes where id=$1',[r.id])).rows[0].status==='incerto');assert.equal(renders,antes);
});
test('uma exportação Sandbox mantém seu ambiente e não entra na revisão de produção',async()=>{
 await db().query("update sinsalabim_exportacoes set status='erro' where status='incerto'");
 process.env.SHOTSTACK_SANDBOX='sim';process.env.SHOTSTACK_SANDBOX_API_KEY='shotstack-sandbox-teste';
 const r=await api({acao:'exportarSinsalabim',id:edicao,pedido:crypto.randomUUID(),versao:2,confirmado:true},token);assert.equal(r.status,200);
 await esperar(async()=>(await db().query('select status from sinsalabim_exportacoes where id=$1',[r.id])).rows[0].status==='renderizando');
 process.env.SHOTSTACK_SANDBOX='nao';await processarSinsalabim();
 const e=(await db().query('select * from sinsalabim_exportacoes where id=$1',[r.id])).rows[0];assert.equal(e.status,'feito');assert.equal(e.ambiente,'stage');
 assert.equal((await api({acao:'revisarSinsalabim',exportacao:r.id,data:new Date(Date.now()+86400000).toISOString()},token)).status,400);
});

test('edição de retenção: destaques gigantes, apoio no topo, transições, cor viva e legenda em pílula', () => {
  const palavras = [{texto:'O',inicio:0.1,fim:0.2},{texto:'carvão',inicio:0.3,fim:0.8},{texto:'mancha',inicio:1.0,fim:1.4},{texto:'o',inicio:1.5,fim:1.6},{texto:'esmalte.',inicio:4.1,fim:4.6},{texto:'fim',inicio:5.6,fim:5.9}];
  const banco = [{id:'img-1',url:'https://api.example.com/f/1/k'}];
  const p = limparPlanoSinsa({...planoBase, visual:'vibrante', legendaEstilo:'pilula',
    cortes:[{inicio:0,fim:2,transicao:'zoom'},{inicio:4,fim:5.5,transicao:'deslizar'},{inicio:5.5,fim:6,transicao:'explodir'}],
    destaques:[{indice:4},{indice:1,texto:'CARVÃO',apoio:'não clareia'},{indice:2},{indice:99},{indice:3.5}],
    apoios:[{banco:'img-1',inicio:0.5,duracao:1.5,layout:'topo'},{banco:'img-1',inicio:2.2,duracao:1,layout:'girar'}]}, 6, banco, palavras);
  assert.deepEqual(p.cortes.map(c=>c.transicao), ['corte','deslizar','corte'], 'o primeiro trecho entra seco e transição desconhecida vira corte');
  assert.equal(p.visual,'vibrante'); assert.equal(p.legendaEstilo,'pilula');
  assert.deepEqual(p.apoios.map(a=>a.layout), ['topo','tela']);
  // "esmalte." foi dito aos 4.1 s do original = 2.1 s na edição (o trecho de 2 a 4 s saiu); "mancha" encosta no destaque anterior e cai
  assert.deepEqual(p.destaques.map(d=>[d.texto,d.inicio]), [['CARVÃO',0.25],['esmalte',2.05]]);
  assert.equal(p.destaques[0].apoio,'não clareia');
  const t = timelineSinsa(p,'https://api.example.com/f/v/k',banco), trilhas = t.timeline.tracks.flatMap(x=>x.clips), json = JSON.stringify(t);
  const videos = trilhas.filter(c=>c.asset.type==='video');
  assert(videos.every(c=>c.filter==='boost'), 'cor viva no vídeo todo');
  assert.equal(videos[0].transition, undefined); assert.equal(videos[1].transition.in, 'slideLeft');
  const topo = trilhas.find(c=>c.asset.type==='image'); assert.deepEqual(topo.crop, {bottom:0.5});
  assert(json.includes('CARV') && json.includes('class=\\"d\\"'), 'destaque entra como camada própria');
  assert(json.includes('class=\\"caixa\\"'), 'legenda em pílula');
  const legendas = trilhas.filter(c=>c.asset.type==='html5' && c.asset.html.includes('caixa'));
  assert(legendas.every(l => !p.destaques.some(d => l.start < d.inicio + d.duracao && l.start + l.length > d.inicio)), 'a legenda sai da frente do destaque');
});
