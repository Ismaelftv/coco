#!/usr/bin/env python3
"""Publica um ficheiro (ex.: relatório JSON) como anotações do GitHub Actions.

Os artefactos e logs da CI nem sempre são acessíveis a ferramentas externas,
mas as anotações são legíveis pela API. O ficheiro é comprimido (gzip) e
codificado em base64, partido em blocos que cabem numa anotação.
Recolher com: python3 scripts/ci-results.py <run_id>

Uso: ci-annotate.py <nome> <ficheiro> [--max-chunks 8]
"""
import base64, gzip, sys

def esc(s: str) -> str:
    return s.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')

name, path = sys.argv[1], sys.argv[2]
max_chunks = int(sys.argv[sys.argv.index('--max-chunks') + 1]) if '--max-chunks' in sys.argv else 8
data = base64.b64encode(gzip.compress(open(path, 'rb').read(), 9)).decode()
size = 30000
chunks = [data[i:i + size] for i in range(0, len(data), size)]
if len(chunks) > max_chunks:
    print(f"::warning title=resultado:{name}::demasiado grande para anotações ({len(chunks)} blocos > {max_chunks}); relatório truncado", flush=True)
    chunks = chunks[:max_chunks]
for i, c in enumerate(chunks, 1):
    print(f"::notice title=resultado:{name}:{i}/{len(chunks)}::{esc(c)}", flush=True)
