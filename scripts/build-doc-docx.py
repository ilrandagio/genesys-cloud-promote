#!/usr/bin/env python3
"""
Genera doc/architettura.docx da doc/architettura.md.

I diagrammi Mermaid vengono disegnati in PNG (doc/img/diagramma-N.png) con mermaid-cli (mmdc)
e inseriti come immagini; il resto viene convertito con pandoc.

Requisiti: pandoc, mermaid-cli (npm i -g @mermaid-js/mermaid-cli).
Uso: python3 scripts/build-doc-docx.py
"""
import json
import pathlib
import re
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOC = ROOT / "doc"
SOURCE = DOC / "architettura.md"
TARGET = DOC / "architettura.docx"
IMG = DOC / "img"

# Larghezza delle immagini nel Word: il flusso di rilascio è alto e stretto
WIDTHS = {0: "16cm", 1: "7cm"}


def main() -> None:
    text = SOURCE.read_text(encoding="utf-8")
    IMG.mkdir(exist_ok=True)
    blocks = re.findall(r"```mermaid\n(.*?)```", text, re.S)

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = pathlib.Path(tmp)
        puppeteer = tmpdir / "puppeteer.json"
        puppeteer.write_text(json.dumps({"args": ["--no-sandbox"]}))
        for i, block in enumerate(blocks):
            src = tmpdir / f"d{i}.mmd"
            src.write_text(block, encoding="utf-8")
            png = IMG / f"diagramma-{i + 1}.png"
            subprocess.run(
                ["mmdc", "-p", str(puppeteer), "-i", str(src), "-o", str(png), "-w", "1400", "-b", "white", "-s", "2"],
                check=True,
            )

        counter = iter(range(len(blocks)))

        def to_image(_match: re.Match) -> str:
            i = next(counter)
            return f"![](img/diagramma-{i + 1}.png){{width={WIDTHS.get(i, '16cm')}}}\n"

        converted = re.sub(r"```mermaid\n.*?```\n?", to_image, text, flags=re.S)
        md = tmpdir / "architettura.md"
        md.write_text(converted, encoding="utf-8")
        subprocess.run(
            ["pandoc", str(md), "-f", "gfm+attributes", "-o", str(TARGET), "--resource-path", str(DOC)],
            check=True,
        )
    print(f"Creato {TARGET.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
