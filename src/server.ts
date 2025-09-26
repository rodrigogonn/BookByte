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
} from './utils';
import {
  extractBookCategoriesAndDescription,
  extractBookInfo,
  summarizeAndFormatChapter,
  buildGlobalGuide,
  summarizeChapterWithContext,
} from './prompts';
import { z } from 'zod';
import { MAX_DATA_FOR_PROMPT } from './constants/prompt';
import { middlewares } from './middlewares';
import cors from 'cors';

const app = express();
const upload = multer({ dest: 'uploads/' });

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
  '/extract-auto',
  middlewares.adminAuth,
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: 'Nenhum arquivo enviado.' });
      return;
    }

    try {
      const processId = generateProcessId();
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
      await saveToFile('book_complete.txt', bookText, { subDir: processId });

      // 2) Constrói GUIA GLOBAL via map-reduce em chunks grandes (aumentado)
      const GUIDE_INPUT_TOKENS = 20000;
      const GUIDE_OVERLAP_TOKENS = 2000;
      const guideChunks = splitByTokensElastic(
        bookText,
        GUIDE_INPUT_TOKENS,
        GUIDE_OVERLAP_TOKENS
      );
      await saveToFile(
        'guide_chunks_count.txt',
        `chunks: ${guideChunks.chunks.length}`,
        { subDir: processId }
      );
      const guideStats = guideChunks.chunks.map((c, i) => ({
        index: i + 1,
        chars: c.length,
        tokens: countTokens(c, 'gpt-5-mini'),
      }));
      await saveToFile('guide_chunks_stats.json', guideStats, {
        subDir: processId,
      });

      const guide = await buildGlobalGuide(guideChunks.chunks, {
        subDir: processId,
      });
      await saveToFile('book_global_guide.json', guide, { subDir: processId });

      // 3) Segmenta em "capítulos sintéticos" por tokens (entrada), com overlap (dinâmico por tamanho do livro)
      const totalBookTokens = countTokens(bookText, 'gpt-5-mini');
      // Limites de referência de tamanho do livro (tokens)
      const MIN_BOOK_TOKENS = 80000; // ~curto
      const MAX_BOOK_TOKENS = 900000; // ~muito longo
      // Limites de input por capítulo sintético (tokens)
      const MIN_CH_INPUT = 8000;
      const MAX_CH_INPUT = 14000;
      const clamp = (n: number, lo: number, hi: number) =>
        Math.max(lo, Math.min(hi, n));
      const frac = clamp(
        (totalBookTokens - MIN_BOOK_TOKENS) /
          Math.max(1, MAX_BOOK_TOKENS - MIN_BOOK_TOKENS),
        0,
        1
      );
      const CHAPTER_INPUT_TOKENS = Math.round(
        MIN_CH_INPUT + frac * (MAX_CH_INPUT - MIN_CH_INPUT)
      );
      // Overlap como 10% do input (com limites para evitar excesso)
      const CHAPTER_OVERLAP_TOKENS = Math.round(
        clamp(CHAPTER_INPUT_TOKENS * 0.1, 400, 2000)
      );
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
      await saveToFile('chapter_boundaries.json', boundaries, {
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

      // 4) Resume cada "capítulo" com contexto (guia + microresumo anterior)
      // Alvo padrão reduzido; pode ser override via query ?targetOutputTokens=...
      const TARGET_OUTPUT_TOKENS = (() => {
        const q = Number((req.query as any).targetOutputTokens);
        if (!isNaN(q) && q > 200 && q < 5000) return Math.round(q);
        return 800;
      })();
      console.log(
        `🎯 [CFG] target_output_tokens=${formatNumber(TARGET_OUTPUT_TOKENS)}`
      );
      const processedChapters: Array<{ title: string; content: object[] }> = [];
      let prevSummary: string | undefined = undefined;

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
          prevSummary,
          targetTokens: TARGET_OUTPUT_TOKENS,
        });

        prevSummary = chapterOut.summaryForNext;

        await saveToFile(
          `chapter_${String(i + 1).padStart(2, '0')}_formatted.json`,
          {
            title: chapterOut.title,
            content: chapterOut.content,
            summaryForNext: chapterOut.summaryForNext,
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

      const { title, author } = await extractBookInfo(startEndSample);
      await saveToFile(
        'book_info.json',
        { title, author },
        { subDir: processId }
      );

      const bookData = { title, author, chapters: processedChapters };
      await saveToFile('book_data.json', bookData, { subDir: processId });

      const { categoryIds, description } =
        await extractBookCategoriesAndDescription(JSON.stringify(bookData));

      // 6) Resultado final
      const book = {
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
      res
        .status(500)
        .json({ error: 'Erro ao processar o PDF automaticamente.' });
    }
  }
);

const RerunChapterSchema = z.object({
  processDir: z.string().min(1, 'processDir é obrigatório'),
  chapterIndex: z
    .union([z.string(), z.number()])
    .optional()
    .transform((val, ctx) => {
      if (val === undefined) return 0; // default 0 (zero-based)
      const n = Number(val);
      if (isNaN(n) || !Number.isInteger(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'chapterIndex inválido',
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
      let prevSummary: string | undefined = undefined;
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
          if (typeof prevJson.summaryForNext === 'string') {
            prevSummary = prevJson.summaryForNext;
          }
        } catch {}
      }

      const TARGET_OUTPUT_TOKENS = 800;

      const fileNum = chapterIndex + 1;
      const chapterOut = await summarizeChapterWithContext({
        chapterText,
        guide,
        prevSummary,
        targetTokens: TARGET_OUTPUT_TOKENS,
        options: { subDir: rerunSubDir },
      });

      // Salva capítulo reprocessado
      await saveToFile(
        `chapter_${String(fileNum).padStart(2, '0')}_formatted.json`,
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
