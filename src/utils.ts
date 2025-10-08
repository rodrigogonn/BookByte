import path from 'path';
import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import pdfParse from 'pdf-parse';
import { MAX_DATA_FOR_PROMPT } from './constants/prompt';
import { summarizeChunk } from './prompts';
import { encoding_for_model, get_encoding, TiktokenModel } from 'tiktoken';

export const splitText = (text: string, chunkSize: number): string[] => {
  let chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.substring(i, i + chunkSize));
  }
  return chunks;
};

const OUTPUT_DIR = './outputs';

interface SaveOptions {
  subDir?: string;
}

export const saveToFile = async (
  filename: string,
  content: string | object,
  options?: SaveOptions
) => {
  try {
    // Cria diretório base
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Define diretório alvo
    let targetDir = OUTPUT_DIR;
    if (options?.subDir) {
      targetDir = path.join(OUTPUT_DIR, options.subDir);
      await fs.mkdir(targetDir, { recursive: true });
    }

    const filePath = path.join(targetDir, filename);

    // Formata o conteúdo baseado na extensão do arquivo
    const contentToSave =
      typeof content === 'string' || filename.endsWith('.txt')
        ? Buffer.from(content.toString(), 'utf-8')
        : JSON.stringify(content, null, 2);

    await fs.writeFile(filePath, contentToSave);
    console.log(`✅ Arquivo salvo: ${filePath}`);

    return filePath;
  } catch (error) {
    console.error('❌ Erro ao salvar arquivo:', error);
    throw error;
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

export const generateProcessId = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    '0'
  )}-${String(now.getDate()).padStart(2, '0')}_${String(
    now.getHours()
  ).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
};

