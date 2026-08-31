import assert from "node:assert/strict";
import test from "node:test";
import { convertPostContent } from "./yohaku-transformers.mjs";

const context = {
	siteId: "test",
	reusableBlocks: new Map(),
	products: new Map([
		["42", { title: "Sample", primaryUrl: "https://example.test/item" }],
	]),
	quizzes: new Map([
		["3", {
			title: "美術検定3級 対策問題",
			questions: [{
				source_question_id: "5",
				question: "作品はどれでしょう。",
				answers: [{ text: "正解", correct: true }, { text: "不正解", correct: false }],
				explanation: "解説",
			}],
		}],
	]),
};

test("converts a theme balloon to semantic dialogue deterministically", () => {
	const post = {
		id: 1,
		content: '<!-- wp:loos/balloon {"balloonID":"7"} --><p>Hello</p><!-- /wp:loos/balloon -->',
	};
	const first = convertPostContent(post, context);
	const second = convertPostContent(post, context);
	assert.deepEqual(first, second);
	assert.equal(first[0]._type, "yohaku.dialogue");
	assert.equal(first[0].body, "Hello");
});

test("converts classic artwork metadata tables to portable tables", () => {
	const post = {
		id: 2,
		content: "<!-- wp:html --><table><tr><th>作者</th><td>Sample Artist</td></tr></table><!-- /wp:html -->",
	};
	const blocks = convertPostContent(post, context);
	assert.equal(blocks[0]._type, "table");
	assert.equal(blocks[0].rows[0].cells[0].content[0].text, "作者");
	assert.equal(blocks[0].rows[0].cells[1].content[0].text, "Sample Artist");
});

test("resolves product records without retaining plugin block names", () => {
	const post = {
		id: 3,
		content: '<!-- wp:pochipp/linkbox {"pid":42} /-->',
	};
	const blocks = convertPostContent(post, context);
	assert.equal(blocks[0]._type, "yohaku.productCard");
	assert.equal(blocks[0].title, "Sample");
	assert.equal(blocks[0].id, "https://example.test/item");
});

test("converts Quiz Maker shortcodes to a portable Yohaku quiz", () => {
	const post = {
		id: 4,
		content: "<!-- wp:shortcode -->[ays_quiz id='3']<!-- /wp:shortcode -->",
	};
	const blocks = convertPostContent(post, context);
	assert.equal(blocks[0]._type, "yohaku.quiz");
	assert.equal(blocks[0].sourceQuizId, "3");
	assert.equal(blocks[0].questions[0].answers[0].correct, true);
});

test("converts the legacy search form to native site search", () => {
	const post = {
		id: 5,
		content: '<!-- wp:html --><div id="search-container"><form><input type="text"></form></div><!-- /wp:html -->',
	};
	const blocks = convertPostContent(post, context);
	assert.equal(blocks[0]._type, "yohaku.siteSearch");
	assert.equal(blocks[0].placeholder, "検索語を入力");
});
