import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const adminSourceUrl = new URL("../src/studio/admin.tsx", import.meta.url);

async function loadInspectRelatedAlbumSchema() {
	const source = await readFile(adminSourceUrl, "utf8");
	const fieldStart = source.indexOf("const RELATED_ALBUM_FIELD = {");
	const fieldEnd = source.indexOf("\n} as const;", fieldStart);
	const inspectStart = source.indexOf("function inspectRelatedAlbumSchema(");
	const inspectEnd = source.indexOf("\n}\n\nasync function readRelatedAlbumSchema", inspectStart);
	assert.notEqual(fieldStart, -1, "RELATED_ALBUM_FIELD must remain extractable");
	assert.notEqual(fieldEnd, -1, "RELATED_ALBUM_FIELD must have the expected terminator");
	assert.notEqual(inspectStart, -1, "inspectRelatedAlbumSchema must remain extractable");
	assert.notEqual(inspectEnd, -1, "inspectRelatedAlbumSchema must have the expected terminator");

	const fieldSource = `${source.slice(fieldStart, fieldEnd + 2)};`;
	const inspectSource = source
		.slice(inspectStart, inspectEnd + 2)
		.replace(
			/function inspectRelatedAlbumSchema\(fields: RelatedAlbumSchemaField\[\]\): RelatedAlbumSchemaState \{/,
			"function inspectRelatedAlbumSchema(fields) {",
		)
		.replace("const problems: string[] = [];", "const problems = [];");
	return runInNewContext(`${fieldSource}\n${inspectSource}\ninspectRelatedAlbumSchema;`);
}

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

const validRelatedAlbumField = {
	slug: "related_album",
	type: "reference",
	required: false,
	unique: false,
	options: { collection: "albums" },
	widget: "yohaku-photo-tools:related-album-hidden",
	indexed: true,
	translatable: true,
};

test("related album setup uses the native CSRF-aware schema API only after a click", async () => {
	const source = await readFile(adminSourceUrl, "utf8");
	assert.match(source, /import \{ apiFetch, parseApiResponse \} from "@emdash-cms\/admin"/);
	assert.match(source, /const RELATED_ALBUM_SCHEMA_PATH = "\/_emdash\/api\/schema\/collections\/posts\/fields"/);
	assert.match(source, /const enableRelatedAlbum = async \(\) => \{/);
	assert.match(source, /onClick=\{enableRelatedAlbum\}>関連アルバム設定を有効にする/);
	assert.match(source, /const before = await readRelatedAlbumSchema\(\)/);
	assert.match(source, /before\.status === "missing"[\s\S]*?method: "POST"/);
	assert.match(source, /const after = await readRelatedAlbumSchema\(\)/);
	assert.doesNotMatch(source, /useEffect\(\(\) => \{[\s\S]{0,500}method: "POST"/);
});

test("schema creation sends the exact optional single albums reference contract", async () => {
	const source = await readFile(adminSourceUrl, "utf8");
	for (const contract of [
		/slug: "related_album"/,
		/type: "reference"/,
		/required: false/,
		/unique: false/,
		/options: \{ collection: "albums" \}/,
		/widget: "yohaku-photo-tools:related-album-hidden"/,
		/indexed: true/,
		/translatable: true/,
	]) assert.match(source, contract);
	assert.match(source, /body: JSON\.stringify\(RELATED_ALBUM_FIELD\)/);
});

test("the picker fails closed until schema is ready and requires reload after creation", async () => {
	const source = await readFile(adminSourceUrl, "utf8");
	assert.match(source, /const schemaReady = schemaState\.status === "ready"/);
	assert.match(source, /disabled=\{!schemaReady \|\| loading \|\| !onFieldChange\}/);
	assert.match(source, /既存のrelated_album定義が予定した設定と一致しないため、自動変更を停止しました/);
	assert.match(source, /管理者権限を確認してください/);
	assert.match(source, /設定追加後の確認でrelated_albumが見つかりませんでした/);
	assert.match(source, /setSchemaState\(\{ status: "reload-required" \}\)/);
	assert.match(source, /window\.location\.reload\(\)/);
});

test("schema inspection accepts only the exact optional albums reference contract", async () => {
	const inspectRelatedAlbumSchema = await loadInspectRelatedAlbumSchema();
	assert.deepEqual(plain(inspectRelatedAlbumSchema([])), { status: "missing" });
	assert.deepEqual(plain(inspectRelatedAlbumSchema([validRelatedAlbumField])), { status: "ready" });

	for (const { property, value, problem } of [
		{ property: "type", value: "text", problem: "型がreferenceではありません。" },
		{ property: "required", value: true, problem: "任意フィールドとして確認できません。" },
		{ property: "unique", value: true, problem: "複数の記事から同じアルバムを参照できない設定です。" },
		{ property: "widget", value: "reference", problem: "専用widgetが設定されていません。" },
		{ property: "indexed", value: false, problem: "indexが設定されていません。" },
		{ property: "translatable", value: false, problem: "言語別の値を保持できない設定です。" },
	]) {
		const result = plain(inspectRelatedAlbumSchema([{ ...validRelatedAlbumField, [property]: value }]));
		assert.equal(result.status, "incompatible", `${property} mismatch must fail closed`);
		assert.deepEqual(result.problems, [problem]);
	}

	const wrongTarget = plain(inspectRelatedAlbumSchema([{
		...validRelatedAlbumField,
		options: { collection: "photos" },
	}]));
	assert.equal(wrongTarget.status, "incompatible");
	assert.deepEqual(wrongTarget.problems, ["参照先がalbumsではありません。"]);
});
