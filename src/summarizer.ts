import fs from 'fs/promises';
import pdfParse from 'pdf-parse';
import { formatSummary, splitText, summarizeChunk } from './utils';

const CHUNK_SIZE = 100000;
const MAX_SUMMARY_SIZE = 250000;

export async function processPDF(filePath: string) {
  try {
    const file = await fs.readFile(filePath);
    const data = await pdfParse(file);
    const text = data.text.replace(/\n{2,}/g, '\n').trim();

    console.log(`Texto original carregado (${text.length} caracteres).`);

    const summary = await summarize(text);

    console.log(`Resumo gerado (${summary.length} caracteres).`);

    const structuredSummary = await formatSummary(summary);

    return { summary, structuredSummary };
  } catch (error) {
    console.error('Erro ao processar o PDF:', error);
    throw new Error('Falha ao processar o arquivo.');
  }
}

async function summarize(text: string): Promise<string> {
  let chunks = splitText(text, CHUNK_SIZE);

  console.log(`Texto inicial dividido em ${chunks.length} partes.`);

  while (text.length > MAX_SUMMARY_SIZE) {
    for (let i = 0; i < chunks.length; i++) {
      console.log(
        `Resumindo parte ${i + 1}/${chunks.length}... (${
          chunks[i].length
        } caracteres)`
      );

      const summarizedChunk = await summarizeChunk(chunks[i]);
      chunks[i] = summarizedChunk;

      console.log(`Resumo da parte ${i + 1}: ${chunks[i].length} caracteres`);

      text = chunks.join('\n\n');
      console.log(
        `Tamanho atual após resumo parcial: ${text.length} caracteres.`
      );

      if (text.length <= MAX_SUMMARY_SIZE) {
        console.log(`Texto final cabe dentro do limite. Resumo finalizado.`);
        return text;
      }
    }

    console.log(
      `Resumo ainda grande (${text.length} caracteres). Dividindo novamente...`
    );
    chunks = splitText(text, CHUNK_SIZE);
  }

  console.log(`Resumo final gerado com ${text.length} caracteres.`);
  return text;
}
