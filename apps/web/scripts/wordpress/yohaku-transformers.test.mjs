import assert from "node:assert/strict";
import test from "node:test";
import { buildProductMap, convertPostContent } from "./yohaku-transformers.mjs";

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

test("keeps a theme post link site-scoped until canonical URL resolution", () => {
	const post = {
		id: 11,
		content: '<!-- wp:loos/post-link {"postId":"42","postTitle":"関連記事"} /-->',
	};
	const blocks = convertPostContent(post, context);
	assert.equal(blocks[0]._type, "yohaku.linkCard");
	assert.equal(blocks[0].id, "wordpress://test/post/42");
});

test("preserves an external SWELL post-link URL and its semantic title", () => {
	const post = {
		id: 12,
		content: '<!-- wp:loos/post-link {"cardTitle":"Kyoto, 2024/07","linkData":{"url":"https://kanolog.smugmug.com/20240726Kyoto"}} /-->',
	};
	const blocks = convertPostContent(post, context);
	assert.equal(blocks[0]._type, "yohaku.linkCard");
	assert.equal(blocks[0].id, "https://kanolog.smugmug.com/20240726Kyoto");
	assert.equal(blocks[0].title, "Kyoto, 2024/07");
});

test("preserves WordPress image size, alignment, caption, and photo-frame meaning", () => {
	const post = {
		id: 12,
		content: `<!-- wp:image {"id":123,"width":"420px","align":"center"} -->
			<figure class="wp-block-image aligncenter is-resized is-style-photo_frame">
				<img src="https://example.test/photo.jpg" alt="sample" class="wp-image-123" width="840" height="560" style="width:420px" />
				<figcaption class="wp-element-caption">旅先の写真</figcaption>
			</figure><!-- /wp:image -->`,
	};
	const blocks = convertPostContent(post, context);
	assert.deepEqual(blocks[0], {
		_type: "image",
		_key: blocks[0]._key,
		asset: { _type: "reference", _ref: "123", url: "https://example.test/photo.jpg" },
		link: undefined,
		alt: "sample",
		caption: "旅先の写真",
		width: 840,
		height: 560,
		displayWidth: 420,
		alignment: "center",
		visualStyle: "photo-frame",
	});
});

test("preserves the destination of a linked WordPress image", () => {
	const post = {
		id: 15,
		content: `<!-- wp:image {"id":123} -->
			<figure class="wp-block-image"><a href="https://kanolog.smugmug.com/Trip/i-abc123/A"><img src="https://photos.smugmug.com/Trip/i-abc123/0/hash/L/photo.jpg" /></a></figure>
			<!-- /wp:image -->`,
	};
	const blocks = convertPostContent(post, context);
	assert.equal(blocks[0].link, "https://kanolog.smugmug.com/Trip/i-abc123/A");
});

test("preserves WordPress preset image size when the block omits a numeric width", () => {
	const post = {
		id: 13,
		content: `<!-- wp:image {"id":7817,"sizeSlug":"medium","linkDestination":"none","className":"is-style-photo_frame"} -->
			<figure class="wp-block-image size-medium is-style-photo_frame">
				<img src="https://example.test/photo-300x225.jpg" alt="" class="wp-image-7817" />
				<figcaption class="wp-element-caption">特大吉</figcaption>
			</figure><!-- /wp:image -->`,
	};
	const blocks = convertPostContent(post, context);
	assert.equal(blocks[0].displayWidth, 300);
	assert.equal(blocks[0].visualStyle, "photo-frame");
});

test("drops empty Gutenberg image placeholders", () => {
	const post = {
		id: 14,
		content: "<!-- wp:image --><!-- /wp:image -->",
	};
	assert.deepEqual(convertPostContent(post, context), []);
});

test("preserves nested Gutenberg quote paragraphs and citation as one semantic quote", () => {
	const post = {
		id: 8436,
		content: `<!-- wp:quote -->
			<blockquote class="wp-block-quote"><!-- wp:paragraph -->
			<p>それはつまり「モノ」を作らず、ひたすらに「コト」を生み出してきた、ということです。</p>
			<!-- /wp:paragraph --><!-- wp:paragraph -->
			<p><strong>次の段落</strong>も引用の一部です。</p>
			<!-- /wp:paragraph --><cite>山口周</cite></blockquote>
			<!-- /wp:quote -->`,
	};
	const blocks = convertPostContent(post, context);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0]._type, "yohaku.quote");
	assert.equal(blocks[0].source, "山口周");
	assert.deepEqual(blocks[0].content.map((block) => block.style), ["normal", "normal"]);
	assert.match(blocks[0].content[0].children.map((child) => child.text).join(""), /「コト」を生み出してきた/);
	assert.match(blocks[0].content[1].children.map((child) => child.text).join(""), /次の段落も引用の一部/);
	assert.deepEqual(blocks[0].content[1].children[0].marks, ["strong"]);
});

test("preserves classic WordPress quote HTML without nested Gutenberg blocks", () => {
	const post = {
		id: 139,
		content: '<!-- wp:quote --><blockquote class="wp-block-quote"><p>最初の段落</p><p>次の段落<br>改行</p></blockquote><!-- /wp:quote -->',
	};
	const blocks = convertPostContent(post, context);
	assert.equal(blocks[0]._type, "yohaku.quote");
	assert.match(blocks[0].content[0].children.map((child) => child.text).join(""), /最初の段落/);
	assert.match(blocks[0].content[0].children.map((child) => child.text).join(""), /次の段落/);
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

test("recovers Pochipp image, price, and affiliate link from pochipp_data", () => {
	const products = buildProductMap([
		{
			id: 42,
			postType: "pochipps",
			title: "Sample product",
			meta: new Map([
				["pochipp_data", JSON.stringify({
					image_url: "https://example.test/product.jpg",
					amazon_affi_url: "https://example.test/amazon",
					price: "2420",
				})],
			]),
		},
	]);
	assert.deepEqual(products.get("42"), {
		title: "Sample product",
		imageUrl: "https://example.test/product.jpg",
		price: "2420",
		primaryUrl: "https://example.test/amazon",
		links: [{ label: "Amazon", url: "https://example.test/amazon" }],
	});
});

test("converts inline Pochipp shortcodes without dropping surrounding prose", () => {
	const post = {
		id: 31,
		content: '<!-- wp:paragraph --><p>前の文章<br>[pochipp id="42"]後の文章</p><!-- /wp:paragraph -->',
	};
	const blocks = convertPostContent(post, context);
	assert.deepEqual(blocks.map((block) => block._type), [
		"block",
		"yohaku.productCard",
		"block",
	]);
	assert.match(blocks[0].children.map((child) => child.text).join(""), /前の文章/);
	assert.equal(blocks[1].title, "Sample");
	assert.match(blocks[2].children.map((child) => child.text).join(""), /後の文章/);
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
