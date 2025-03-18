import { OpenAI } from 'openai';
import { ChatModel } from 'openai/resources';
import path from 'path';
import fs from 'fs/promises';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model: ChatModel = 'gpt-4o-mini';

export const splitText = (text: string, chunkSize: number): string[] => {
  let chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.substring(i, i + chunkSize));
  }
  return chunks;
};

export const summarizeChunk = async (text: string): Promise<string> => {
  const prompt = `
    Você é um assistente especializado em condensação de textos longos, mantendo **o máximo de informações possíveis**.
    **Seu objetivo NÃO é fazer um resumo curto**, mas sim **reescrever o texto de forma mais eficiente**, sem perder detalhes importantes.

    **Texto original:** ${text}

    **Instruções:**
    - **Use o máximo de espaço disponível** para manter o máximo de detalhes.
    - **Não remova informações essenciais**, apenas elimine redundâncias e reescreva de forma mais concisa.
    - **A narrativa deve ser preservada**, como se fosse um livro condensado, mantendo diálogos, descrições e estrutura original.
    - O resultado deve **ter aproximadamente 80% do tamanho original**.

    Retorne apenas o texto condensado, sem introduções ou explicações adicionais.
  `;

  const response = await openai.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 16000,
  });

  if (!response.choices[0].message.content) {
    throw new Error('Nenhum conteúdo retornado pelo modelo');
  }

  return response.choices[0].message.content.trim();
};

export const formatSummary = async (summary: string): Promise<object> => {
  const prompt = `
    Pegue o seguinte livro e reestruture-o mantendo **o estilo e a voz original do autor**.
    O resultado deve parecer que foi escrito pelo próprio autor, como uma versão condensada do livro.
    **Não explique a história, apenas reescreva-a com fluidez, mantendo todos os detalhes essenciais.**

    **Regras obrigatórias:**
    - **Cada capítulo deve ser mantido separadamente** e estruturado corretamente.
    - **NÃO combine capítulos diferentes.** Se o livro tem 6 capítulos, o resumo final deve ter 6 capítulos.
    - **Cada capítulo deve ter mais de 3000 palavras.** Você **NÃO** pode encerrar um capítulo com menos do que isso.
    - **Use o máximo de espaço disponível (até 16k tokens).**
    - **Evite resumos curtos ou generalizações.** O objetivo é condensar, mas sem perder riqueza narrativa.
    - **Preserve diálogos e descrições.** Se necessário, reconstrua cenas para manter o fluxo narrativo.
    
    **Importante:**  
    - Se os capítulos não estiverem claramente definidos no texto original, **crie divisões lógicas coerentes**.  
    - Mas **NÃO MESCLE capítulos distintos em um só**.  
    - Cada capítulo deve começar com um **título claro** e deve conter **seu próprio conteúdo separado**.

    **Exemplo de estrutura esperada de um capítulo:**
    ---
    **Title:** A Jornada Começa  
    **Content:**  
    [Aqui um capítulo reescrito com riqueza de detalhes, diálogos, desenvolvimento de personagens e contexto narrativo completo.]
    ---

    **Livro completo a ser reescrito:** ${summary}

    Retorne no seguinte formato JSON:
    {
        "chapters": [
            {
                "title": "Título do Capítulo",
                "content": "Texto do capítulo, escrito no estilo do autor e mantendo a narrativa original."
            }
        ]
    }
  `;

  const response = await openai.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 16000,
    response_format: { type: 'json_object' },
  });

  if (!response.choices[0].message.content) {
    throw new Error('Nenhum conteúdo retornado pelo modelo');
  }

  return JSON.parse(response.choices[0].message.content);
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
