import { OpenAI } from 'openai';
import { ChatModel } from 'openai/resources';
import { formatNumber, saveToFile, countTokens } from './utils';
import { categories } from './constants/categories';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model: ChatModel = 'gpt-5-mini';
const cheapModel: ChatModel = 'gpt-5-nano';

// ===== Estimativa de custo (configurável por ambiente, preços por 1 milhão de tokens) =====
function getPricingPerMillion(model: string): {
  inputPer1M: number;
  outputPer1M: number;
} {
  const mini = {
    inputPer1M: Number(process.env.PRICE_PER_M_GPT5_MINI_IN || 0),
    outputPer1M: Number(process.env.PRICE_PER_M_GPT5_MINI_OUT || 0),
  };
  const nano = {
    inputPer1M: Number(process.env.PRICE_PER_M_GPT5_NANO_IN || 0),
    outputPer1M: Number(process.env.PRICE_PER_M_GPT5_NANO_OUT || 0),
  };
  if (model.includes('nano')) return nano;
  if (model.includes('mini')) return mini;
  return { inputPer1M: 0, outputPer1M: 0 };
}

function estimateCostUSD(args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}) {
  const { model, inputTokens, outputTokens } = args;
  const p = getPricingPerMillion(model);
  const inUsd = (inputTokens / 1_000_000) * p.inputPer1M;
  const outUsd = (outputTokens / 1_000_000) * p.outputPer1M;
  const totalUsd = inUsd + outUsd;
  return {
    usd: Number(totalUsd.toFixed(6)),
    breakdown: {
      inputUsd: Number(inUsd.toFixed(6)),
      outputUsd: Number(outUsd.toFixed(6)),
      inputTokens,
      outputTokens,
    },
  };
}

async function computeAndSaveCost(options: {
  usage?: OpenAI.Completions.CompletionUsage;
  model: string;
  costFileName: string;
  subDir?: string;
}) {
  if (
    !options.usage ||
    options.usage.prompt_tokens == null ||
    options.usage.completion_tokens == null
  ) {
    return null;
  }

  const inputTokens = Number(options.usage.prompt_tokens);
  const outputTokens = Number(options.usage.completion_tokens);

  const cost = estimateCostUSD({
    model: options.model,
    inputTokens,
    outputTokens,
  });

  const pricing = getPricingPerMillion(options.model);
  const payload = {
    usd: cost.usd,
    brl: Number((cost.usd * 5.65).toFixed(6)),
    breakdown: cost.breakdown,
    model: options.model,
    pricingPer1M: pricing,
    usage: options.usage,
  };

  await saveToFile(options.costFileName, payload, { subDir: options.subDir });
  return { inputTokens, outputTokens, cost };
}

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

const calculateCompressionPercentage = (chapterLength: number): number => {
  // Ajusta a porcentagem de compressão com base no tamanho do capítulo
  if (chapterLength > 40000) {
    return 10; // Capítulos muito grandes podem ser mais comprimidos
  } else if (chapterLength > 25000) {
    return 12; // Capítulos grandes
  } else {
    return 15; // Capítulos menores
  }
};

export const summarizeAndFormatChapter = async (
  chapterText: string,
  pageCount: number = 1
): Promise<
  Array<{
    text: string;
  }>
