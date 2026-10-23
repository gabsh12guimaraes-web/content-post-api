// O onnxruntime-node traz binários de todos os sistemas (~240 MB); o servidor só usa o do sistema em que roda.
import fs from "node:fs";
import path from "node:path";
const base = path.resolve("node_modules/onnxruntime-node/bin");
if (fs.existsSync(base)) for (const napi of fs.readdirSync(base)) for (const so of fs.readdirSync(path.join(base, napi))) {
  if (so !== process.platform) fs.rmSync(path.join(base, napi, so), { recursive: true, force: true });
  else for (const arq of fs.readdirSync(path.join(base, napi, so))) if (arq !== process.arch) fs.rmSync(path.join(base, napi, so, arq), { recursive: true, force: true });
}
