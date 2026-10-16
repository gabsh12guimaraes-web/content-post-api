// Aplica as migrações e sai (útil para rodar à mão: npm run migrar).
import { conectar, desconectar } from "./db.js";
await conectar();
console.log("Banco atualizado.");
await desconectar();
