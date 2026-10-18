// Atualiza a aba "Usuários" da planilha de controle com o relatório da Content Post.
// Instalação (uma vez): Extensões › Apps Script, cole este arquivo, salve e rode a função "instalar".
// Ela pede a autorização do Google, grava a chave e passa a atualizar sozinha a cada 10 minutos.

const ENDERECO = "https://api-production-70f3.up.railway.app/relatorio.csv";
const ABA = "Usuários";
const MINUTOS = 10; // o Google aceita 1, 5, 10, 15 ou 30

// Rode uma vez. Troque a chave aqui se ela mudar no Railway (RELATORIO_CHAVE) e rode de novo.
function instalar() {
  PropertiesService.getScriptProperties().setProperty("CHAVE", "COLE_AQUI_A_CHAVE");
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "atualizar").forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("atualizar").timeBased().everyMinutes(MINUTOS).create();
  atualizar();
}

function atualizar() {
  const chave = PropertiesService.getScriptProperties().getProperty("CHAVE");
  if (!chave) throw new Error('Rode a função "instalar" primeiro.');
  const r = UrlFetchApp.fetch(ENDERECO + "?chave=" + encodeURIComponent(chave), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error("O relatório respondeu " + r.getResponseCode() + ": " + r.getContentText().slice(0, 200));
  const linhas = Utilities.parseCsv(r.getContentText("UTF-8"));
  if (!linhas.length) return;
  // Números e datas chegam como texto no CSV; aqui viram número e data de verdade (dá para somar e filtrar).
  const valores = linhas.map((l, i) => (i === 0 ? l : l.map(converter)));
  const aba = SpreadsheetApp.getActive().getSheetByName(ABA) || SpreadsheetApp.getActive().insertSheet(ABA);
  const colunas = valores[0].length;
  if (aba.getMaxColumns() < colunas) aba.insertColumnsAfter(aba.getMaxColumns(), colunas - aba.getMaxColumns());
  // Limpa só a área do relatório: colunas à direita dele ficam livres para anotações.
  const ultima = Math.max(aba.getLastRow(), 1);
  aba.getRange(1, 1, ultima, colunas).clearContent();
  aba.getRange(1, 1, valores.length, colunas).setValues(valores);
  aba.getRange(1, colunas + 1).setValue("Atualizado em " + Utilities.formatDate(new Date(), "America/Sao_Paulo", "dd/MM/yyyy HH:mm"));
}

function converter(v) {
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  const d = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(v);
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(d[4]), Number(d[5]));
  return v;
}
