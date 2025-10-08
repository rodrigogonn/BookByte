import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import {
  compactTextForPrompt,
  extractTextFromPdfRange,
  formatNumber,
  saveToFile,
  generateProcessId,
  countTokens,
  splitByTokensElastic,
  computeChapterSegmentationParams,
} from './utils';
import {
  extractBookCategoriesAndDescription,
  extractBookInfo,
  summarizeAndFormatChapter,
  buildGlobalGuide,
  summarizeChapterWithContext,
  Chapter,
  GlobalGuide,
} from './prompts';
import { z } from 'zod';
import { MAX_DATA_FOR_PROMPT } from './constants/prompt';
import { middlewares } from './middlewares';
import cors from 'cors';

const app = express();
const upload = multer({ dest: 'uploads/' });

// Arquivos padrão centralizados
const FILES = {
  bookFinal: 'book_final.json',
  bookInfo: 'book_info.json',
  bookComplete: 'book_complete.txt',
  chapterBoundaries: 'chapter_boundaries.json',
  bookGlobalGuide: 'book_global_guide.json',
  guideChunksCount: 'guide_chunks_count.txt',
  guideChunksStats: 'guide_chunks_stats.json',
};

// Utilitários de nome de diretório reutilizáveis
const stripDiacritics = (s: string) =>
  (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const sanitizeDirName = (name: string) =>
  stripDiacritics(name)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[^\w\s\-\.\(\)&]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
const extractBaseIdFromProcessDir = (dir: string) => (dir || '').split(' (')[0];

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const ChapterSchema = z.object({
  title: z.string().min(1, 'Nome do capítulo é obrigatório'),
  startPage: z
    .number()
    .int()
    .positive('Página inicial deve ser um número positivo'),
  endPage: z
    .number()
    .int()
    .positive('Página final deve ser um número positivo')
    .optional(),
});

const ChaptersSchema = z
  .array(ChapterSchema)
  .min(1, 'Deve haver pelo menos um capítulo')
  .superRefine((chapters, ctx) => {
    for (let i = 0; i < chapters.length; i++) {
      const current = chapters[i];

      if (
        current.endPage !== undefined &&
        current.endPage < current.startPage
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Página final deve ser maior ou igual à página inicial',
          path: [i, 'endPage'],
        });
      }

      if (i > 0) {
        const prev = chapters[i - 1];

        if (current.startPage <= prev.startPage) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'startPage deve ser maior que o do capítulo anterior',
            path: [i, 'startPage'],
          });
        }

        if (prev.endPage !== undefined && prev.endPage >= current.startPage) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'endPage do capítulo anterior deve ser menor que startPage do próximo capítulo',
            path: [i - 1, 'endPage'],
          });
        }
      }
    }
  });

const UploadRequestSchema = z.object({
  chapters: z
    .string()
    .transform((str, ctx) => {
      try {
        return JSON.parse(str);
      } catch (e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid JSON string',
        });
        return z.NEVER;
      }
    })
    .pipe(ChaptersSchema),
});

interface Book {
  title: string;
  author: string;
  description: string;
  chapters: Array<{
    title: string;
    content: object[];
  }>;
  categoryIds: number[];
}

// Função para processar um único capítulo
async function processChapter(
  chapter: { title: string; startPage: number; endPage?: number },
  index: number,
  chapters: Array<{ title: string; startPage: number; endPage?: number }>,
  filePath: string,
  processId: string
) {
  const endPage =
    chapter.endPage ||
    (index < chapters.length - 1
      ? chapters[index + 1].startPage - 1
      : undefined);

  // Extrai texto do PDF
  const chapterText = await extractTextFromPdfRange({
    filePath,
    startPage: chapter.startPage,
    endPage: endPage,
  });

  // Salva texto bruto
  await saveToFile(`${chapter.title}_raw.txt`, chapterText, {
    subDir: processId,
  });

  // Compacta texto
  const compactedChapterText = await compactTextForPrompt(chapterText);

  // Salva texto compactado
  await saveToFile(`${chapter.title}_compacted.txt`, compactedChapterText, {
    subDir: processId,
  });

  // Calcula e salva métricas
  const pageCount = endPage ? endPage - chapter.startPage + 1 : 1;
  const metrics = {
    title: chapter.title,
    pageCount,
    originalLength: chapterText.length,
    compactedLength: compactedChapterText.length,
    startPage: chapter.startPage,
    endPage: endPage || 'final',
    compressionRatio:
      ((compactedChapterText.length / chapterText.length) * 100).toFixed(2) +
      '%',
  };

  await saveToFile(`${chapter.title}_metrics.json`, metrics, {
    subDir: processId,
  });

  console.log(
    `📊 Capítulo "${chapter.title}": ${pageCount} páginas, ${formatNumber(
      chapterText.length
    )} caracteres originais, ${formatNumber(
      compactedChapterText.length
    )} caracteres após compactação.`
  );

  // Formata capítulo
  const chapterFormatted = await summarizeAndFormatChapter(
    compactedChapterText,
    pageCount
  );

  // Salva capítulo formatado
  await saveToFile(
    `${chapter.title}_formatted.json`,
    { title: chapter.title, content: chapterFormatted },
    { subDir: processId }
  );

  return {
    title: chapter.title,
    content: chapterFormatted,
  };
}

