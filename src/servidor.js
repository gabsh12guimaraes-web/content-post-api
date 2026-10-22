// Ponto de partida no Railway: conecta ao banco (e aplica as migrações), sobe a API e o trabalhador.
import { config } from "./config.js";
import { conectar } from "./db.js";
import { criarApp } from "./app.js";
import { iniciarTrabalhador } from "./tarefas/fila.js";
import { publicarVencidos, destravarPublicando } from "./tarefas/trabalhos.js";
import { tratarAntigos } from "./arquivos.js";
import "./tarefas/importar.js";
import { processarEventosNasten, reconciliarNasten } from "./nasten.js";
import { processarEmailsConta } from "./autenticacao-email.js";
import { processarSinsalabim } from "./sinsalabim.js";

config.chaveMestra(); // falha logo se a CHAVE_MESTRA não estiver configurada
await conectar();
const app = await criarApp();
await app.listen({ port: config.porta, host: "0.0.0.0" });
console.log(`API no ar na porta ${config.porta} (${config.urlPublica})`);
if (config.trabalhador) {
  // As imagens de antes da otimização são tratadas aos poucos (20 por minuto) até acabar.
  // Neste servidor nada está publicando ao ligar: o que ficou "Publicando" (reinício no meio) volta para a fila já,
  // e o id do Zernio guardado evita publicar de novo.
  await destravarPublicando(0);
  await iniciarTrabalhador([{ cada: 300000, fn: () => destravarPublicando(30) }, { cada: 60000, fn: publicarVencidos }, { cada: 60000, fn: () => tratarAntigos(20) }, { cada: 30000, fn: processarEventosNasten }, { cada: 900000, fn: reconciliarNasten }, { cada: 15000, fn: processarEmailsConta }, { cada: 10000, fn: processarSinsalabim }]);
  processarEmailsConta().catch(() => console.error('[email] falha ao retomar fila'));
  processarEventosNasten().catch(e => console.error("[nasten]", e.message));
  console.log("Trabalhador ligado: fila de tarefas e publicação agendada.");
}
