import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import multer from 'multer';
import {
  compactTextForPrompt,
  extractTextFromPdfRange,
  formatNumber,
  saveToFile,
  generateProcessId,
} from './utils';
import {
  extractBookCategoriesAndDescription,
  extractBookInfo,
  summarizeAndFormatChapter,
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
    .pipe(z.array(ChapterSchema).min(1, 'Deve haver pelo menos um capítulo')),
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

      // Processa cada capítulo
      const processedChapters = await Promise.all(
        chapters.map(async (chapter, index) => {
          const endPage =
            chapter.endPage ||
            (index < chapters.length - 1
              ? chapters[index + 1].startPage - 1
              : undefined);

          // Extrai texto do PDF
          const chapterText = await extractTextFromPdfRange({
            filePath: req.file!.path,
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
          await saveToFile(
            `${chapter.title}_compacted.txt`,
            compactedChapterText,
            { subDir: processId }
          );

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
              (
                (compactedChapterText.length / chapterText.length) *
                100
              ).toFixed(2) + '%',
          };

          await saveToFile(`${chapter.title}_metrics.json`, metrics, {
            subDir: processId,
          });

          console.log(
            `📊 Capítulo "${
              chapter.title
            }": ${pageCount} páginas, ${formatNumber(
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
        })
      );

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

const SingleChapterSchema = z.object({
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
