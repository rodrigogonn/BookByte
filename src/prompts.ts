import { OpenAI } from 'openai';
import { ChatModel } from 'openai/resources';
import { formatNumber, saveToFile } from './utils';
import { categories } from './constants/categories';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model: ChatModel = 'gpt-4o-mini';

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

  const responseContent = response.choices[0].message.content?.trim();

  if (!responseContent) {
    throw new Error('Nenhum conteúdo retornado pelo modelo');
  }

  console.log(
    `Chunk compactado. ${formatNumber(text.length)} -> ${formatNumber(
      responseContent.length
    )} caracteres.`
  );

  return responseContent;
};

export const summarizeAndFormatChapter = async (
  chapterText: string
): Promise<
  Array<{
    text: string;
  }>
> => {
  const prompt = `
    Pegue o seguinte capítulo do livro e o condense mantendo **o estilo e a voz original do autor**.
    O resultado deve parecer que foi escrito pelo próprio autor, como uma versão condensada do livro.
    **Não explique a história, apenas reescreva-a com fluidez, mantendo todos os detalhes essenciais.**

    **Estrutura de Dados:**
    \`\`\`typescript
    enum ContentType {
      PARAGRAPH = 'PARAGRAPH',
      KEY_POINT = 'KEY_POINT'
    }

    enum KeyPointType {
      QUOTE = 'QUOTE',     // Citações e frases memoráveis
      INSIGHT = 'INSIGHT', // Reflexões, lições e conceitos importantes
      MOMENT = 'MOMENT'    // Momentos decisivos da história
    }

    interface Paragraph {
      type: ContentType.PARAGRAPH;
      text: string;
    }

    interface KeyPoint {
      type: ContentType.KEY_POINT;
      keyPointType: KeyPointType;
      text: string;
      reference?: string;    // Quem disse. Somente para keyPointType QUOTE. Obrigatório nesse caso
    }

    type ChapterContent = Paragraph | KeyPoint;

    interface Chapter {
      content: ChapterContent[];
    }
    \`\`\`

    **REGRAS OBRIGATÓRIAS SOBRE TAMANHO:**
    - **Use descrições detalhadas, diálogos completos e desenvolvimento de cenas**
    - Cada parágrafo deve ser extenso, detalhado e conter descrições completas, diálogos e desenvolvimento de cena para manter a riqueza narrativa.
    - O capitulo condensado deve ter aproximadamente 10% do tamanho original.

    **Regras sobre KEY_POINTS:**
    - Pode não ter nenhum se não houver momentos/citações/lições realmente significativas.
    - Insira o KEY_POINT logo após o parágrafo relacionado
    - Inclua a referência nos KEY_POINTS de citação
    - Se o livro for mais ficção e não passar ensinamentos, não inclua KEY_POINTS INSIGHT.
    - Só inclua KEY_POINTS INSIGHT se for uma lição de vida ao leitor. Coisas realmente importantes para o leitor refletir. Não coisas sobre a narrativa que nao podem ser aplicadas ao leitor. Insights precisam ser ideias muito relevantes para o leitor.
      - Se colocar algum insight, verifique se ele é realmente relevante. Se é uma ideia que o leitor vai poder aplicar na sua vida.
      - Só inclua insights que o livro passa. Não invente insights.
    - Só inclua KEY_POINTS QUOTE se for uma frase realmente significativa, que agregue valor ao leitor também. Que dê para refletir. Que não dependa de contexto para ser compreendida. Se incluir alguma QUOTE, coloque a frase exatamente como está no texto original.
      - Se colocar algum quote, verifique se ela é realmente significativa e impactante para o leitor.
      - Se não for uma frase que isolada do contexto agregue valor ao leitor, não inclua. Se for frase relacionada à narrativa, não inclua. Somente frases que podem ser tiradas do contexto e serem aplicadas nossa vida que importam aqui.
      - Não coloque narrativas nos QUOTES, apenas frases que um personagem disse, que isoladas que agreguem valor ao leitor.
      - Ao incluir uma QUOTE, verifique se a frase dela é realmente significativa isolada do contexto e caso não seja, remova.
    - Só inclua KEY_POINTS MOMENT se for um momento realmente decisivo da história.

    **Regras de estrutura:**
    - **Evite resumos curtos ou generalizações.** O objetivo é condensar, mas sem perder riqueza narrativa.
    - **Preserve diálogos importantes e descrições completas para o entendimento do capítulo.**
    
    **Importante:**  
    - **Ler o capitulo condensado deve passar o mesmo conhecimento que passaria lendo o capítulo original inteiro. Não perca informações importantes e conhecimentos que o livro original passa.**
    - **A narrativa deve ser preservada**, como se fosse um livro condensado, mantendo diálogos, descrições e estrutura original.
    - **Não perca informações importantes e conhecimentos que o livro original passa.**

    **Exemplo de estrutura esperada:**
    {
      "content": [
        {
          "type": "PARAGRAPH",
          "text": "Maria encarava o horizonte, suas mãos tremendo levemente enquanto segurava a carta do avô. O sol se punha lentamente, pintando o céu com tons de laranja e rosa, como se a própria natureza quisesse marcar aquele momento."
        },
        {
          "type": "KEY_POINT",
          "keyPointType": "QUOTE",
          "text": "Não são os anos em sua vida que importam, mas a vida em seus anos.",
          "reference": "Avô João"
        },
        {
          "type": "PARAGRAPH",
          "text": "As palavras do avô penetraram fundo em sua alma. Ela dobrou a carta cuidadosamente, guardando-a junto ao peito, e tomou sua decisão."
        },
        {
          "type": "KEY_POINT",
          "keyPointType": "MOMENT",
          "text": "A decisão de Maria de abandonar sua carreira estável para seguir seu verdadeiro sonho marca o ponto de virada em sua jornada"
        }
      ]
    }

    Retorne no formato JSON com a estrutura do exemplo acima.

    **Capítulo a ser reescrito:**
    """
    ${chapterText}
    """    
  `;

  const response = await openai.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 16000,
    response_format: { type: 'json_object' },
    temperature: 0.4,
  });

  if (!response.choices[0].message.content) {
    throw new Error('Nenhum conteúdo retornado pelo modelo');
  }

  const chapterFormatted = JSON.parse(response.choices[0].message.content);

  await saveToFile(
    'chapter_formatted.json',
    JSON.stringify(chapterFormatted, null, 2)
  );

  return chapterFormatted.content;
};