app.post(
  '/rerun-categories-from-outputs',
  middlewares.adminAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const bodySchema = z.object({
        processDir: z.string().min(1, 'processDir é obrigatório'),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'Dados inválidos', details: parsed.error.errors });
        return;
      }

      const { processDir } = parsed.data;
      const baseDir = path.join('outputs', processDir);

      // Lê book_final.json existente
      const bookFinalPath = path.join(baseDir, 'book_final.json');
      const bookFinalStr = await fs.readFile(bookFinalPath, 'utf-8');
      const bookFinal = JSON.parse(bookFinalStr);

      // Recalcula categorias e descrição a partir de book_data ou book_final
      const bookDataLike = {
        title: bookFinal.title,
        author: bookFinal.author,
        chapters: bookFinal.chapters,
      };
      const rerunId = `rerun_${generateProcessId()}`;
      const rerunSubDir = path.join(processDir, rerunId);
      const { categoryIds, description } =
        await extractBookCategoriesAndDescription(
          JSON.stringify(bookDataLike),
          { subDir: rerunSubDir }
        );

      // Atualiza e salva novo book_final no subdiretório de rerun
      const updated = { ...bookFinal, categoryIds, description };
      await saveToFile('book_final.json', updated, { subDir: rerunSubDir });
      await saveToFile(
        'rerun_info.json',
        {
          sourceProcessDir: processDir,
          rerunId,
          action: 'rerun_categories',
          timestamp: new Date().toISOString(),
        },
        { subDir: rerunSubDir }
      );

      res.json({
        saved: true,
        outputDir: path.join('outputs', rerunSubDir),
        categoryIds,
        description,
      });
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ error: 'Erro ao recalcular categorias/descrição do livro.' });
    }
  }
);

