# Implantação no servidor (guia para quem instala)

> Estado: guia escrito a partir do código e do README. **Não foi executado num servidor real** por quem o escreveu; o programador deve validar cada passo e corrigir este ficheiro se algo diferir.

Objetivo: Forja a correr no servidor com um modelo de IA real (Ollama), atrás de HTTPS.

## Requisitos
- Linux com acesso root/sudo; Node.js 22; Git; PostgreSQL 16 (nativo ou Docker); Ollama.
- Domínio apontado para o IP do servidor (para o HTTPS).

## 1. Código
```bash
git clone https://github.com/Ismaelftv/coco.git forja && cd forja     # ou: git pull
npm install
npm run build        # a interface vem de dist/: sem build, o navegador mostra a versão antiga
```

## 2. PostgreSQL
Criar uma base e um utilizador próprios, com palavra-passe forte (não usar a de desenvolvimento). As tabelas são criadas no arranque. O PostgreSQL **não** deve ficar exposto à internet.

## 3. Ollama e modelos
```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:4b             # conversa geral
ollama pull qwen2.5-coder:7b     # código
ollama list                      # confirmar que aparecem
curl http://127.0.0.1:11434/api/tags   # tem de responder JSON
```
O Ollama escuta só em 127.0.0.1:11434. **Não o expor** (não tem autenticação).

## 4. Catálogo de modelos
```bash
cp config/models.example.json config/models.json
```
Remover do `models.json` as entradas que não se vão usar (modelos não instalados aparecem como offline; o `gpt-externo` precisa de chave paga: remover se não houver). Referência: `docs/06-modelos.md`.

## 5. Configuração (`.env`, nunca no git)
```
NODE_ENV=production
HOST=127.0.0.1
PORT=5173
DATABASE_URL=postgres://UTILIZADOR:PALAVRA-PASSE@127.0.0.1:5432/forja
PUBLIC_ORIGIN=https://o-teu-dominio
COOKIE_SECURE=true
SCRYPT_LOG_N=17
TRUST_PROXY=true            # só se houver o proxy do passo 6 à frente
STORAGE_DIR=/var/lib/forja/files
MODELS_CONFIG=config/models.json
ALLOW_SIGNUP=false          # depois de criar as contas necessárias
```
Em produção a Forja recusa arrancar se faltar `PUBLIC_ORIGIN`, `MODELS_CONFIG`, `SCRYPT_LOG_N ≥ 17` ou se `COOKIE_SECURE=false`; a mensagem diz qual.

## 6. HTTPS (proxy inverso)
Exemplo com Caddy (certificado automático):
```
o-teu-dominio {
    reverse_proxy 127.0.0.1:5173
}
```
Abrir só as portas 80 e 443 na firewall. A porta 5173 fica só local (`HOST=127.0.0.1`).

## 7. Arranque permanente
Correr `npm start` num serviço systemd (utilizador sem privilégios, `Restart=on-failure`, `WorkingDirectory` na pasta do projeto). Ver o log no arranque: tem de aparecer uma linha `[modelos] qwen3-4b-local (self-hosted): online`.

## 8. Verificação
1. `https://o-teu-dominio/api/health` responde `{"ok":true}`.
2. Criar conta, enviar uma mensagem: a resposta vem de um modelo real (não do "Forja Simulador").
3. Cookie com `Secure` (ferramentas do navegador) e sem avisos de "Não seguro".

## 9. Imagens (opcional)
Só depois de o resto funcionar: ver `docs/10-imagens.md` (LocalAI). Sem a secção `images`, o botão não aparece. Em CPU é lento.

## 10. Atualizar
```bash
git pull && npm install && npm run build && sudo systemctl restart forja
```

## Segurança — a não fazer
- Expor o Ollama, o PostgreSQL ou a porta 5173 à internet.
- Pôr chaves ou palavras-passe no git.
- Deixar `ALLOW_SIGNUP=true` num servidor público sem querer registos abertos.
- Correr código de projetos de terceiros no servidor sem a sandbox em contentor (`docs/08-isolamento.md`).
