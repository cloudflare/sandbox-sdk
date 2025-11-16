# OpenAI Agents with Cloudflare Sandbox

A conversational AI assistant that executes shell commands and edits files in a Cloudflare Sandbox.

## Setup

Create a `.env` file with your OpenAI API key:

```
OPENAI_API_KEY=your-api-key-here
```

Then start the development server:

```bash
npm start
```

## Usage

Enter natural language commands in the chat interface. The assistant can:

- Execute shell commands
- Create, edit, and delete files

All conversations are saved in your browser's localStorage.

## Deploy

```bash
npm run deploy
```