// Retoma um processamento anterior e continua do capítulo seguinte ao último salvo
app.post(
  '/resume-extract-auto',
  middlewares.adminAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const bodySchema = z.object({
        processDir: z.string().min(1, 'processDir é obrigatório'),
      });

      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'Dados inválidos', details: parsed.error.errors });
        return;
      }

      const { processDir } = parsed.data;

      const baseDir = path.join('outputs', processDir);
      // Leitura de artefatos necessários
      // Leitura obrigatória: texto completo
      const bookTxt = await fs.readFile(
        path.join(baseDir, FILES.bookComplete),
        'utf-8'
      );
      const bookText = bookTxt.toString();

      // Tenta ler guia e fronteiras; se ausentes, gera (mesma lógica do extract-auto)
      let guide: GlobalGuide;
      try {
        const guideStr = await fs.readFile(
          path.join(baseDir, FILES.bookGlobalGuide),
          'utf-8'
        );
        guide = JSON.parse(guideStr.toString());
      } catch {
        // Gera guia a partir do texto completo (mesmos parâmetros do extract-auto)
        const GUIDE_INPUT_TOKENS = 26000;
        const GUIDE_OVERLAP_TOKENS = 1000;
        const guideChunks = splitByTokensElastic(
          bookText,
          GUIDE_INPUT_TOKENS,
          GUIDE_OVERLAP_TOKENS
        );
        await saveToFile(
          FILES.guideChunksCount,
          `chunks: ${guideChunks.chunks.length}`,
          { subDir: processDir }
        );
        const guideStats = guideChunks.chunks.map((c, i) => ({
          index: i + 1,
          chars: c.length,
          tokens: countTokens(c, 'gpt-5-mini'),
        }));
        await saveToFile(FILES.guideChunksStats, guideStats, {
          subDir: processDir,
        });
        guide = await buildGlobalGuide(guideChunks.chunks, {
          subDir: processDir,
        });
        await saveToFile(FILES.bookGlobalGuide, guide, {
          subDir: processDir,
        });
      }

      let boundaries: Array<{ start: number; end: number; tokens: number }>;
      try {
        const boundariesStr = await fs.readFile(
          path.join(baseDir, FILES.chapterBoundaries),
          'utf-8'
        );
        boundaries = JSON.parse(boundariesStr.toString());
      } catch {
        // Gera fronteiras se ausente
        const totalBookTokens = countTokens(bookText, 'gpt-5-mini');
        const {
          chapterInputTokens: CHAPTER_INPUT_TOKENS,
          chapterOverlapTokens: CHAPTER_OVERLAP_TOKENS,
        } = computeChapterSegmentationParams(totalBookTokens);
        const { boundaries: newBoundaries } = splitByTokensElastic(
          bookText,
          CHAPTER_INPUT_TOKENS,
          CHAPTER_OVERLAP_TOKENS
        );
        boundaries = newBoundaries;
        await saveToFile(FILES.chapterBoundaries, boundaries, {
          subDir: processDir,
        });
      }

      // Descobre último capítulo salvo contínuo (chapter_01, chapter_02, ...)
      let lastIdx = 0; // zero-based do último já existente
      for (let i = 1; i <= boundaries.length; i++) {
        const fname = `chapter_${String(i).padStart(2, '0')}_formatted.json`;
        try {
          await fs.access(path.join(baseDir, fname));
          lastIdx = i; // i existe (1-based)
        } catch {
          break; // primeiro ausente
        }
      }

      if (lastIdx >= boundaries.length) {
        // Nada a fazer; já completo
        res.json({
          message: 'Processo já concluído. Nenhum capítulo pendente.',
        });
        return;
      }

      console.log(
        `⏯️ Retomando processamento em ${processDir} a partir do capítulo ${
          lastIdx + 1
        }/${boundaries.length}`
      );

      // Prev capítulo formatado (se houver)
      let prevChapterFormatted: Chapter | undefined;
      if (lastIdx > 0) {
        try {
          const prevStr = await fs.readFile(
            path.join(
              baseDir,
              `chapter_${String(lastIdx).padStart(2, '0')}_formatted.json`
            ),
            'utf-8'
          );
          const prevJson = JSON.parse(prevStr);
          if (prevJson && Array.isArray(prevJson.content)) {
            prevChapterFormatted = {
              title: prevJson.title || '',
              content: prevJson.content,
            };
          }
        } catch {}
      }

      // Itera capítulos pendentes
      for (let idx = lastIdx; idx < boundaries.length; idx++) {
        const { start, end } = boundaries[idx];
        const chapterText = bookText.slice(start, end);
        console.log(
          `🔄 [RESUME] Capítulo ${idx + 1}/${
            boundaries.length
          } | ${formatNumber(chapterText.length)} chars, ${formatNumber(
            countTokens(chapterText, 'gpt-5-mini')
          )} tokens`
        );

        const out = await summarizeChapterWithContext({
          chapterText,
          guide,
          prevChapterFormatted,
          targetTokens: 800,
          options: { subDir: processDir, chapterIndex: idx },
        });

        // Atualiza prev para próximo
        prevChapterFormatted = { title: out.title, content: out.content };

        await saveToFile(
          `chapter_${String(idx + 1).padStart(2, '0')}_formatted.json`,
          { title: out.title, content: out.content },
          { subDir: processDir }
        );
      }

      // Recompõe capítulos finais em ordem
      const allChapters: Array<{ title: string; content: object[] }> = [];
      for (let i = 1; i <= boundaries.length; i++) {
        const str = await fs.readFile(
          path.join(
            baseDir,
            `chapter_${String(i).padStart(2, '0')}_formatted.json`
          ),
          'utf-8'
        );
        const js = JSON.parse(str);
        allChapters.push({ title: js.title, content: js.content });
      }

      // Garante metadados (title/author); se inexistente, extrai a partir de amostra
      let title = '';
      let author = '';
      try {
        const infoStr = await fs.readFile(
          path.join(baseDir, FILES.bookInfo),
          'utf-8'
        );
        const info = JSON.parse(infoStr);
        title = info.title || '';
        author = info.author || '';
      } catch {
        const sample =
          bookText.slice(0, MAX_DATA_FOR_PROMPT / 10) +
          bookText.slice(-(MAX_DATA_FOR_PROMPT / 10));
        await saveToFile('book_metadata_input.txt', sample, {
          subDir: processDir,
        });
        const info = await extractBookInfo(sample, { subDir: processDir });
        title = info.title || '';
        author = info.author || '';
        await saveToFile(
          FILES.bookInfo,
          { title, author },
          { subDir: processDir }
        );
      }

      const bookData = { title, author, chapters: allChapters };
      await saveToFile('book_data.json', bookData, { subDir: processDir });

      const { categoryIds, description } =
        await extractBookCategoriesAndDescription(JSON.stringify(bookData), {
          subDir: processDir,
        });

      const book = {
        title,
        author,
        description,
        chapters: allChapters,
        categoryIds,
      };
      await saveToFile(FILES.bookFinal, book, { subDir: processDir });

      // Renomeia pasta no final do resume para baseId + (Título)
      try {
        const baseId = extractBaseIdFromProcessDir(processDir);
        const safeTitle = sanitizeDirName(title);
        if (baseId && safeTitle) {
          const currentDir = path.join('outputs', processDir);
          const newDirName = `${baseId} (${safeTitle})`;
          const newDirPath = path.join('outputs', newDirName);
          if (currentDir !== newDirPath) {
            await fs.rename(currentDir, newDirPath);
            console.log(
              `📁 [RESUME] Pasta renomeada para: outputs/${newDirName}`
            );
          }
        }
      } catch (e) {
        console.warn('⚠️ [RESUME] Não foi possível renomear a pasta:', e);
      }

      res.json({
        resumed: true,
        processDir,
        chapters: allChapters.length,
        title,
        author,
        categoryIds,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao retomar processamento.' });
    }
  }
);

