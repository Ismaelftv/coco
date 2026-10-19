#!/usr/bin/env python3
"""Publica um ficheiro (ex.: relatório JSON) como anotações do GitHub Actions.

Os artefactos e logs da CI nem sempre são acessíveis a ferramentas externas,
mas as anotações são legíveis pela API. O ficheiro é comprimido (gzip) e
codificado em base64, partido em blocos que cabem numa anotação.
Recolher com: python3 scripts/ci-results.py <run_id>

Uso: ci-annotate.py <nome> <ficheiro> [--max-chunks 8]
"""
import base64, gzip, json, sys

def esc(s: str) -> str:
    return s.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')

name, path = sys.argv[1], sys.argv[2]
max_chunks = int(sys.argv[sys.argv.index('--max-chunks') + 1]) if '--max-chunks' in sys.argv else 10
# O GitHub corta cada anotação a 4096 caracteres e mostra no máximo 10 avisos por passo.
size = 4000

def pack(raw: bytes) -> str:
    return base64.b64encode(gzip.compress(raw, 9)).decode()

def shorten(o, limit):
    if isinstance(o, str):
        return o if len(o) <= limit else o[:limit] + f'…[+{len(o) - limit} caracteres omitidos]'
    if isinstance(o, list):
        return [shorten(x, limit) for x in o]
    if isinstance(o, dict):
        return {k: shorten(v, limit) for k, v in o.items()}
    return o

raw = open(path, 'rb').read()
data = pack(raw)
# Se não couber, encurta cadeias longas (saídas de comandos, diffs) e avisa; o resumo nunca é truncado em silêncio.
for limit in (2000, 800, 300):
    if len(data) <= size * max_chunks:
        break
    try:
        data = pack(json.dumps(shorten(json.loads(raw), limit), ensure_ascii=False).encode())
        print(f"::notice title=resultado:{name}:aviso::cadeias longas encurtadas a {limit} caracteres para caber nas anotações", flush=True)
    except ValueError:
        break
chunks = [data[i:i + size] for i in range(0, len(data), size)]
if len(chunks) > max_chunks:
    print(f"::warning title=resultado:{name}::demasiado grande para anotações ({len(chunks)} blocos > {max_chunks}); relatório truncado", flush=True)
    chunks = chunks[:max_chunks]
for i, c in enumerate(chunks, 1):
    print(f"::notice title=resultado:{name}:{i}/{len(chunks)}::{esc(c)}", flush=True)
