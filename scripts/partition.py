"""Partition source documents with the open-source `unstructured` library.

Writes each document's raw elements (Element.to_dict()) to data/unstructured/<id>.json.
The TypeScript ingest step maps these onto the pipeline's block format; keeping the raw output
on disk makes it possible to tell library parsing issues apart from mapping issues.

Usage: .venv/bin/python scripts/partition.py [--strategy fast|hi_res|auto] [--force]
"""

import argparse
import json
import sys
import time
from pathlib import Path

from unstructured.partition.docx import partition_docx
from unstructured.partition.pdf import partition_pdf

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT_DIR = ROOT / "data" / "unstructured"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--strategy",
        default="fast",
        choices=["fast", "hi_res", "auto"],
        help="PDF strategy. hi_res adds layout-model table detection but needs poppler and tesseract.",
    )
    parser.add_argument("--force", action="store_true", help="Re-partition files that already have output")
    args = parser.parse_args()

    corpus = json.loads((ROOT / "corpus.json").read_text())
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for entry in corpus:
        src = RAW_DIR / f"{entry['id']}.{entry['format']}"
        dest = OUT_DIR / f"{entry['id']}.json"
        if dest.exists() and not args.force:
            print(f"✓ {entry['id']} (cached)")
            continue
        if not src.exists():
            print(f"✗ {entry['id']}: missing {src}; run `npm run fetch`", file=sys.stderr)
            return 1

        start = time.time()
        if entry["format"] == "pdf":
            elements = partition_pdf(
                filename=str(src),
                strategy=args.strategy,
                infer_table_structure=args.strategy != "fast",
                languages=["eng"],
            )
        else:
            elements = partition_docx(filename=str(src), infer_table_structure=True)

        payload = {
            "id": entry["id"],
            "strategy": args.strategy if entry["format"] == "pdf" else "docx",
            "elements": [e.to_dict() for e in elements],
        }
        dest.write_text(json.dumps(payload, ensure_ascii=False))
        print(f"↳ {entry['id']}: {len(elements)} elements in {time.time() - start:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