export const extractBookInfo = async (
  text: string
): Promise<{ title: string; author: string }> => {
  const prompt = `
    Analise o seguinte texto e extraia o nome do livro e seu autor.
    Se não conseguir identificar com certeza, retorne valores vazios.

    Retorne no formato JSON com a seguinte estrutura:
    {
      "title": "Nome do Livro",
      "author": "Nome do Autor"
    }

    **Texto:**
    """
    ${text}
    """
  `;

  const response = await openai.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1000,
    response_format: { type: 'json_object' },
  });

  if (!response.choices[0].message.content) {
    throw new Error('Nenhum conteúdo retornado pelo modelo');
  }

  const bookInfo = JSON.parse(response.choices[0].message.content);
  return bookInfo;
};

export const extractBookCategoriesAndDescription = async (
  text: string
): Promise<{ categoryIds: number[]; description: string }> => {
  const categoriesList = categories
    .map((cat) => `- ${cat.id}. ${cat.name}`)
    .join('\n    ');

  const prompt = `
    Analise o seguinte livro e defina as categorias que melhor se encaixam.
    Também defina uma boa descrição do livro para colocar na página inicial do livro.

    **Lista de Categorias Disponíveis:**
    ${categoriesList}

    Retorne no formato JSON com a seguinte estrutura:
    {
      "categoryIds": [1, 2, 3],
      "description": "Descrição do livro"
    }

    **Livro:**
    """
    ${text}
    """
  `;

  const response = await openai.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2000,
    response_format: { type: 'json_object' },
  });

  if (!response.choices[0].message.content) {
    throw new Error('Nenhum conteúdo retornado pelo modelo');
  }

  const bookCategories = JSON.parse(response.choices[0].message.content);
  return bookCategories;
};