// Rota de estatísticas do livro: calcula tokens e estimativas de segmentação/saída
app.post(
  '/extract-auto',
  middlewares.adminAuth,
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: 'Nenhum arquivo enviado.' });
      return;
    }

    try {
      const t0 = Date.now();
      const baseId = generateProcessId();
      const sanitizeDirName = (name: string) =>
        (name || '')
          .replace(/[\\/:*?"<>|]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
      const stripDiacritics = (s: string) =>
        (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const originalNameRaw = req.file.originalname || req.file.filename || '';
      const safeFileBase = sanitizeDirName(
        stripDiacritics(path.parse(originalNameRaw).name)
      );
      const processId = safeFileBase ? `${baseId} (${safeFileBase})` : baseId;
      await saveToFile(
        'info.txt',
        'Iniciando processamento automático por tokens...',
        { subDir: processId }
      );
      console.log(`📁 Salvando outputs em: outputs/${processId}`);

      // 1) Extrai texto completo do livro
      const bookText = await extractTextFromPdfRange({
        filePath: req.file.path,
        startPage: 1,
      });
      await saveToFile(FILES.bookComplete, bookText, { subDir: processId });

      const MAX_BOOK_TOKENS = 2_000_000;
      const totalCharsEarly = bookText.length;
      const totalTokensEarly = countTokens(bookText, 'gpt-5-mini');
      await saveToFile(
        'book_size.json',
        {
          totalChars: totalCharsEarly,
          totalTokens: totalTokensEarly,
          maxTokens: MAX_BOOK_TOKENS,
          status: totalTokensEarly > MAX_BOOK_TOKENS ? 'exceeds_limit' : 'ok',
        },
        { subDir: processId }
      );
      if (totalTokensEarly > MAX_BOOK_TOKENS) {
        const msg =
          `Tamanho do livro excede o limite: ${formatNumber(
            totalTokensEarly
          )} tokens > ${formatNumber(MAX_BOOK_TOKENS)} tokens. ` +
          'Processo abortado em /extract-auto.';
        console.error(`❌ [SIZE] ${msg}`);
        await saveToFile('error_size_limit.txt', msg, { subDir: processId });
        res.status(413).json({
          error: 'Livro muito grande',
          totalTokens: totalTokensEarly,
          maxTokens: MAX_BOOK_TOKENS,
        });
        return;
      }

      // 2) Constrói GUIA GLOBAL via map-reduce em chunks grandes (aumentado)
      const GUIDE_INPUT_TOKENS = 26000;
      const GUIDE_OVERLAP_TOKENS = 1000;
      const guideChunks = splitByTokensElastic(
        bookText,
        GUIDE_INPUT_TOKENS,
        GUIDE_OVERLAP_TOKENS
      );
      await saveToFile(
        FILES.guideChunksCount,
        `chunks: ${guideChunks.chunks.length}`,
        { subDir: processId }
      );
      const guideStats = guideChunks.chunks.map((c, i) => ({
        index: i + 1,
        chars: c.length,
        tokens: countTokens(c, 'gpt-5-mini'),
      }));
      await saveToFile(FILES.guideChunksStats, guideStats, {
        subDir: processId,
      });

      const guide = await buildGlobalGuide(guideChunks.chunks, {
        subDir: processId,
      });
      await saveToFile(FILES.bookGlobalGuide, guide, { subDir: processId });

      // 3) Segmenta em "capítulos sintéticos" por tokens (entrada), com overlap (dinâmico por tamanho do livro)
      const totalBookTokens = totalTokensEarly;
      const {
        chapterInputTokens: CHAPTER_INPUT_TOKENS,
        chapterOverlapTokens: CHAPTER_OVERLAP_TOKENS,
      } = computeChapterSegmentationParams(totalBookTokens);
      console.log(
        `🧩 Segmentação dinâmica: livro ${formatNumber(
          totalBookTokens
        )} tokens → ` +
          `${formatNumber(
            CHAPTER_INPUT_TOKENS
          )} tokens/chunk, overlap ${formatNumber(
            CHAPTER_OVERLAP_TOKENS
          )} tokens`
      );
      const { chunks: chapterInputs, boundaries } = splitByTokensElastic(
        bookText,
        CHAPTER_INPUT_TOKENS,
        CHAPTER_OVERLAP_TOKENS
      );
      await saveToFile(FILES.chapterBoundaries, boundaries, {
        subDir: processId,
      });
      const chapStats = chapterInputs.map((c, i) => ({
        index: i + 1,
        chars: c.length,
        tokens: countTokens(c, 'gpt-5-mini'),
      }));
      await saveToFile('chapter_chunks_stats.json', chapStats, {
        subDir: processId,
      });

      const processedChapters: Array<{ title: string; content: object[] }> = [];
      let prevChapterFormatted: Chapter | undefined;

      for (let i = 0; i < chapterInputs.length; i++) {
        const inText = chapterInputs[i];
        console.log(
          `🔄 Resumindo capítulo sintético ${i + 1}/${
            chapterInputs.length
          } | ${formatNumber(inText.length)} chars, ${formatNumber(
            countTokens(inText, 'gpt-5-mini')
          )} tokens`
        );
        const chapterText = inText;

        const chapterOut = await summarizeChapterWithContext({
          chapterText,
          guide,
          prevChapterFormatted,
          targetTokens: 800,
          options: { subDir: processId, chapterIndex: i },
        });

        prevChapterFormatted = {
          title: chapterOut.title,
          content: chapterOut.content,
        };

        await saveToFile(
          `chapter_${String(i + 1).padStart(2, '0')}_formatted.json`,
          {
            title: chapterOut.title,
            content: chapterOut.content,
          },
          { subDir: processId }
        );

        processedChapters.push({
          title: chapterOut.title,
          content: chapterOut.content,
        });
      }

      // 5) Metadata (título/autor) e categorias/descrição
      const startEndSample =
        bookText.slice(0, MAX_DATA_FOR_PROMPT / 10) +
        bookText.slice(-(MAX_DATA_FOR_PROMPT / 10));
      await saveToFile('book_metadata_input.txt', startEndSample, {
        subDir: processId,
      });

      const { title, author } = await extractBookInfo(startEndSample, {
        subDir: processId,
      });
      await saveToFile(
        FILES.bookInfo,
        { title, author },
        { subDir: processId }
      );

      const bookData = { title, author, chapters: processedChapters };
      await saveToFile('book_data.json', bookData, { subDir: processId });

      const { categoryIds, description } =
        await extractBookCategoriesAndDescription(JSON.stringify(bookData), {
          subDir: processId,
        });

      // 6) Resultado final
      const book = {
        title,
        author,
        description,
        chapters: processedChapters,
        categoryIds,
      };

      await saveToFile(FILES.bookFinal, book, { subDir: processId });

      // Salva tempo total do processo (duração formatada)
      const t1 = Date.now();
      const totalMs = t1 - t0;
      const minutes = Math.floor(totalMs / 60000);
      const seconds = Math.floor((totalMs % 60000) / 1000);
      const milliseconds = totalMs % 1000;
      const formatted = `${String(minutes).padStart(2, '0')}:${String(
        seconds
      ).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
      await saveToFile(
        'process_timing.json',
        {
          duration: formatted,
          startedAt: new Date(t0).toISOString(),
          finishedAt: new Date(t1).toISOString(),
        },
        { subDir: processId }
      );

      // Agrega custos: soma todos os arquivos cost_*.json no diretório e grava cost_total.json
      try {
        const baseDir = path.join('outputs', processId);
        const dirents = await fs.readdir(baseDir, { withFileTypes: true });
        let totalUsd = 0;
        let totalBrl = 0;
        const files = dirents
          .filter(
            (d: any) =>
              d.isFile() &&
              d.name.startsWith('cost_') &&
              d.name.endsWith('.json')
          )
          .map((d: any) => d.name);
        for (const f of files) {
          try {
            const buf = await fs.readFile(path.join(baseDir, f), 'utf-8');
            const js = JSON.parse(buf);
            if (typeof js?.usd === 'number') totalUsd += js.usd;
            if (typeof js?.brl === 'number') totalBrl += js.brl;
          } catch {}
        }
        await saveToFile(
          'cost_total.json',
          {
            totalUsd: Number(totalUsd.toFixed(6)),
            totalBrl: Number(totalBrl.toFixed(6)),
            filesCounted: files.length,
          },
          { subDir: processId }
        );
      } catch {}

      // Renomeia a pasta de saída para incluir o nome do livro ao final
      try {
        const safeTitle = sanitizeDirName(book.title);
        if (safeTitle.length > 0) {
          const oldDirPath = path.join('outputs', processId);
          const newDirName = `${baseId} (${safeTitle})`;
          const newDirPath = path.join('outputs', newDirName);
          await fs.rename(oldDirPath, newDirPath);
          console.log(`📁 Pasta renomeada para: outputs/${newDirName}`);
        }
      } catch (e) {
        console.warn('⚠️ Não foi possível renomear a pasta de saída:', e);
      }

      res.json(book);
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ error: 'Erro ao processar o PDF automaticamente.' });
    }
  }
);

const RerunChapterSchema = z.object({
  processDir: z.string().min(1, 'processDir é obrigatório'),
  chapterIndex: z.union([z.string(), z.number()]).transform((val, ctx) => {
    const n = Number(val);
    if (val === undefined || isNaN(n) || !Number.isInteger(n) || n < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'chapterIndex inválido (zero-based e obrigatório)',
      });
      return z.NEVER;
    }
    return n; // zero-based index
  }),
});

app.post(
  '/rerun-chapter-from-outputs',
  middlewares.adminAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = RerunChapterSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'Dados inválidos', details: parsed.error.errors });
        return;
      }

      const { processDir, chapterIndex } = parsed.data;

      const baseDir = path.join('outputs', processDir);
      const rerunId = `rerun_${generateProcessId()}`;
      const rerunSubDir = path.join(processDir, rerunId);

      // Carrega textos e metadados da execução anterior
      const [bookCompleteBuf, boundariesBuf, guideBuf] = await Promise.all([
        fs.readFile(path.join(baseDir, 'book_complete.txt'), 'utf-8'),
        fs.readFile(path.join(baseDir, 'chapter_boundaries.json'), 'utf-8'),
        fs.readFile(path.join(baseDir, 'book_global_guide.json'), 'utf-8'),
      ]);

      const bookTextPrev = bookCompleteBuf.toString();
      const boundaries: Array<{ start: number; end: number; tokens: number }> =
        JSON.parse(boundariesBuf.toString());
      const guide = JSON.parse(guideBuf.toString());

      // Índice zero-based conforme especificação
      if (chapterIndex < 0 || chapterIndex >= boundaries.length) {
        res.status(400).json({
          error: `chapterIndex fora do intervalo 0..${boundaries.length - 1}`,
        });
        return;
      }
      const { start, end } = boundaries[chapterIndex];
      const chapterText = bookTextPrev.slice(start, end);

      // Prev summary: tenta ler o resumo do capítulo anterior (chapterIndex - 1)
      let prevChapterFormatted: Chapter | undefined;
      if (chapterIndex > 0) {
        try {
          const prevOut = await fs.readFile(
            path.join(
              baseDir,
              `chapter_${String(chapterIndex).padStart(2, '0')}_formatted.json`
            ),
            'utf-8'
          );
          const prevJson = JSON.parse(prevOut);
          if (prevJson && Array.isArray(prevJson.content)) {
            prevChapterFormatted = {
              title: prevJson.title || '',
              content: prevJson.content,
            };
          }
        } catch {}
      }

      const TARGET_OUTPUT_TOKENS = 800;

      const chapterOut = await summarizeChapterWithContext({
        chapterText,
        guide,
        prevChapterFormatted,
        targetTokens: TARGET_OUTPUT_TOKENS,
        options: { subDir: rerunSubDir, chapterIndex },
      });

      // Salva capítulo reprocessado
      await saveToFile(
        `chapter_${String(chapterIndex + 1).padStart(2, '0')}_formatted.json`,
        { title: chapterOut.title, content: chapterOut.content },
        { subDir: rerunSubDir }
      );

      // Atualiza book_final.json se existir
      try {
        const bookFinalPath = path.join(baseDir, 'book_final.json');
        const bookFinalStr = await fs.readFile(bookFinalPath, 'utf-8');
        const bookFinal = JSON.parse(bookFinalStr);
        if (
          Array.isArray(bookFinal.chapters) &&
          bookFinal.chapters[chapterIndex]
        ) {
          bookFinal.chapters[chapterIndex] = {
            title: chapterOut.title,
            content: chapterOut.content,
          };
          await saveToFile('book_final.json', bookFinal, {
            subDir: rerunSubDir,
          });
        }
      } catch {}

      // Salva metadados da rerun
      await saveToFile(
        'rerun_info.json',
        {
          sourceProcessDir: processDir,
          rerunId,
          chapterIndex,
          targetOutputTokens: TARGET_OUTPUT_TOKENS,
          timestamp: new Date().toISOString(),
        },
        { subDir: rerunSubDir }
      );

      res.json({
        chapterIndex,
        title: chapterOut.title,
        contentLength: chapterOut.content.length,
        saved: true,
        outputDir: path.join('outputs', rerunSubDir),
      });
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ error: 'Erro ao reprocessar capítulo a partir de outputs.' });
    }
  }
);

// Rota de estatísticas do livro: calcula tokens e estimativas de segmentação/saída
app.post(
  '/stats',
  middlewares.adminAuth,
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({
          error: 'Envie um arquivo PDF para calcular as estatísticas.',
        });
        return;
      }

      // Carrega texto do livro
      const bookText = await extractTextFromPdfRange({
        filePath: req.file.path,
        startPage: 1,
      });

      const totalChars = bookText.length;
      const totalTokens = countTokens(bookText, 'gpt-5-mini');

      // Parâmetros de segmentação reutilizáveis
      const {
        chapterInputTokens: CHAPTER_INPUT_TOKENS,
        chapterOverlapTokens: CHAPTER_OVERLAP_TOKENS,
      } = computeChapterSegmentationParams(totalTokens);

      // Estima segmentação real usando o mesmo splitter
      const { chunks } = splitByTokensElastic(
        bookText,
        CHAPTER_INPUT_TOKENS,
        CHAPTER_OVERLAP_TOKENS
      );
      const numChapters = chunks.length;

      // Saída estimada por capítulo
      const targetOutputTokens =
        Number(req.query.targetOutputTokens || req.body?.targetOutputTokens) ||
        800;
      const effectiveFactor = 0.5; // mesmo fator do prompt
      const estimatedOutputTotal = numChapters * targetOutputTokens;

      res.json({
        totalChars,
        totalTokens,
        segmentation: {
          chapterInputTokens: CHAPTER_INPUT_TOKENS,
          overlapTokens: CHAPTER_OVERLAP_TOKENS,
          estimatedChapters: numChapters,
        },
        output: {
          targetOutputTokens,
          estimatedOutputTotal,
        },
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao gerar estatísticas.' });
    }
  }
);
app.post(
  '/extract',
  middlewares.adminAuth,
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: 'Nenhum arquivo enviado.' });
      return;
    }

    try {
      const result = UploadRequestSchema.safeParse(req.body);

      if (!result.success) {
        res.status(400).json({
          error: 'Formato inválido da lista de capítulos',
          details: result.error.errors,
        });
        return;
      }

      const { chapters } = result.data;

      // Cria diretório com timestamp para este processamento
      const processId = generateProcessId();

      await saveToFile('info.txt', 'Iniciando processamento...', {
        subDir: processId,
      });
      console.log(`📁 Salvando outputs em: outputs/${processId}`);

      // Opção para processamento paralelo (hardcoded como false para evitar rate limit)
      const PROCESS_PARALLEL = false;

      // Processa cada capítulo
      const processedChapters = [];

      if (PROCESS_PARALLEL) {
        // Processamento paralelo (pode exceder rate limit)
        const parallelResults = await Promise.all(
          chapters.map(async (chapter, index) =>
            processChapter(chapter, index, chapters, req.file!.path, processId)
          )
        );
        processedChapters.push(...parallelResults);
      } else {
        // Processamento sequencial (evita rate limit)
        for (let index = 0; index < chapters.length; index++) {
          const chapter = chapters[index];
          console.log(
            `🔄 Processando capítulo ${index + 1}/${chapters.length}: "${
              chapter.title
            }"`
          );

          const processedChapter = await processChapter(
            chapter,
            index,
            chapters,
            req.file!.path,
            processId
          );
          processedChapters.push(processedChapter);
        }
      }

      // Extrai e salva texto completo do livro
      const bookText = await extractTextFromPdfRange({
        filePath: req.file.path,
        startPage: 1,
      });
      await saveToFile('book_complete.txt', bookText, { subDir: processId });

      // Processa páginas iniciais e finais para metadata
      const startPages = bookText.slice(0, MAX_DATA_FOR_PROMPT / 10);
      const endPages = bookText.slice(-(MAX_DATA_FOR_PROMPT / 10));
      const startEndPages = startPages + endPages;

      await saveToFile('book_metadata_input.txt', startEndPages, {
        subDir: processId,
      });

      // Extrai informações do livro
      const { title, author } = await extractBookInfo(startEndPages);
      await saveToFile(
        'book_info.json',
        { title, author },
        { subDir: processId }
      );

      // Extrai categorias e descrição
      const bookData = {
        title,
        author,
        chapters: processedChapters,
      };

      await saveToFile('book_data.json', bookData, { subDir: processId });

      const { categoryIds, description } =
        await extractBookCategoriesAndDescription(JSON.stringify(bookData));

      // Monta e salva resultado final
      const book: Book = {
        title,
        author,
        description,
        chapters: processedChapters,
        categoryIds,
      };

      await saveToFile('book_final.json', book, { subDir: processId });

      res.json(book);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao processar o PDF.' });
    }
  }
);

