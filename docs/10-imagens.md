# Criação de imagens e código no chat

## O que funciona hoje (e o que não foi verificado)

| Capacidade | Estado |
|---|---|
| Responder a texto | Funciona com qualquer modelo do catálogo (Ollama, vLLM, …). |
| Escrever código | É conversa com um modelo de código (ex.: `qwen2.5-coder:7b` via Ollama). Os agentes que editam ficheiros num projeto são outra via (`docs/07-agentes.md`). |
| Criar imagens | Implementado e **testado só contra um servidor de imagens falso** (testes de integração e E2E). **Não foi testado com um gerador real** (LocalAI, etc.) nem medida a velocidade. |

Em CPU, gerar uma imagem pode demorar de dezenas de segundos a vários minutos (dependendo do modelo e da máquina). Com GPU é muito mais rápido.

## Como funciona

1. O catálogo (`MODELS_CONFIG`) tem uma secção opcional `images` (ver `config/models.example.json`).
2. O servidor chama `POST {baseUrl}/images/generations` (formato OpenAI) com `prompt`, `size`, `model`, `response_format: b64_json`.
3. A resposta tem de ser uma imagem verdadeira (verificada pelos bytes) e dentro do limite de tamanho. Só se aceita base64 ou um URL **da mesma origem** do servidor configurado.
4. A imagem é guardada como ficheiro do utilizador (conta na quota) e aparece na conversa. Falhas não deixam mensagens a meio.
5. Só uma geração de cada vez no servidor (resposta `429 image_busy` se houver outra), e há limite de pedidos por minuto.
6. Sem a secção `images`, o botão "Criar imagem" não aparece (`GET /api/capabilities`).

## Instalar um gerador local (exemplo: LocalAI)

LocalAI expõe `/v1/images/generations`. Exemplo com Docker (a imagem e o modelo são descarregados; podem ser vários GB):

```
docker run -p 8080:8080 --name localai localai/localai:latest
```

Depois instala um modelo de imagem pela galeria do LocalAI (ver a documentação deles) e põe o nome dele em `images.model`. Confirma à mão antes de usar na Forja:

```
curl http://127.0.0.1:8080/v1/images/generations -H 'Content-Type: application/json' \
  -d '{"model":"stablediffusion","prompt":"uma casa azul","size":"512x512"}'
```

O Ollama, na documentação atual, não lista geração de imagens; por isso não é usado para isto.

## Código com um modelo de código

Para o chat de código, junta ao catálogo um modelo como `qwen2.5-coder:7b` (`ollama pull qwen2.5-coder:7b`); `config/models.compare.json` já tem uma entrada de exemplo.

## Testes

`tests/integration/images.test.ts` e `tests/e2e/images.e2e.ts`, com `tests/helpers/fake-image-server.ts`.
