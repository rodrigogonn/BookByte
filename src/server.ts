import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import multer from 'multer';
import { processPDF } from './summarizer';
import { formatSummary, saveToFile } from './utils';

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json({ limit: '50mb' }));

app.post(
  '/upload',
  upload.single('file'),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'Nenhum arquivo enviado.' });
      return;
    }

    try {
      const summary = await processPDF(req.file.path);

      await saveToFile('summary.json', JSON.stringify(summary, null, 2));

      res.json(summary);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao processar o PDF.' });
    }
  }
);

app.post('/summary', async (req: Request, res: Response) => {
  if (!req.body.text) {
    res.status(400).json({ error: 'Nenhum texto enviado.' });
    return;
  }

  try {
    const summary = await formatSummary(req.body.text);

    await saveToFile('summary.json', JSON.stringify(summary, null, 2));

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
