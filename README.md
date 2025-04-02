# BookByte 📚

BookByte é uma aplicação que utiliza inteligência artificial para processar e condensar livros em PDF, mantendo a essência e riqueza narrativa do texto original. O projeto utiliza a API da OpenAI para realizar a condensação inteligente do conteúdo, preservando a estrutura dos capítulos e a voz do autor.

## ✨ Funcionalidades

- Upload de arquivos PDF
- Processamento automático do texto
- Condensação inteligente mantendo a narrativa original
- Estruturação em capítulos
- Preservação de diálogos e descrições importantes
- Geração de resumos estruturados em JSON

## 🛠️ Tecnologias Utilizadas

- Node.js
- TypeScript
- Express.js
- OpenAI API
- PDF Parse
- Multer (para upload de arquivos)

## ⚙️ Pré-requisitos

- Node.js (versão 14 ou superior)
- Yarn ou NPM
- Chave de API da OpenAI

## 🔧 Instalação

1. Clone o repositório:

```bash
git clone https://github.com/rodrigogonn/BookByte.git
cd BookByte
```

2. Instale as dependências:

```bash
yarn install
# ou
npm install
```

3. Configure as variáveis de ambiente:

```bash
cp .env.template .env
```

Edite o arquivo `.env` e adicione sua chave de API da OpenAI:

```
OPENAI_API_KEY=sua_chave_api_aqui
```

4. Inicie o servidor:

```bash
yarn dev
# ou
npm run dev
```

## 🚀 Como Usar

O servidor estará rodando em `http://localhost:3000` (ou na porta definida em `PORT` no arquivo `.env`).

### Endpoints Disponíveis

#### POST /upload

Envie um arquivo PDF para processamento:

```bash
curl -X POST -F "file=@seu_livro.pdf" http://localhost:3000/upload
```

#### POST /summarize

Envie um texto para resumo e formatação:

```bash
curl -X POST -H "Content-Type: application/json" -d '{"text":"seu texto aqui"}' http://localhost:3000/summarize
```

#### POST /summarizeChunk

Envie um texto para condensação:

```bash
curl -X POST -H "Content-Type: application/json" -d '{"text":"seu texto aqui"}' http://localhost:3000/summarizeChunk
```

## 📝 Notas

- Os arquivos processados são salvos automaticamente na pasta `outputs/`
