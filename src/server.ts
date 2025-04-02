import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import multer from 'multer';
import { compactTextForPrompt, extractTextFromPdfRange } from './utils';
import {
  extractBookCategoriesAndDescription,
  extractBookInfo,
  summarizeAndFormatChapter,
  summarizeChunk,
} from './prompts';
import { z } from 'zod';
import { MAX_DATA_FOR_PROMPT } from './constants/prompt';

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json({ limit: '50mb' }));

const ChapterSchema = z.object({
  name: z.string().min(1, 'Nome do capítulo é obrigatório'),
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
    name: string;
    content: object[];
  }>;
  categoryIds: number[];
}

app.post(
  '/upload',
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
            name: chapter.name,
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

app.post('/summarize', async (req: Request, res: Response) => {
  if (!req.body.text) {
    res.status(400).json({ error: 'Nenhum texto enviado.' });
    return;
  }

  try {
    const summary = await summarizeAndFormatChapter(req.body.text);

    res.json(summary);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao processar o PDF.' });
  }
});

app.post('/summarizeChunk', async (req: Request, res: Response) => {
  if (!req.body.text) {
    res.status(400).json({ error: 'Nenhum texto enviado.' });
    return;
  }

  try {
    const summary = await summarizeChunk(req.body.text);

    res.json(summary);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao processar o PDF.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
