import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
process.env.DATABASE_URL = "pglite:memoria";
process.env.CHAVE_MESTRA = crypto.randomBytes(32).toString("base64");
const { conectar, db, desconectar } = await import("../src/db.js");
const { criarApp } = await import("../src/app.js");
await import("../src/tarefas/trabalhos.js");
const { puxar } = await import("../src/tarefas/fila.js");
let app, conta, outra, estrategia, falharIdeias=false, incompleta=false, etapaRecebida=[];
const original=globalThis.fetch, pedidos=[];
const chamar=async(payload,token=conta?.token)=>{const r=await app.inject({method:"POST",url:"/api",payload,headers:token?{"x-pauta-token":token}:{}});return {status:r.statusCode,...r.json()};};
const briefing={objetivo:"Quero atrair clientes para meu café de bairro",foco:"Vender mais",publico:"Moradores do bairro",oferta:"Nosso café da manhã",acao:"Visitar a loja",prazo:"Próximos 30 dias",ritmo:"3 posts por semana"};
const estrategiaIA=()=>({titulo:"Do bairro para a mesa",resumo:"Criar presença local e transformar descoberta em visitas.",publico:"Moradores que buscam um café próximo.",direcao:"Um lugar acolhedor para começar o dia.",rotina:"Distribuir o conteúdo ao longo de quatro semanas.",etapas:["topo","meio","fundo"].map((id,i)=>({id,percentual:[45,35,20][i],objetivo:"Papel estratégico de "+id,abordagens:["Valorizar hábitos locais, sem criar publicações prontas.","Conectar a marca ao momento do público."],formatos:["Reels","Carrossel"],cadencia:"Distribuir esta etapa durante as semanas.",acao:"Ação adequada à etapa "+id,metricas:["Alcance","Interações relevantes"]}))});
async function esperar(id,tarefa=false){
 for(let n=0;n<300;n++){
  await puxar();const p=(await db().query(tarefa?"select * from tarefas where id=$1":"select * from mega_brain_estrategias where id=$1",[id])).rows[0];
  if(p&&["pronta","erro","feito"].includes(p.status))return p;
  await new Promise(r=>setTimeout(r,10));
 }
 throw new Error("A tarefa não terminou no teste.");
}
const usos=async()=>Number((await db().query("select count(*) as n from uso where org_id=$1 and tipo='ideias'",[conta.organizacao.id])).rows[0].n);
before(async()=>{
 await conectar();app=await criarApp();
 conta=await chamar({acao:"cadastrar",nome:"Lia",email:"lia@megabrain.test",senha:"segredo123",organizacao:"Café do Bairro"},null);
 outra=await chamar({acao:"cadastrar",nome:"Bia",email:"bia@megabrain.test",senha:"segredo123",organizacao:"Outra marca"},null);
 for(const u of [conta,outra])await chamar({acao:"salvarIntegracao",provedor:"anthropic",valor:"chave-de-teste-sem-provedor-real"},u.token);
 await db().query("update marcas set nome='Café do Bairro',publico='Pessoas do bairro',redes=$2 where org_id=$1",[conta.organizacao.id,['Instagram']]);
 globalThis.fetch=async(url,op)=>{
  assert.equal(String(url),"https://api.anthropic.com/v1/messages","o Mega Brain não gera imagens, vídeos nem publica conteúdo");
  const b=JSON.parse(op.body);pedidos.push(b);let dados;
  if(b.system.includes("Você é o Mega Brain"))dados=incompleta?{titulo:"Sem funil"}:estrategiaIA();
  else{
   if(falharIdeias)throw new Error("Falha simulada nas ideias");
   const e=JSON.parse(b.messages[0].content.match(/<estrategia_conteudo>\n([\s\S]*?)\n<\/estrategia_conteudo>/)[1]);
   etapaRecebida.push(e);dados={ideias:Array.from({length:5},(_,i)=>({titulo:`${e.etapa}: ideia original ${i+1}`,resumo:"Uma ideia para a etapa selecionada",formato:"Carrossel",rede:"Instagram",pilar:"Rotina",score:8,por_que_funciona:"Conecta a ação ao objetivo",referencias:[]}))};
  }
  return Response.json({content:[{type:"text",text:JSON.stringify(dados)}],stop_reason:"end_turn",usage:{input_tokens:300,output_tokens:400}});
 };
});
after(async()=>{
 for(let i=0;i<100;i++){await puxar();if(!(await db().query("select 1 from tarefas where status in ('pendente','rodando') limit 1")).rows.length)break;await new Promise(r=>setTimeout(r,20));}
 await new Promise(r=>setTimeout(r,20));globalThis.fetch=original;delete process.env.COBRANCA;await app.close();await desconectar();
});

