import tempfile
import unittest
from pathlib import Path

from scripts.migration.extract_quiz_maker import merge_snapshots, parse_quizzes


FIXTURE = """
<div class='ays-quiz-container' id='ays-quiz-container-3'>
<h2 class='ays-fs-title'>美術クイズ</h2>
<div class='step' data-question-id='7'>
<div class='ays_quiz_question'><p>作者は誰ですか。</p></div>
<div class='ays-field'><input type='hidden' name='ays_answer_correct[]' value='0'/><label>Aさん</label></div>
<div class='ays-field'><input type='hidden' name='ays_answer_correct[]' value='1'/><label>Bさん</label></div>
<div class='right_answer_text'>Bさんが正解です。</div>
</div></div>
"""


class QuizMakerExtractionTests(unittest.TestCase):
    def test_extracts_semantic_question_answers_and_explanation(self):
        quiz = parse_quizzes(FIXTURE)["3"]
        question = quiz["questions"]["7"]
        self.assertEqual(quiz["title"], "美術クイズ")
        self.assertEqual(question["question"], "作者は誰ですか。")
        self.assertEqual([answer["correct"] for answer in question["answers"]], [False, True])
        self.assertEqual(question["explanation"], "Bさんが正解です。")

    def test_merges_random_question_snapshots_without_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.html"
            second = Path(directory) / "second.html"
            first.write_text(FIXTURE)
            second.write_text(FIXTURE)
            merged = merge_snapshots([first, second])
        self.assertEqual(len(merged["quizzes"]["3"]["questions"]), 1)
        self.assertEqual(len(merged["snapshots"]), 2)


if __name__ == "__main__":
    unittest.main()