const SingleChapterSchema = z
  .object({
    startPage: z.string().transform((str, ctx) => {
      const number = Number(str);
      if (isNaN(number)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Página inicial deve ser um número válido',
        });
        return z.NEVER;
      }
      return number;
    }),
    endPage: z.string().transform((str, ctx) => {
      const number = Number(str);
      if (isNaN(number)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Página final deve ser um número válido',
        });
        return z.NEVER;
      }
      return number;
    }),
  })
  .superRefine((data, ctx) => {
    if (data.endPage < data.startPage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endPage deve ser maior ou igual a startPage',
        path: ['endPage'],
      });
    }
  });

app.post(
  '/extract-single-chapter',
  middlewares.adminAuth,
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: 'Nenhum arquivo enviado.' });
      return;
    }

    try {
      const result = SingleChapterSchema.safeParse(req.body);

      if (!result.success) {
        res.status(400).json({
          error: 'Formato inválido dos dados do capítulo',
          details: result.error.errors,
        });
        return;
      }

      const { startPage, endPage } = result.data;

      // Cria diretório com timestamp para este processamento
      const processId = generateProcessId();

      await saveToFile(
        'info.txt',
        'Iniciando processamento de capítulo único...',
        { subDir: processId }
      );
      console.log(`📁 Salvando outputs em: outputs/${processId}`);

      // Extrai texto do PDF
      const chapterText = await extractTextFromPdfRange({
        filePath: req.file.path,
        startPage,
        endPage,
      });

      // Salva texto bruto
      await saveToFile('chapter_raw.txt', chapterText, { subDir: processId });

      // Compacta texto
      const compactedChapterText = await compactTextForPrompt(chapterText);

      // Salva texto compactado
      await saveToFile('chapter_compacted.txt', compactedChapterText, {
        subDir: processId,
      });

      const pageCount = endPage - startPage + 1;

      // Salva métricas
      const metrics = {
        pageCount,
        originalLength: chapterText.length,
        compactedLength: compactedChapterText.length,
        startPage,
        endPage,
        compressionRatio:
          ((compactedChapterText.length / chapterText.length) * 100).toFixed(
            2
          ) + '%',
      };

      await saveToFile('chapter_metrics.json', metrics, { subDir: processId });

      console.log(
        `📊 Processando capítulo único: ${pageCount} páginas, ${formatNumber(
          chapterText.length
        )} caracteres originais, ${formatNumber(
          compactedChapterText.length
        )} caracteres após compactação.`
      );

      const chapterFormatted = await summarizeAndFormatChapter(
        compactedChapterText,
        pageCount
      );

      // Salva capítulo formatado
      await saveToFile(
        'chapter_formatted.json',
        { content: chapterFormatted },
        { subDir: processId }
      );

      res.json({
        originalChapterLength: chapterText.length,
        compactedChapterLength: chapterFormatted.reduce(
          (acc, curr) => acc + curr.text.length,
          0
        ),
        chapterFormatted,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao processar o capítulo do PDF.' });
    }
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
