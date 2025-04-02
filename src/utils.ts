import path from 'path';
import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import pdfParse from 'pdf-parse';
import { MAX_DATA_FOR_PROMPT } from './constants/prompt';
import { summarizeChunk } from './prompts';

export const splitText = (text: string, chunkSize: number): string[] => {
  let chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.substring(i, i + chunkSize));
  }
  return chunks;
};

const OUTPUT_DIR = './outputs';
export const saveToFile = async (filename: string, content: string) => {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const filePath = path.join(OUTPUT_DIR, filename);
    await fs.writeFile(filePath, content, 'utf-8');
    console.log(`Arquivo salvo: ${filePath}`);
  } catch (error) {
    console.error('Erro ao salvar arquivo:', error);
  }
};

export const formatNumber = (number: number) => {
  return number.toLocaleString('pt-BR');
};

interface ExtractPdfOptions {
  filePath: string;
  startPage: number;
  endPage?: number;
}

/**
 * Extrai texto de um intervalo de páginas de um PDF.
 * @param options Objeto com as opções de extração
 * @param options.filePath Caminho do PDF
 * @param options.startPage Página inicial (base 1)
 * @param options.endPage Página final opcional (inclusive, base 1). Se não especificado, extrai até o final do documento
 */
export async function extractTextFromPdfRange(
  options: ExtractPdfOptions
): Promise<string> {
  const { filePath, startPage, endPage } = options;
  const existingPdfBytes = await fs.readFile(filePath);

  // Carrega o PDF original
  const originalPdf = await PDFDocument.load(existingPdfBytes);

  const totalPages = originalPdf.getPageCount();
  const start = Math.max(0, startPage - 1);
  const end = endPage ? Math.min(endPage, totalPages) : totalPages;

  // Cria novo PDF apenas com as páginas desejadas
  const newPdf = await PDFDocument.create();
  const pagesToCopy = await newPdf.copyPages(
    originalPdf,
    Array.from({ length: end - start }, (_, i) => i + start)
  );
  pagesToCopy.forEach((page) => newPdf.addPage(page));

  const newPdfBytes = await newPdf.save();

  // Usa pdf-parse para extrair texto do novo PDF em memória
  const data = await pdfParse(Buffer.from(newPdfBytes));

  return data.text;
}

const CHUNK_SIZE = 50000;
export async function compactTextForPrompt(text: string): Promise<string> {
  if (text.length <= MAX_DATA_FOR_PROMPT) {
    return text;
  }

  let chunks = splitText(text, CHUNK_SIZE);

  console.log(
    `Texto inicial dividido em ${formatNumber(chunks.length)} partes.`
  );

  while (text.length > MAX_DATA_FOR_PROMPT) {
    for (let i = 0; i < chunks.length; i++) {
      console.log(
        `Resumindo parte ${i + 1}/${chunks.length}... (${formatNumber(
          chunks[i].length
        )} caracteres)`
      );

      const summarizedChunk = await summarizeChunk(chunks[i]);
      chunks[i] = summarizedChunk;

      console.log(
        `Resumo da parte ${i + 1}: ${formatNumber(chunks[i].length)} caracteres`
      );

      text = chunks.join('\n\n');
      console.log(
        `Tamanho atual após resumo parcial: ${formatNumber(
          text.length
        )} caracteres.`
      );

      if (text.length <= MAX_DATA_FOR_PROMPT) {
        console.log(`Texto final cabe dentro do limite. Resumo finalizado.`);
        return text;
      }
    }

    console.log(
      `Resumo ainda grande (${formatNumber(
        text.length
      )} caracteres). Dividindo novamente...`
    );
    chunks = splitText(text, CHUNK_SIZE);
  }

  await saveToFile('summary.json', text);

  console.log(
    `Resumo final gerado com ${formatNumber(text.length)} caracteres.`
  );
  return text;
}
