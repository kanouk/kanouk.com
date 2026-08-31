#!/usr/bin/env python3
"""Freeze public Quiz Maker markup into deterministic Yohaku quiz data."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from html import unescape
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import tempfile
from typing import Any


CONTAINER = re.compile(r"<div\s+class=['\"][^'\"]*ays-quiz-container[^'\"]*['\"][^>]*", re.I)
CONTAINER_ID = re.compile(r"id=['\"]ays-quiz-container-(\d+)['\"]", re.I)
STEP = re.compile(r"(?=<div\s+class=['\"][^'\"]*step[^'\"]*['\"][^>]*data-question-id=)", re.I)
QUESTION_ID = re.compile(r"data-question-id=['\"](\d+)['\"]", re.I)
FIELD = re.compile(
    r"<div\s+class=['\"][^'\"]*ays-field[^'\"]*['\"][^>]*>[\s\S]*?"
    r"name=['\"]ays_answer_correct\[\]['\"]\s+value=['\"]([01])['\"][\s\S]*?"
    r"<label[^>]*>([\s\S]*?)</label>",
    re.I,
)


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def plain(value: str) -> str:
    parser = TextExtractor()
    parser.feed(unescape(value))
    return " ".join(" ".join(parser.parts).split())


def class_html(segment: str, class_name: str) -> str:
    match = re.search(
        rf"<[^>]+class=['\"][^'\"]*{re.escape(class_name)}[^'\"]*['\"][^>]*>([\s\S]*?)</[^>]+>",
        segment,
        re.I,
    )
    return match.group(1) if match else ""


def parse_quizzes(html: str) -> dict[str, dict[str, Any]]:
    starts = list(CONTAINER.finditer(html))
    quizzes: dict[str, dict[str, Any]] = {}
    for index, start in enumerate(starts):
        opening = start.group(0)
        quiz_id = CONTAINER_ID.search(opening)
        if not quiz_id:
            continue
        value = quiz_id.group(1)
        end = starts[index + 1].start() if index + 1 < len(starts) else len(html)
        segment = html[start.start():end]
        quiz = quizzes.setdefault(
            value,
            {
                "source_quiz_id": value,
                "title": plain(class_html(segment, "ays-fs-title")),
                "description": plain(class_html(segment, "ays-fs-subtitle")),
                "questions": {},
            },
        )
        for step in STEP.split(segment):
            question_id = QUESTION_ID.search(step[:500])
            if not question_id:
                continue
            question_text = re.sub(r"^\d+\.\s*", "", plain(class_html(step, "ays_quiz_question")))
            answers = sorted([
                {
                    "text": re.sub(r"^[A-ZＡ-Ｚ]\.\s*", "", plain(label)),
                    "correct": correct == "1",
                }
                for correct, label in FIELD.findall(step)
                if plain(label)
            ], key=lambda answer: answer["text"])
            if not question_text or len(answers) < 2 or sum(answer["correct"] for answer in answers) != 1:
                continue
            qid = question_id.group(1)
            question = {
                "source_question_id": qid,
                "question": question_text,
                "answers": answers,
                "explanation": plain(class_html(step, "right_answer_text")),
            }
            existing = quiz["questions"].get(qid)
            if existing and existing != question:
                raise ValueError(f"Question {qid} changed between public snapshots")
            quiz["questions"][qid] = question
    return quizzes


def merge_snapshots(paths: list[Path]) -> dict[str, Any]:
    merged: dict[str, dict[str, Any]] = {}
    snapshots = []
    for path in paths:
        raw = path.read_bytes()
        snapshots.append({"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
        for quiz_id, quiz in parse_quizzes(raw.decode(errors="replace")).items():
            target = merged.setdefault(
                quiz_id,
                {key: value for key, value in quiz.items() if key != "questions"} | {"questions": {}},
            )
            for question_id, question in quiz["questions"].items():
                existing = target["questions"].get(question_id)
                if existing and existing != question:
                    raise ValueError(f"Question {question_id} changed between public snapshots")
                target["questions"][question_id] = question
    for quiz in merged.values():
        quiz["questions"] = [quiz["questions"][key] for key in sorted(quiz["questions"], key=int)]
    return {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source_url": "https://kanolog.net/artcert",
        "snapshots": snapshots,
        "quizzes": merged,
    }


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("html", type=Path, nargs="+")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expect", action="append", default=[], help="quiz-id:question-count")
    args = parser.parse_args()
    result = merge_snapshots(args.html)
    for expected in args.expect:
        quiz_id, raw_count = expected.split(":", 1)
        actual = len(result["quizzes"].get(quiz_id, {}).get("questions", []))
        if actual != int(raw_count):
            raise SystemExit(f"quiz {quiz_id}: expected {raw_count} questions, got {actual}")
    write_json_atomic(args.output, result)
    print(json.dumps({quiz_id: len(quiz["questions"]) for quiz_id, quiz in result["quizzes"].items()}))


if __name__ == "__main__":
    main()