const CHUNK_SIZE = 50000;
export async function compactTextForPrompt(text: string): Promise<string> {
  if (text.length <= MAX_DATA_FOR_PROMPT) {
    console.log(
      `Texto inicial (${formatNumber(
        text.length
      )} caracteres) cabe dentro do limite. Retornando texto original.`
    );
    return text;
  }

  let chunks = splitText(text, CHUNK_SIZE);

  console.log(
    `Texto inicial (${formatNumber(
      text.length
    )} caracteres) dividido em ${formatNumber(chunks.length)} partes.`
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

  await saveToFile('summary.json', text, { subDir: 'temp' });

  console.log(
    `Resumo final gerado com ${formatNumber(text.length)} caracteres.`
  );
  return text;
}

// ===== Tokenização e segmentação por tokens (elástica) =====

export function countTokens(text: string, model: TiktokenModel): number {
  let enc;
  try {
    enc = encoding_for_model(model);
  } catch {
    enc = get_encoding('o200k_base');
  }
  const n = enc.encode(text).length;
  enc.free();
  return n;
}

function getEncoder(model: TiktokenModel) {
  try {
    return encoding_for_model(model);
  } catch {
    return get_encoding('o200k_base');
  }
}

function isSentenceEnd(ch: string) {
  return /[.!?]/.test(ch);
}

/**
 * Divide um texto por tokens com janelas elásticas, respeitando parágrafos/frases
 * e adicionando overlap em caracteres proporcional ao overlap de tokens desejado.
 */
export function splitByTokensElastic(
  text: string,
  targetTokens = 6000,
  overlapTokens = 600,
  tolerance = 0.15 // ±15%
): {
  chunks: string[];
  boundaries: Array<{ start: number; end: number; tokens: number }>;
} {
  const enc = getEncoder('gpt-5-mini');
  const tokens = enc.encode(text);
  const maxTokens = Math.max(100, Math.round(targetTokens * (1 + tolerance)));
  const minTokens = Math.max(50, Math.round(targetTokens * (1 - tolerance)));
  const result: string[] = [];
  const boundaries: Array<{ start: number; end: number; tokens: number }> = [];

  let startTok = 0;
  while (startTok < tokens.length) {
    const endTarget = Math.min(tokens.length, startTok + targetTokens);
    let endTok = Math.min(
      tokens.length,
      endTarget + Math.round(targetTokens * tolerance)
    );

    // converte índices de tokens para índices de caracteres
    const startChar = enc.decode(tokens.slice(0, startTok)).length;
    const maxChar = enc.decode(tokens.slice(0, endTok)).length;

    // janela para buscar melhor corte
    const windowStartTok = Math.max(
      0,
      endTarget - Math.round(targetTokens * tolerance)
    );
    const windowStartChar = enc.decode(tokens.slice(0, windowStartTok)).length;
    const slice = text.slice(windowStartChar, maxChar);

    // prioriza fim de parágrafo
    let bestCut = maxChar;
    let idx = slice.lastIndexOf('\n\n');
    if (idx !== -1) {
      bestCut = windowStartChar + idx;
    } else {
      // tenta fim de frase
      for (let i = slice.length - 1; i >= 0; i--) {
        if (isSentenceEnd(slice[i])) {
          bestCut = windowStartChar + i + 1;
          break;
        }
      }
    }

    if (bestCut <= startChar) bestCut = maxChar;

    const piece = text.slice(startChar, bestCut).trim();
    const pieceTokens = enc.encode(piece).length;

    // Proteção contra chunk vazio
    if (pieceTokens === 0 || piece.length === 0) {
      if (startTok >= tokens.length) break;
      startTok = Math.min(
        tokens.length,
        startTok + Math.max(1, Math.round(targetTokens * 0.5))
      );
      continue;
    }

    // se ficou curto demais, estende um pouco
    if (pieceTokens < minTokens && bestCut < text.length) {
      const extraEnd = Math.min(
        text.length,
        bestCut + Math.round(piece.length * 0.2)
      );
      const extended = text.slice(startChar, extraEnd);
      result.push(extended.trim());
      boundaries.push({
        start: startChar,
        end: extraEnd,
        tokens: enc.encode(extended).length,
      });
      // calcula próximo start com overlap aproximado
      const overlapChars = Math.round(
        extended.length * (overlapTokens / Math.max(1, pieceTokens))
      );
      const nextStartChar = Math.max(
        startChar + extended.length - overlapChars,
        startChar + 1
      );
      startTok = enc.encode(text.slice(0, nextStartChar)).length;
    } else {
      result.push(piece);
      boundaries.push({ start: startChar, end: bestCut, tokens: pieceTokens });
      const overlapChars = Math.round(
        piece.length * (overlapTokens / Math.max(1, pieceTokens))
      );
      const nextStartChar = Math.max(
        startChar + piece.length - overlapChars,
        startChar + 1
      );
      startTok = enc.encode(text.slice(0, nextStartChar)).length;
    }
  }

  enc.free();
  return { chunks: result, boundaries };
}

// ===== Cálculos reutilizáveis para estatísticas/segmentação =====

export function computeChapterSegmentationParams(totalTokens: number): {
  chapterInputTokens: number;
  chapterOverlapTokens: number;
} {
  // Limites de referência de tamanho do livro (tokens)
  const MIN_BOOK_TOKENS = 80000; // ~curto
  const MAX_BOOK_TOKENS = 1200000; // ~muito longo
  // Limites de input por capítulo sintético (tokens)
  const MIN_CH_INPUT = 11000;
  const MAX_CH_INPUT = 40000;
  const clamp = (n: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, n));
  const frac = clamp(
    (totalTokens - MIN_BOOK_TOKENS) /
      Math.max(1, MAX_BOOK_TOKENS - MIN_BOOK_TOKENS),
    0,
    1
  );
  const chapterInputTokens = Math.round(
    MIN_CH_INPUT + frac * (MAX_CH_INPUT - MIN_CH_INPUT)
  );
  const chapterOverlapTokens = Math.round(
    clamp(chapterInputTokens * 0.1, 400, 2000)
  );
  return { chapterInputTokens, chapterOverlapTokens };
}
