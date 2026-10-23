// Separa a pessoa do fundo em cada quadro com o MODNet (src/modelos, Apache-2.0) e grava a máscara como vídeo
// (pessoa = branco). Roda na CPU do servidor: a máscara é calculada pequena e a 15 quadros por segundo, e só nos
// trechos usados na edição; fora deles a máscara é branca e o quadro fica como estava.
import { spawn } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import ffmpeg from "ffmpeg-static";

const THREADS = Math.max(1, Math.min(4, os.availableParallelism ? os.availableParallelism() : os.cpus().length));
let sessao = null;
async function modelo() {
  if (!sessao) sessao = (async () => {
    const ort = (await import("onnxruntime-node")).default;
    const s = await ort.InferenceSession.create(fileURLToPath(new URL("./modelos/modnet-quantizado.onnx", import.meta.url)), { intraOpNumThreads: THREADS, interOpNumThreads: 1, graphOptimizationLevel: "all" });
    return { ort, s };
  })().catch(e => { sessao = null; throw e; });
  return sessao;
}
// Lado menor de 288 px, múltiplo de 32 (o modelo pede).
export function tamanhoMascara(largura, altura) {
  const m32 = v => Math.max(32, Math.round(v / 32) * 32);
  return largura <= altura ? { W: 288, H: m32(288 * altura / largura) } : { W: m32(288 * largura / altura), H: 288 };
}
const dentro = (t, faixas) => !faixas || faixas.some(([a, b]) => t >= a - 0.5 && t <= b + 0.5);
export async function mascaraDoVideo(arq, saida, { largura, altura, duracao, faixas = null, fps = 15, aoAvancar = () => {}, limiteMs = 30 * 60000 }) {
  const { ort, s } = await modelo();
  const { W, H } = tamanhoMascara(largura, altura), N = W * H, tam = N * 3;
  const entradaT = new Float32Array(3 * N), branco = Buffer.alloc(N, 255);
  const dec = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", arq, "-vf", `fps=${fps},scale=${W}:${H}:flags=bilinear`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
  const enc = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", String(fps), "-i", "pipe:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-pix_fmt", "yuv420p", saida], { stdio: ["pipe", "ignore", "pipe"] });
  let erroDec = "", erroEnc = "";
  dec.stderr.on("data", d => { erroDec = (erroDec + d).slice(-2000); }); enc.stderr.on("data", d => { erroEnc = (erroEnc + d).slice(-2000); });
  const fimEnc = new Promise(ok => enc.on("close", ok)), fimDec = new Promise(ok => dec.on("close", ok));
  const relogio = setTimeout(() => { dec.kill("SIGKILL"); enc.kill("SIGKILL"); }, limiteMs);
  let buf = Buffer.alloc(0), k = 0, anterior = null, ultimoPct = -1;
  const total = Math.max(1, Math.round(duracao * fps));
  try {
    for await (const pedaco of dec.stdout) {
      buf = buf.length ? Buffer.concat([buf, pedaco]) : pedaco;
      while (buf.length >= tam) {
        const q = buf.subarray(0, tam); buf = buf.subarray(tam);
        const t = k / fps; let g;
        if (dentro(t, faixas)) {
          for (let i = 0, p = 0; i < N; i++, p += 3) { entradaT[i] = q[p] / 127.5 - 1; entradaT[N + i] = q[p + 1] / 127.5 - 1; entradaT[2 * N + i] = q[p + 2] / 127.5 - 1; }
          const r = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", entradaT, [1, 3, H, W]) });
          const m = r[s.outputNames[0]].data;
          // Suaviza no tempo para a borda não tremer de um quadro para o outro.
          if (!anterior) anterior = Float32Array.from(m); else for (let i = 0; i < N; i++) anterior[i] = anterior[i] * 0.35 + m[i] * 0.65;
          g = Buffer.alloc(N); for (let i = 0; i < N; i++) g[i] = anterior[i] >= 1 ? 255 : anterior[i] <= 0 ? 0 : (anterior[i] * 255) | 0;
        } else { anterior = null; g = branco; }
        if (!enc.stdin.write(g)) await new Promise(ok => enc.stdin.once("drain", ok));
        k++;
        const pct = Math.min(99, Math.floor(k / total * 100));
        if (pct >= ultimoPct + 5) { ultimoPct = pct; aoAvancar(pct / 100); }
      }
    }
  } finally {
    clearTimeout(relogio);
    enc.stdin.end();
  }
  const [cd, ce] = await Promise.all([fimDec, fimEnc]);
  if (cd !== 0 || ce !== 0 || !k) throw Object.assign(new Error("Não consegui separar a pessoa do fundo neste vídeo."), { saida: erroDec + erroEnc });
  return { quadros: k, W, H };
}