test("estratégia incluída: gera uma vez, salva briefing e funil, sem criar ideias, posts ou gastar buscas",async()=>{
 const pedido=crypto.randomUUID();
 const respostas=await Promise.all(Array.from({length:3},()=>chamar({acao:"gerarEstrategiaMegaBrain",pedido,briefing})));
 assert(respostas.every(r=>r.status===200));const id=respostas[0].estrategia.id;assert(respostas.every(r=>r.estrategia.id===id));
 estrategia=await esperar(id);assert.equal(estrategia.status,"pronta",estrategia.erro);assert.deepEqual(estrategia.briefing,briefing);
 assert.deepEqual(estrategia.resultado.etapas.map(e=>e.id),["topo","meio","fundo"]);assert.equal(estrategia.resultado.etapas.reduce((s,e)=>s+e.percentual,0),100);
 assert.equal(pedidos.length,1);assert.match(pedidos[0].messages[0].content,/Café do Bairro/);
 assert.equal(await usos(),0);assert.equal((await db().query("select count(*)::int n from ideias")).rows[0].n,0);assert.equal((await db().query("select count(*)::int n from posts")).rows[0].n,0);
 const salvo=await chamar({acao:"listarMegaBrain",id});assert.equal(salvo.estrategia.resultado.titulo,"Do bairro para a mesa");assert.equal(salvo.estrategias.length,1);
 assert.equal((await db().query("select tipo from consumo")).rows[0].tipo,"estrategia");
});

test("histórico e geração por etapa respeitam a organização da sessão",async()=>{
 assert.equal((await chamar({acao:"listarMegaBrain"},outra.token)).estrategias.length,0);
 assert.equal((await chamar({acao:"listarMegaBrain",id:estrategia.id},outra.token)).status,404);
 assert.equal((await chamar({acao:"buscarIdeias",estrategia:estrategia.id,etapa:"topo",pedido:crypto.randomUUID()},outra.token)).status,404);
 assert.equal((await chamar({acao:"buscarIdeias",estrategia:estrategia.id,etapa:"invalida"})).status,400);
 assert.equal((await chamar({acao:"gerarEstrategiaMegaBrain",pedido:crypto.randomUUID(),briefing:{objetivo:"Incompleto"}})).status,400);
 assert.equal(await usos(),0);
});

test("cada etapa gera ideias com seu contexto, consome uma busca e repetições do pedido não cobram de novo",async()=>{
 for(const etapa of ["topo","meio","fundo"]){
  const antes=await usos(),pedido=crypto.randomUUID();
  const r=await chamar({acao:"buscarIdeias",estrategia:estrategia.id,etapa,pedido,quantidade:5});assert.equal(r.status,200);
  const tarefa=await esperar(r.id,true);assert.equal(tarefa.status,"feito",tarefa.erro);
  const outraVez=await chamar({acao:"buscarIdeias",estrategia:estrategia.id,etapa,pedido,quantidade:5});assert.equal(outraVez.id,r.id);
  assert.equal(await usos(),antes+1);assert.equal(tarefa.payload.resultado.criadas,5);
  const ideias=(await chamar({acao:"pauta"})).ideias.filter(i=>i.Estrategia===estrategia.id&&i.EtapaFunil===etapa);assert.equal(ideias.length,5);
  assert(ideias.every(i=>i.Status==="Sugerida"));
 }
 assert.deepEqual(etapaRecebida.map(e=>e.etapa),["topo","meio","fundo"]);assert(etapaRecebida.every(e=>e.briefing.objetivo===briefing.objetivo&&e.orientacao.id===e.etapa));
 assert.equal((await db().query("select count(*)::int n from posts")).rows[0].n,0);
});

test("falha ao gerar ideias devolve a busca e conserva a estratégia salva",async()=>{
 const antes=await usos();falharIdeias=true;
 try{
  const r=await chamar({acao:"buscarIdeias",estrategia:estrategia.id,etapa:"topo",pedido:crypto.randomUUID()});const t=await esperar(r.id,true);assert.equal(t.status,"erro");
  for(let i=0;i<50&&await usos()!==antes;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(await usos(),antes);assert.equal((await chamar({acao:"listarMegaBrain",id:estrategia.id})).estrategia.status,"pronta");
 }finally{falharIdeias=false;}
});

test("resposta incompleta não aparece como estratégia pronta e as respostas ficam disponíveis para tentar novamente",async()=>{
 incompleta=true;
 try{
  const r=await chamar({acao:"gerarEstrategiaMegaBrain",pedido:crypto.randomUUID(),briefing},outra.token);assert.equal(r.status,200);
  const s=await esperar(r.estrategia.id);assert.equal(s.status,"erro");assert.equal(s.resultado,null);assert.deepEqual(s.briefing,briefing);
 }finally{incompleta=false;}
});

test("esgotar buscas bloqueia novas ideias, mas mantém a criação e a leitura de estratégias incluídas",async()=>{
 process.env.COBRANCA="sim";
 const antes=await usos();assert(antes>=2);
 const r=await chamar({acao:"buscarIdeias",estrategia:estrategia.id,etapa:"topo",pedido:crypto.randomUUID()});assert.equal(r.status,402);assert.equal(await usos(),antes);
 const nova=await chamar({acao:"gerarEstrategiaMegaBrain",pedido:crypto.randomUUID(),briefing});assert.equal(nova.status,200);assert.equal((await esperar(nova.estrategia.id)).status,"pronta");assert.equal(await usos(),antes);
 await db().query("update organizacoes set plano_ate=now()-interval '1 day' where id=$1",[conta.organizacao.id]);
 assert.equal((await chamar({acao:"gerarEstrategiaMegaBrain",pedido:crypto.randomUUID(),briefing})).status,402);
 assert.equal((await chamar({acao:"listarMegaBrain",id:estrategia.id})).status,200);
});
