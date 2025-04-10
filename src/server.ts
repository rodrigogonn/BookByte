import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import multer from 'multer';
import { compactTextForPrompt, extractTextFromPdfRange } from './utils';
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

      // Processa cada capítulo
      const processedChapters = await Promise.all(
        chapters.map(async (chapter, index) => {
          const endPage =
            index < chapters.length - 1
              ? chapters[index + 1].startPage - 1
              : undefined;

          const chapterText = await extractTextFromPdfRange({
            filePath: req.file!.path,
            startPage: chapter.startPage,
            endPage: endPage,
          });

          const compactedChapterText = await compactTextForPrompt(chapterText);

          const chapterFormatted = await summarizeAndFormatChapter(
            compactedChapterText
          );

          return {
            title: chapter.title,
            content: chapterFormatted,
          };
        })
      );

      const bookText = await extractTextFromPdfRange({
        filePath: req.file.path,
        startPage: 1,
      });
      const startPages = bookText.slice(0, MAX_DATA_FOR_PROMPT / 10);
      const endPages = bookText.slice(-(MAX_DATA_FOR_PROMPT / 10));
      const startEndPages = startPages + endPages;

      const { title, author } = await extractBookInfo(startEndPages);

      const { categoryIds, description } =
        await extractBookCategoriesAndDescription(
          JSON.stringify({
            title,
            author,
            chapters: processedChapters,
          })
        );

      const book: Book = {
        title,
        author,
        description,
        chapters: processedChapters,
        categoryIds,
      };

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

      const chapterText = await extractTextFromPdfRange({
        filePath: req.file.path,
        startPage,
        endPage,
      });

      const compactedChapterText = await compactTextForPrompt(chapterText);

      const chapterFormatted = await summarizeAndFormatChapter(
        compactedChapterText
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
