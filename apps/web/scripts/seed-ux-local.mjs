// Deliberately local-only. Never accepts a remote binding or SQL input.
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

if (!process.argv.includes("--confirm-local-fixtures")) throw new Error("Pass --confirm-local-fixtures to add fixtures to local D1 only");
const directory = fileURLToPath(new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url));
const files = readdirSync(directory).filter(file => /^[a-f0-9]{64}\.sqlite$/.test(file));
if (files.length !== 1) throw new Error("Expected exactly one initialized local D1 database");
const db = new DatabaseSync(join(directory, files[0]));
try {
	for (const table of ["ec_posts", "ec_albums", "ec_photos"]) {
		if (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id LIKE 'ux-%'`).get().n !== 0) throw new Error(`Refusing to overwrite existing UX fixtures in ${table}`);
	}
	const photoFiles = [
		"01M1DCR9GVREBERMX03TGCMBYM.01M1DCRA53ZNA9X0SVP100BC0H.jpg",
		"01M1DCTHMBNSWGDGHATVRT8N8F.01M1DCTJ99QXQJFF3MZ000SMDC.jpg",
		"01M1DCWMAF6M7DGE4R0SE5AEN8.01M1DCWMYSHYJV7FXHPXJRZVFW.jpg",
	];
	const image = index => ({ provider: "external", id: "", src: `https://photos.kanouk.com/_yohaku/media/preview-v2/1200/webp/${photoFiles[index % photoFiles.length]}`, width: 1200, height: 900, alt: "公開写真を使ったローカル表示確認" });
	const text = (value, style = "normal", key = crypto.randomUUID()) => ({ _type: "block", _key: key, style, markDefs: [], children: [{ _type: "span", _key: `${key}-span`, text: value, marks: [] }] });
	const add = (collection, id, data, status = "published") => {
		const revision = `revision-${id}`;
		db.prepare("INSERT INTO revisions (id,collection,entry_id,data) VALUES (?,?,?,?)").run(revision, collection, id, JSON.stringify(data));
		const record = { id, slug: id, status, locale: "ja", published_at: status === "published" ? "2026-09-06T00:00:00Z" : null, live_revision_id: status === "published" ? revision : null, draft_revision_id: revision, ...data };
		const fields = Object.keys(record);
		db.prepare(`INSERT INTO ec_${collection} (${fields.map(field => `"${field}"`).join(",")}) VALUES (${fields.map(() => "?").join(",")})`).run(...Object.values(record).map(value => value && typeof value === "object" ? JSON.stringify(value) : value));
	};
	db.exec("BEGIN");
	try {
		add("albums", "ux-album", { title: "表示確認用アルバム", description: "本番には保存されないローカル検証データです。", cover_image: image(0), allow_downloads: 0 });
		for (let index = 0; index < 12; index++) add("photos", `ux-photo-${index + 1}`, { title: `確認用の写真 ${index + 1}`, image: image(index), kind: "image", alt: `確認用の写真 ${index + 1}`, caption: `ローカル検証用キャプション ${index + 1}`, album: "ux-album", position: index, source_system: "ux-fixture", source_id: `ux-${index + 1}` });
		add("photos", "ux-photo-private", { title: "下書きの写真", image: image(1), kind: "image", alt: "下書き", album: "ux-album", position: 99, source_system: "ux-fixture", source_id: "ux-private" }, "draft");
		add("posts", "ux-article", {
			title: "文字と写真の読み心地を確かめる", excerpt: "記事・アルバム・写真のつながりと、見出しや埋め込みの見た目を確認するローカル専用の記事です。",
			content: [
				text("これは表示と操作を確認するための記事です。本番の記事や写真の保存内容は変更しません。"),
				text("写真を添えて書く", "h2"), text("文章の流れの中に、写真を控えめな大きさで配置します。キャプションはこの記事だけの説明として保持します。"),
				{ _type: "yohaku.photo", _key: "photo", id: "ux-photo-1", albumId: "ux-album", caption: "記事固有のキャプション", displayWidth: 480, frame: "photo-frame" },
				text("場面を振り返る", "h3"), text("見出しの形と余白で、文章のまとまりを読み取れるようにします。"),
				text("小さな補足", "h4"), text("箇条書きと見出しが混同されないか、装飾を確認します。"),
				text("注記", "h5"), text("公開状態と記事の関連を、画面ごとに同じ基準で扱います。"),
				{ _type: "yohaku.youtube", _key: "video", id: "https://www.youtube.com/watch?v=jNQXAC9IVRw", caption: "動画にも補足を添える表示確認" },
				{ _type: "yohaku.album", _key: "album", id: "ux-album" },
			],
		});
		add("posts", "ux-draft", { title: "下書きの関連は公開しない", content: [{ _type: "yohaku.album", _key: "album", id: "ux-album" }] }, "draft");
		db.exec("COMMIT");
		console.log("Created local-only UX fixtures: 1 album, 12 public photos + 1 draft, 1 public article + 1 draft. No remote writes.");
	} catch (error) { db.exec("ROLLBACK"); throw error; }
} finally { db.close(); }
