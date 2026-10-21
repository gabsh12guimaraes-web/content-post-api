import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
process.env.DATABASE_URL = "pglite:memoria";
process.env.CHAVE_MESTRA = crypto.randomBytes(32).toString("base64");
process.env.PASTA_ARQUIVOS = fs.mkdtempSync(path.join(os.tmpdir(), "acervo-test-"));
const { conectar, db, desconectar } = await import("../src/db.js");
const { criarApp } = await import("../src/app.js");
await import("../src/tarefas/trabalhos.js");
const { puxar } = await import("../src/tarefas/fila.js");
const { criarBuscaAcervo } = await import("../src/acervo-magnific.js");
const { custoDe } = await import("../src/custos.js");
let app, dona, outra, isolada, editor, foto, modo="foto", quota=false, arquivoInvalido=false;
let recursos=[123,124], chamadas=[];
const original=globalThis.fetch, key="chave_magnific_compartilhada_teste";
const chamar=async(payload,token=dona?.token)=>{const r=await app.inject({method:"POST",url:"/api",payload,headers:token?{"x-pauta-token":token}:{}});return {status:r.statusCode,...r.json()};};
const contar=tipo=>chamadas.filter(c=>c===tipo).length;
async function criar(conta=dona,briefing={}){
 const id=(await db().query("insert into posts(org_id,titulo,formato,rede,status,data_publicacao,briefing) values ($1,'Conteúdo do café',$2,'Instagram','Planejado',now()+interval '5 days',$3) returning id",[conta.organizacao.id,modo==="foto"?"Carrossel":"Reels",JSON.stringify(briefing)])).rows[0].id;
 const r=await chamar({acao:"criarPost",id,briefing},conta.token);assert.equal(r.status,200,r.erro);
 for(let n=0;n<200;n++){await puxar();const p=(await db().query("select * from posts where id=$1",[id])).rows[0];if(["EmRevisao","Erro"].includes(p.status))return p;await new Promise(r=>setTimeout(r,10));}
 throw new Error("Criação não terminou");
}
before(async()=>{
 await conectar();app=await criarApp();foto=await sharp({create:{width:16,height:24,channels:3,background:"#665544"}}).jpeg().toBuffer();
 const cadastrar=nome=>chamar({acao:"cadastrar",nome,email:crypto.randomUUID()+"@acervo.test",senha:"segredo123",organizacao:nome},null);
 dona=await cadastrar("Marca A");outra=await cadastrar("Marca B");isolada=await cadastrar("Outra conta");
 for(const c of [dona,outra,isolada]){
  await chamar({acao:"salvarIntegracao",provedor:"magnific",valor:c===isolada?"outra_chave_magnific":key},c.token);
  await chamar({acao:"salvarIntegracao",provedor:"anthropic",valor:"chave_claude_simulada"},c.token);
 }
 const convite=await chamar({acao:"convidar",email:"editora@acervo.test",papel:"editor"});
 editor=await chamar({acao:"cadastrar",nome:"Editora",email:"editora@acervo.test",senha:"segredo123",convite:convite.convite},null);
 globalThis.fetch=async(url,op={})=>{
  const u=new URL(String(url));
  if(u.hostname==="api.anthropic.com"){
   chamadas.push("claude");const cenas=[1,2].map(n=>({n,titulo:"Uma história do café",texto:"Conteúdo original",visual:"chef preparing food in a cafe",pessoa:modo==="pessoa",usa_imagem:true}));
   return Response.json({content:[{type:"text",text:JSON.stringify({legenda:"Uma legenda",hashtags:["#cafe"],...(modo==="foto"?{slides:cenas,prompts_imagem:cenas.map(s=>({slide:s.n,prompt:s.visual,proporcao:"4:5"}))}:{cenas})})}],stop_reason:"end_turn"});
  }
  if(u.hostname==="api.freepik.com"){chamadas.push("geracao");return Response.json({message:"Insufficient credits"},{status:402});}
  if(u.hostname==="api.magnific.com"){
   assert.equal(op.method||"GET","GET");assert.equal(op.headers["x-magnific-api-key"],key);
   if(u.pathname==="/v1/resources"){
    chamadas.push("busca");assert.equal(u.searchParams.get("filters[content_type][photo]"),"1");
    return Response.json({data:recursos.map(id=>({id,title:"Cozinha profissional",image:{type:"photo"},url:`https://www.magnific.com/premium-photo/chef_${id}.htm`,author:{name:"Autoria de teste"},licenses:[{type:"premium",url:`https://www.magnific.com/profile/license/pdf/${id}`}]}))});
   }
   chamadas.push("download");if(quota)return Response.json({message:"Daily download limit reached"},{status:429});
   return Response.json({data:{filename:arquivoInvalido?"foto.zip":"foto.jpg",url:arquivoInvalido?"https://example.invalid/thumb.jpg":"https://downloadscdn7.freepik.com/foto.jpg"}});
  }
  if(u.hostname==="downloadscdn7.freepik.com"){chamadas.push("arquivo");assert.equal(op.headers,undefined,"a chave não acompanha o download público assinado");return new Response(foto,{headers:{"content-type":"image/jpeg"}});}
  throw new Error("Chamada externa inesperada: "+u.hostname);
 };
});
after(async()=>{globalThis.fetch=original;delete process.env.COBRANCA;delete process.env.PLATAFORMA_MAGNIFIC;delete process.env.ADMIN_EMAILS;await app.close();await desconectar();});