> => {
  // Usa porcentagem fixa para manter proporcionalidade real entre capítulos
  const compressionPercentage = calculateCompressionPercentage(
    chapterText.length
  );
  const charactersPerPage = Math.round(chapterText.length / pageCount);
  const expectedFinalSize = Math.round(
    (chapterText.length * compressionPercentage) / 100
  );

  console.log(
    `Capítulo "${pageCount} páginas, ${formatNumber(
      chapterText.length
    )} caracteres (${formatNumber(
      charactersPerPage
    )} chars/página)" → ${compressionPercentage}% = ~${formatNumber(
      expectedFinalSize
    )} caracteres finais`
  );

  const prompt = `
    Pegue o seguinte capítulo do livro e o condense mantendo **o estilo e a voz original do autor**.
    O resultado deve parecer que foi escrito pelo próprio autor, como uma versão condensada do livro.
    **Não explique a história, apenas reescreva-a com fluidez, mantendo todos os detalhes essenciais.**

    **Regras para o Resumo:**
    - **Mantenha a essência e os eventos principais sem alterar o significado.**
    - **Evite simplificações excessivas que alterem o contexto original.**
    - **Inclua apenas citações que sejam realmente significativas e não misturem narração com falas.**

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
    - O capítulo condensado deve ter aproximadamente ${compressionPercentage}% do tamanho original.
    - **CRUCIAL**: TODOS os capítulos usam a mesma porcentagem (${compressionPercentage}%), garantindo proporcionalidade real.
    - **CONTEXTO**: Este capítulo tem ${pageCount} páginas e ${formatNumber(
    chapterText.length
  )} caracteres.
    - **OBJETIVO DE TAMANHO**: Aproximadamente ${expectedFinalSize} caracteres no resultado final.
    - **PROPORCIONALIDADE**: Capítulos grandes devem gerar resumos grandes, capítulos pequenos geram resumos pequenos - mantendo sempre ${compressionPercentage}%.

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
    - NUNCA use o valor null em nenhum campo. Se um campo opcional não existir, omita-o (não inclua a propriedade no JSON).
    - A propriedade "reference" só deve existir para KEY_POINTS do tipo QUOTE e deve ser uma string não vazia; caso contrário, não inclua "reference".

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
    response_format: { type: 'json_object' },
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
  text: string,
  options?: { subDir?: string }
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
    response_format: { type: 'json_object' },
  });

  if (!response.choices[0].message.content) {
    throw new Error('Nenhum conteúdo retornado pelo modelo');
  }

  const content = response.choices[0].message.content;
  const bookInfo = JSON.parse(content);
  // custo estimado via helper
  try {
    await computeAndSaveCost({
      model,
      costFileName: 'cost_book_info.json',
      subDir: options?.subDir,
      usage: response.usage,
    });
  } catch {}
  return bookInfo;
};

export const extractBookCategoriesAndDescription = async (
  text: string,
  options?: { subDir?: string }
): Promise<{ categoryIds: number[]; description: string }> => {
  const categoriesList = categories
    .map((cat) => `- ${cat.id}. ${cat.name}`)
    .join('\n    ');

  const prompt = `
    Analise o livro e selecione as categorias MAIS RELEVANTES do conjunto abaixo.
    Também escreva uma boa descrição, clara, sem spoilers, voltada ao público geral.

    Regras de seleção:
    - Retorne no MÁXIMO 3 categorias, podendo ser 1 ou 2, ordenadas por relevância.
    - Escolha uma categoria somente se ela for NUCLEAR ao tema do livro, não periférica.

    **Lista de Categorias Disponíveis:**
    ${categoriesList}

    Retorne no formato JSON com a seguinte estrutura:
    {
      "categoryIds": [1, 2], // até 3 ids no total, únicos e ordenados por relevância
      "description": "Descrição do livro"
    }

    **Livro:**
    """
    ${text}
    """
  `;

  const response = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content:
          'Responda somente JSON válido (um único objeto). Sem explicações nem texto extra.',
      },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
  });

  if (!response.choices[0].message.content) {
    throw new Error('Nenhum conteúdo retornado pelo modelo');
  }

  const content = response.choices[0].message.content;
  const bookCategories = JSON.parse(content);
  // custo estimado via helper (com system message)
  try {
    await computeAndSaveCost({
      model,
      costFileName: 'cost_categories.json',
      subDir: options?.subDir,
      usage: response.usage,
    });
  } catch {}
  return bookCategories;
};

// ===== Tipagens de saída (reaproveitando a estrutura existente e adicionando metadados) =====

export enum ContentType {
  PARAGRAPH = 'PARAGRAPH',
  KEY_POINT = 'KEY_POINT',
}

export enum KeyPointType {
  QUOTE = 'QUOTE',
  INSIGHT = 'INSIGHT',
  MOMENT = 'MOMENT',
}

export interface Paragraph {
  type: ContentType.PARAGRAPH;
  text: string;
}

export interface KeyPoint {
  type: ContentType.KEY_POINT;
  keyPointType: KeyPointType;
  text: string;
  reference?: string; // Obrigatório apenas quando QUOTE
}

export type ChapterContent = Paragraph | KeyPoint;

export interface Chapter {
  title: string;
  content: ChapterContent[];
}

// ===== Guia Global (map-reduce) =====

export interface GlobalGuide {
  characters: Array<{ name: string; aliases?: string[]; role?: string }>;
  locations: string[];
  terms: string[];
  timeline: Array<{ order: number; event: string }>;
  themes: string[];
  style: { voice: string; tone: string };
}

export async function buildGlobalGuide(
  chunks: string[],
  options?: { subDir?: string; polishTargetTokens?: number }
): Promise<GlobalGuide> {
  const maps: GlobalGuide[] = [];
  const subDir = options?.subDir;
  const guideCostEntries: Array<{
    index: number;
    inputTokens: number;
    outputTokens: number;
    usd: number;
  }> = [];
  // Tenta reaproveitar mapas já gerados: se existir guide_output_XX.json, reutiliza
  for (let i = 0; i < chunks.length; i++) {
    const ctext = chunks[i];
    const ctokens = countTokens(ctext, 'gpt-5-mini');
    console.log(
      `🧭 [GUIA] Chunk ${i + 1}/${chunks.length}: ${formatNumber(
        ctext.length
      )} chars, ${formatNumber(ctokens)} tokens`
    );
    const idxStr = String(i + 1).padStart(2, '0');
    const outFileName = `guide_output_${idxStr}.json`;
    if (subDir) {
      try {
        const p = require('path');
        const fsp = require('fs/promises');
        const existing = await fsp.readFile(
          p.join('outputs', subDir, outFileName),
          'utf-8'
        );
        const parsedExisting = JSON.parse(existing);
        maps.push(parsedExisting);
        console.log(
          `↪️  [GUIA] Pulando chunk ${i + 1} (já existe ${outFileName})`
        );
        continue;
      } catch {}
    }
    await saveToFile(`guide_input_${idxStr}.txt`, ctext, { subDir });
    const prompt = `
      Você é um analista literário. Extraia um guia CONCISO do trecho abaixo, retornando JSON:
      {
        "characters": [{"name": "...", "aliases": ["..."], "role": "..."}],
        "locations": ["..."],
        "terms": ["..."] ,
        "timeline": [{"order": 1, "event": "..."}],
        "themes": ["..."],
        "style": {"voice": "...", "tone": "..."}
      }
      Limites por seção (apenas itens realmente relevantes do trecho):
      - characters ≤ 8; locations ≤ 8; terms ≤ 10; timeline ≤ 8 eventos curtos; themes ≤ 5; style ≤ 2 frases curtas.
      Se uma seção não tiver itens relevantes, retorne um array vazio para ela.
      Evite duplicar variações triviais (com artigos, plural/singular). Não invente.

      Trecho:
      """
      ${ctext}
      """
    `;
    // Requisição robusta com retries
    let parsed: GlobalGuide | null = null;
    let attempt = 0;
    const maxAttempts = 3;
    while (attempt < maxAttempts && !parsed) {
      attempt++;
      try {
        const systemMsg =
          'Responda somente JSON válido (um único objeto). Sem explicações nem texto extra.';
        const resp = await openai.chat.completions.create({
          model: cheapModel,
          messages: [
            {
              role: 'system',
              content: systemMsg,
            },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
        });
        const content = resp.choices[0].message.content;
        if (!content) {
          await saveToFile(
            `guide_chunk_${String(i + 1).padStart(
              2,
              '0'
            )}_resp_attempt${attempt}.json`,
            JSON.stringify(resp, null, 2),
            { subDir: options?.subDir }
          );
          // Salva custo baseado em usage mesmo sem conteúdo
          try {
            await computeAndSaveCost({
              model: cheapModel,
              costFileName: `cost_guide_${idxStr}.json`,
              subDir,
              usage: resp.usage,
            });
          } catch {}
          throw new Error('Resposta vazia do modelo');
        }
        parsed = JSON.parse(content);
        // custo estimado usando helper (por milhão)
        {
          const ret = await computeAndSaveCost({
            model: cheapModel,
            costFileName: `cost_guide_${idxStr}.json`,
            subDir,
            usage: resp.usage,
          });
          if (ret) {
            guideCostEntries.push({
              index: i + 1,
              inputTokens: ret.inputTokens,
              outputTokens: ret.outputTokens,
              usd: ret.cost.usd,
            });
          }
        }
        await saveToFile(
          `guide_output_${idxStr}.json`,
          JSON.stringify(parsed, null, 2),
          { subDir }
        );
      } catch (e) {
        console.error(
          `❌ [GUIA] Erro no chunk ${i + 1} (tentativa ${attempt}):`,
          e
        );
        if (attempt >= maxAttempts) throw e;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    maps.push(parsed!);
  }

  // Agregação raw (sem normalização por código) e renumeração da timeline
  const guideRaw: GlobalGuide = {
    characters: maps.flatMap((m) => m.characters || []),
    locations: maps.flatMap((m) => m.locations || []),
    terms: maps.flatMap((m) => m.terms || []),
    timeline: maps
      .flatMap((m) => m.timeline || [])
      .filter((e) => e?.event)
      .map((e, i) => ({ order: i + 1, event: e.event })),
    themes: maps.flatMap((m) => m.themes || []),
    style: maps.find((m) => m?.style)?.style || {
      voice: 'neutro',
      tone: 'neutro',
    },
  };

  await saveToFile('book_global_guide_raw.json', guideRaw, {
    subDir: options?.subDir,
  });
  const guideRawStr = JSON.stringify(guideRaw);
  console.log(
    `🧭 [GUIA] Agregado (raw): ${formatNumber(
      guideRawStr.length
    )} chars, ${formatNumber(countTokens(guideRawStr, 'gpt-5-mini'))} tokens`
  );

  // Polimento final via LLM para dedupe/compactação
  const polished = await polishGlobalGuide(
    guideRaw,
    options?.polishTargetTokens ?? 3500,
    options?.subDir
  );
  await saveToFile('book_global_guide.json', polished, {
    subDir: options?.subDir,
  });
  const polishedStr = JSON.stringify(polished);
  console.log(
    `🧭 [GUIA] Polido: ${formatNumber(
      polishedStr.length
    )} chars, ${formatNumber(countTokens(polishedStr, 'gpt-5-mini'))} tokens`
  );
  return polished;
}

async function polishGlobalGuide(
  guide: GlobalGuide,
  targetTokens: number,
  subDir?: string
): Promise<GlobalGuide> {
  const prompt = `
    Receba um guia global (JSON) e devolva-o deduplicado e mais conciso:
    - Unifique personagens duplicados (variações de grafia, artigos/parênteses) sob um nome canônico curto; mantenha aliases.
    - Remova locais/termos redundantes.
    - Renumere timeline de 1..N, no máximo 250 eventos curtos, sem repetição.
    - Mantenha chaves: characters, locations, terms, timeline, themes, style.
    - Tente ~${targetTokens} tokens. Não invente fatos.
    Retorne somente JSON válido.

    GUIA:
    """
    ${JSON.stringify(guide)}
    """
  `;

  let parsed: GlobalGuide | null = null;
  let attempt = 0;
  const maxAttempts = 2;
  while (attempt < maxAttempts && !parsed) {
    attempt++;
    try {
      const systemMsg =
        'Responda somente JSON válido (um único objeto). Sem explicações nem texto extra.';
      const resp = await openai.chat.completions.create({
        model: cheapModel,
        messages: [
          {
            role: 'system',
            content: systemMsg,
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      });
      const content = resp.choices[0].message.content;
      if (!content) {
        await saveToFile(
          `guide_polish_resp_attempt${attempt}.json`,
          JSON.stringify(resp, null, 2),
          { subDir }
        );
        // Salva custo baseado em usage mesmo sem conteúdo
        try {
          await computeAndSaveCost({
            model: cheapModel,
            costFileName: `cost_guide_polish_attempt${attempt}.json`,
            subDir,
            usage: resp.usage,
          });
        } catch {}
        throw new Error('Resposta vazia ao polir guia');
      }
      parsed = JSON.parse(content);
      // custo estimado (polish) via helper
      await computeAndSaveCost({
        model: cheapModel,
        costFileName: `cost_guide_polish_attempt${attempt}.json`,
        subDir,
        usage: resp.usage,
      });
      await saveToFile(
        'book_global_guide_polish_output.json',
        JSON.stringify(parsed, null, 2),
        { subDir }
      );
    } catch (e) {
      console.error(`❌ [GUIA] Erro ao polir (tentativa ${attempt}):`, e);
      if (attempt >= maxAttempts) throw e;
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  await saveToFile('book_global_guide_polish_input.json', prompt, { subDir });
  return parsed!;
}

// ===== Resumo com contexto e limite de KEY_POINTS =====

function sanitizeChapterOutput(ch: Chapter): Chapter {
  const sanitizedContent = (ch.content || []).map((item: any) => {
    // remove chaves com null
    Object.keys(item).forEach((k) => {
      if (item[k] === null) delete item[k];
    });
    return item;
  });
  const sanitized: Chapter = {
    title: typeof ch.title === 'string' ? ch.title : '',
    content: sanitizedContent,
  };
  return sanitized;
}

export async function summarizeChapterWithContext(args: {
  chapterText: string;
  guide: GlobalGuide;
  prevChapterFormatted?: Chapter;
  targetTokens?: number;
  options: { subDir: string; chapterIndex: number };
}): Promise<Chapter> {
  const {
    chapterText,
    guide,
    prevChapterFormatted,
    targetTokens = 900,
    options,
  } = args;

  // Logs de contexto
  const inTokens = countTokens(chapterText, 'gpt-5-mini');
  const prevTokens = prevChapterFormatted
    ? countTokens(JSON.stringify(prevChapterFormatted), 'gpt-5-mini')
    : 0;
  const guideTokens = countTokens(JSON.stringify(guide), 'gpt-5-mini');
  const effectiveTarget = Math.max(100, Math.round(targetTokens * 0.45));
  console.log(
    `✂️  [CAP] Entrada: ${formatNumber(
      chapterText.length
    )} chars, ${formatNumber(inTokens)} tokens | prev: ${formatNumber(
      prevTokens
    )} tokens | guia: ${formatNumber(
      guideTokens
    )} tokens | alvo saída: ~${formatNumber(
      targetTokens
    )} tokens (efetivo ~${formatNumber(effectiveTarget)})`
  );

  const prompt = `
    Você vai condensar um trecho do livro em um capítulo de saída coeso (início, meio, fim).
    Mantenha o estilo e a voz original do autor. O resultado deve soar como escrito pelo próprio autor, apenas mais conciso.
    Não explique a história em metacomentários; reescreva com fluidez, preservando os detalhes essenciais e a experiência de leitura.
    Use o GUIA GLOBAL e o capítulo anterior já formatado para manter consistência de nomes, lugares, tom e continuidade.

    GUIA GLOBAL (canônico e conciso):
    ${JSON.stringify(guide)}

    CAPÍTULO ANTERIOR (resumo já formatado; use apenas para continuidade e consistência. NÃO recapitule literalmente, evite repetir conteúdo):
    ${prevChapterFormatted ? JSON.stringify(prevChapterFormatted) : 'N/A'}

    INSTRUÇÕES ESTRUTURAIS:
    - Preserve diálogos importantes; evite quebrar falas.
    - Alvo de tamanho: ~${effectiveTarget} tokens. É preferível ficar ABAIXO do alvo do que acima. Ao se aproximar do limite, finalize o parágrafo em curso e encerre.
    - Não use cabeçalhos, marcadores, listas ou prefixos técnicos no corpo. Produza apenas parágrafos narrativos (e KEY_POINTS conforme a estrutura), sem títulos internos.
    - Título: gere um título curto e descritivo SEM prefixos como "Capítulo", números ou travessões. Ex.: "Uma festa inesperada" (não use "Capítulo I — ...").
    - KEY_POINTS: até 3 (0, 1, 2 ou 3). Inclua apenas se agregarem valor real e INSIRA cada KEY_POINT imediatamente após o parágrafo relacionado (não agrupe todos no final):
      - INSIGHT: apenas lições universais aplicáveis ao leitor; evite explicar a narrativa.
      - QUOTE: somente se TODOS os critérios abaixo forem verdadeiros (senão, NÃO inclua QUOTE):
        1) Autossuficiente: funciona fora do contexto (entende-se sozinha).
        2) Memorável/reflexiva: provoca insight/ponderação (aforística, não banal).
        3) Universalidade: trata de temas gerais (vida, tempo, escolha, coragem, etc.).
        4) Linguagem adequada: sem vulgaridade/insulto gratuito.
        5) Referência correta: "reference" = quem falou, nunca capítulo/seção/página. Se não souber, NÃO inclua QUOTE.
      - MOMENT: apenas momentos genuinamente decisivos.
    - Proibição de metalinguagem/rotulagem: não escreva rótulos ou comentários de estrutura como "Momento decisivo:", "Momento:", "Moment:", "marco do capítulo", "clímax do capítulo", "Quote:", "Citação:", "Insight:" ou similares. A redação dos KEY_POINTS deve ser natural, sem prefixos.
    - Não mencione que é um capítulo/livro, nem se dirija ao leitor. Descreva o evento/ideia diretamente, sem metacomentários.
    - Evite redundância entre parágrafos e KEY_POINTS: se uma fala virar QUOTE, NÃO repita a mesma frase literalmente no parágrafo.
    - Se não houver KEY_POINTS realmente bons, retorne ZERO key points (é aceitável 0).
    - NUNCA use null; omita campos opcionais inexistentes.
    - Mantenha proporções ricas: parágrafos longos e detalhados; evite virar “resumo telegráfico”.

    ESTRUTURA DE DADOS (tipagens):
    \`\`\`typescript
    enum ContentType {
      PARAGRAPH = 'PARAGRAPH',

      KEY_POINT = 'KEY_POINT'
    }

    enum KeyPointType {
      QUOTE = 'QUOTE',
      INSIGHT = 'INSIGHT',
      MOMENT = 'MOMENT'
    }

    interface Paragraph {
      type: ContentType.PARAGRAPH;
      text: string;
    }

    interface KeyPoint {
      type: ContentType.KEY_POINT;
      
      keyPointType: KeyPointType;
      text: string;
      reference?: string; // Para QUOTE: quem falou (personagem/narrador). Nunca use nomes de capítulo/seção. Se não souber, omita.
    }

    type ChapterContent = Paragraph | KeyPoint;

    interface Chapter {
      title: string;
      content: ChapterContent[];
    }
    \`\`\`

    FORMATO DE SAÍDA (JSON): deve ser um \"Chapter\" válido.

    TEXTO DO CAPÍTULO (já contém pequena sobreposição com o anterior e o próximo):
    """
    ${chapterText}
    """
  `;

  // Persistir prompt para debug
  const chapterIdxLabel = String(options.chapterIndex + 1).padStart(2, '0');
  const promptFile = `chapter_${chapterIdxLabel}_prompt.txt`;
  await saveToFile(promptFile, prompt, { subDir: options.subDir });

  let parsed: Chapter | null = null;
  let attemptCap = 0;
  const maxAttemptsCap = 3;
  while (attemptCap < maxAttemptsCap && !parsed) {
    attemptCap++;
    try {
      const systemMsg =
        'Responda somente JSON válido (um único objeto). Sem explicações nem texto extra.';
      const response = await openai.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: systemMsg,
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      });
      const content = response.choices[0].message.content;
      if (!content) {
        const respFile = `chapter_${chapterIdxLabel}_resp_attempt${attemptCap}.json`;
        await saveToFile(respFile, JSON.stringify(response, null, 2), {
          subDir: options.subDir,
        });
        // Salva custo com usage mesmo sem conteúdo
        try {
          await computeAndSaveCost({
            model,
            costFileName: `cost_chapter_${chapterIdxLabel}_attempt${attemptCap}.json`,
            subDir: options.subDir,
            usage: response.usage,
          });
        } catch {}
        throw new Error('Nenhum conteúdo retornado pelo modelo');
      }
      parsed = sanitizeChapterOutput(JSON.parse(content));
      // custo estimado capítulo via helper
      await computeAndSaveCost({
        model,
        costFileName: `cost_chapter_${chapterIdxLabel}_attempt${attemptCap}.json`,
        subDir: options.subDir,
        usage: response.usage,
      });
      const outAttemptFile = `chapter_${chapterIdxLabel}_output_attempt${attemptCap}.json`;
      await saveToFile(outAttemptFile, JSON.stringify(parsed, null, 2), {
        subDir: options.subDir,
      });
    } catch (e) {
      console.error(`❌ [CAP] Erro ao resumir (tentativa ${attemptCap}):`, e);
      const errFile = `chapter_${chapterIdxLabel}_error_attempt${attemptCap}.txt`;
      await saveToFile(errFile, String(e), { subDir: options.subDir });
      if (attemptCap >= maxAttemptsCap) throw e;
      await new Promise((r) => setTimeout(r, attemptCap * 1000));
    }
  }
  // Garantia de não-nulo
  if (!parsed) {
    throw new Error('Falha ao gerar capítulo após múltiplas tentativas');
  }
  // Métricas de saída
  const outText = (parsed.content || [])
    .map((c: { text: string }) => c.text)
    .join('\n\n');
  const outTokens = countTokens(outText, 'gpt-5-mini');
  const kpCount = (parsed.content || []).filter(
    (c: { type: string }) => c.type === 'KEY_POINT'
  ).length;
  console.log(
    `✅ [CAP] Título: ${
      parsed.title || '(sem título)'
    } | Parágrafos: ${formatNumber(
      (parsed.content || []).filter(
        (c: { type: string }) => c.type === 'PARAGRAPH'
      ).length
    )} | KeyPoints: ${kpCount} | Saída: ${formatNumber(
      outText.length
    )} chars, ${formatNumber(outTokens)} tokens`
  );
  // Não salvar capítulo formatado aqui; quem salva é a rota, com numeração
  return parsed;
}
