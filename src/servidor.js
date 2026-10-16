// Ponto de partida no Railway: conecta ao banco (e aplica as migrações), sobe a API e o trabalhador.
import { config } from "./config.js";
import { conectar } from "./db.js";
import { criarApp } from "./app.js";
import { iniciarTrabalhador } from "./tarefas/fila.js";
import { publicarVencidos } from "./tarefas/trabalhos.js";
import "./tarefas/importar.js";

config.chaveMestra(); // falha logo se a CHAVE_MESTRA não estiver configurada
await conectar();
const app = await criarApp();
await app.listen({ port: config.porta, host: "0.0.0.0" });
console.log(`API no ar na porta ${config.porta} (${config.urlPublica})`);
if (config.trabalhador) {
  await iniciarTrabalhador([{ cada: 60000, fn: publicarVencidos }]);
  console.log("Trabalhador ligado: fila de tarefas e publicação agendada.");
}