test("acervo começa desligado; somente quem administra a conta pode declarar plano gratuito para downloads",async()=>{
 const d=await chamar({acao:"listarIntegracoes"});assert.equal(d.acervoMagnific.ativo,false);
 assert.equal(await criarBuscaAcervo(dona.organizacao.id),null);assert.deepEqual(chamadas,[]);
 assert.equal((await chamar({acao:"salvarAcervoMagnific",plano:"premium_plus"},editor.token)).status,403);
 assert.equal((await chamar({acao:"salvarAcervoMagnific",plano:"premium_plus",organizacao:outra.organizacao.id})).status,409);
 assert.equal((await chamar({acao:"salvarAcervoMagnific",plano:"business"})).status,400);
 const r=await chamar({acao:"salvarAcervoMagnific",plano:"premium_plus"});assert.equal(r.acervoMagnific.ativo,true);
 assert.equal((await chamar({acao:"listarIntegracoes"},outra.token)).acervoMagnific.ativo,true,"a mesma chave compartilha a preferência");
 assert.equal((await chamar({acao:"listarIntegracoes"},isolada.token)).acervoMagnific.ativo,false);
 assert(!JSON.stringify(r).includes(key));
});
test("sem saldo: interrompe a geração e usa fotos licenciadas do acervo, salva origem e mantém revisão",async()=>{
 chamadas=[];const p=await criar();assert.equal(p.status,"EmRevisao",p.erro);assert.equal(p.erro,null);assert.equal(p.artes_prontas,false);
 assert.equal(Object.keys(p.fotos).length,2);assert.match(p.conteudo.aviso_midias,/acervo Magnific/);
 assert.equal(contar("geracao"),1);assert.equal(contar("download"),2);assert.equal(contar("arquivo"),2);
 const banco=(await chamar({acao:"listarBanco"})).imagens;assert.equal(banco.length,2);assert(banco.every(i=>i.origem==="acervo"&&i.fonte.licencas[0].tipo==="premium"&&i.fonte.autor==="Autoria de teste"));
 const painel=(await chamar({acao:"pauta"})).posts.find(x=>x.id===p.id);assert.match(painel.AvisoMidias,/Revise/);
 assert.equal((await chamar({acao:"aprovarPost",id:p.id})).status,400,"continua exigindo a arte final e aprovação da pessoa");
 const consumo=(await db().query("select tipo,quantidade from consumo where provedor='magnific'")).rows;assert(consumo.every(c=>c.tipo==="acervo"));assert.equal(custoDe("magnific","acervo",{quantidade:2}),0);
});
test("reutiliza arquivo já licenciado sem novo download e mantém o banco separado por organização",async()=>{
 chamadas=[];await criar();assert.equal(contar("download"),0);assert.equal(contar("arquivo"),0);
 const a=(await chamar({acao:"listarBanco"})).imagens;assert.equal(a.length,2);
 await criar(outra);assert.equal(contar("download"),2);const b=(await chamar({acao:"listarBanco"},outra.token)).imagens;
 assert.equal(b.length,2);assert(b.every(i=>!a.some(x=>x.arquivo.id===i.arquivo.id)));
});
test("Reels pode usar fotos do acervo como cenas estáticas; sem plano confirmado não baixa nada",async()=>{
 modo="reels";chamadas=[];const p=await criar();assert.equal(p.status,"EmRevisao");assert.equal(p.erro,null);assert.deepEqual(p.clipes,{});assert.equal(Object.keys(p.fotos).length,2);assert.match(p.conteudo.aviso_midias,/cenas estáticas/);
 chamadas=[];const q=await criar(isolada);assert.match(q.erro,/sem créditos/);assert.equal(contar("busca"),0);assert.equal(contar("download"),0);
});
test("limite diário interrompe o acervo sem insistir, sem cobrar geração e sem inventar mídias",async()=>{
 recursos=[901,902];quota=true;chamadas=[];
 try{const p=await criar();assert.match(p.erro,/sem créditos/);assert.deepEqual(p.fotos,{});assert.equal(contar("geracao"),1);assert.equal(contar("busca"),1);assert.equal(contar("download"),1);assert.equal(contar("arquivo"),0);}finally{quota=false;}
});
test("não usa ZIP ou miniatura como original nem troca pessoa de referência por foto genérica",async()=>{
 arquivoInvalido=true;chamadas=[];const buscar=await criarBuscaAcervo(dona.organizacao.id);
 try{assert.equal(await buscar({texto:"chef"}),null);assert.equal(contar("arquivo"),0);}finally{arquivoInvalido=false;}
 modo="pessoa";const pessoa=await chamar({acao:"enviarPessoa",tipo:"image/jpeg",nome:"Pessoa real",autorizado:true,base64:foto.toString("base64")});chamadas=[];
 const p=await criar(dona,{pessoa:pessoa.id});assert.match(p.erro,/sem créditos/);assert.equal(contar("busca"),0);assert.deepEqual(p.fotos,{});
});
test("trocar a chave desliga a preferência; clientes da plataforma não podem alterar o plano da conta principal",async()=>{
 await chamar({acao:"salvarIntegracao",provedor:"magnific",valor:"chave_nova_sem_preferencia"});assert.equal((await chamar({acao:"listarIntegracoes"})).acervoMagnific.ativo,false);
 process.env.COBRANCA="sim";process.env.PLATAFORMA_MAGNIFIC=key;
 await chamar({acao:"removerIntegracao",provedor:"magnific"},isolada.token);
 assert.equal((await chamar({acao:"listarIntegracoes"},isolada.token)).acervoMagnific.podeGerir,false);
 assert.equal((await chamar({acao:"salvarAcervoMagnific",plano:"premium_plus"},isolada.token)).status,403);
 assert.equal((await chamar({acao:"salvarAcervoMagnific",plano:""},outra.token)).acervoMagnific.ativo,false);
});
