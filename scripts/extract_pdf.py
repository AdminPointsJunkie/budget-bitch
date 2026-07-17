import io
import json
import sys

import pdfplumber


def main():
    data = sys.stdin.buffer.read()
    if not data.startswith(b"%PDF"):
        raise ValueError("The selected file is not a valid PDF.")

    lines = []
    with pdfplumber.open(io.BytesIO(data)) as document:
        for page in document.pages:
            words = page.extract_words(x_tolerance=2, y_tolerance=2, keep_blank_chars=False)
            grouped = {}
            for word in words:
                key = round(word["top"] / 2) * 2
                grouped.setdefault(key, []).append(word)
            for key in sorted(grouped):
                line = " ".join(word["text"] for word in sorted(grouped[key], key=lambda item: item["x0"]))
                if line.strip():
                    lines.append(line)

    print(json.dumps({"lines": lines}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
