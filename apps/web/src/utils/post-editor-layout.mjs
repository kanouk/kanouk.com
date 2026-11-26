// Post editor in reading order: title, featured image (compact), excerpt (3 rows), body,
// with Japanese field labels to match the rest of the admin.
// Shared by the admin's one-click setup panel and the guarded CLI. Changes only field order,
// the featured image widget, the excerpt's rows, and labels; never content rows.
// `client` is { get(path), put(path, body), post(path, body) } returning parsed JSON.

export const POST_EDITOR_LAYOUT = Object.freeze({
	leading: Object.freeze(["title", "featured_image", "excerpt", "content"]),
	featuredWidget: "yohaku-photo-tools:featured-image-compact",
	excerptRows: 3,
	// Only fields present in the live schema are relabelled; a missing one is not an error.
	labels: Object.freeze({
		title: "タイトル",
		featured_image: "アイキャッチ画像",
		excerpt: "抜粋",
		content: "本文",
		published_on: "公開日",
		source_url: "元記事のURL",
		source_id: "元記事のID",
		source_metadata: "元記事の情報",
	}),
});

const labelUpdates = (fields) => Object.entries(POST_EDITOR_LAYOUT.labels)
	.filter(([slug, label]) => { const field = fields.find((candidate) => candidate?.slug === slug); return field && field.label !== label; })
	.map(([slug]) => slug);

const FIELDS_PATH = "/_emdash/api/schema/collections/posts/fields";

function fieldsFrom(response) {
	const fields = response?.data?.items ?? response?.items;
	if (!Array.isArray(fields)) throw new Error("EmDash fields response did not contain data.items");
	return fields;
}

const bySortOrder = (fields) => fields.toSorted((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0));

/** The full slug order with the leading fields first and everything else in its current order. */
export function desiredOrder(fields) {
	const slugs = bySortOrder(fields).map((field) => field.slug);
	return [...POST_EDITOR_LAYOUT.leading, ...slugs.filter((slug) => !POST_EDITOR_LAYOUT.leading.includes(slug))];
}

export function inspectPostEditorLayout(fields) {
	const find = (slug) => fields.find((field) => field?.slug === slug);
	const missing = POST_EDITOR_LAYOUT.leading.filter((slug) => !find(slug));
	if (missing.length) return { status: "incompatible", problems: [`missing fields: ${missing.join(", ")}`] };
	const problems = [];
	if (find("featured_image").type !== "image") problems.push("featured_image is not an image field");
	if (find("excerpt").type !== "text") problems.push("excerpt is not a text field");
	if (problems.length) return { status: "incompatible", problems };
	const pending = [];
	const current = bySortOrder(fields).map((field) => field.slug);
	if (current.join() !== desiredOrder(fields).join()) pending.push("order");
	if (find("featured_image").widget !== POST_EDITOR_LAYOUT.featuredWidget) pending.push("featured_image.widget");
	if (find("excerpt").options?.rows !== POST_EDITOR_LAYOUT.excerptRows) pending.push("excerpt.options.rows");
	if (labelUpdates(fields).length) pending.push("labels");
	return { status: pending.length ? "pending" : "ready", problems: [], pending, order: current };
}

function updateBody(field, changes) {
	// The update schema requires `validation` (nullable); keep what the field already has.
	return { validation: field.validation ?? null, ...changes };
}

export async function ensurePostEditorLayout(client, { apply = false } = {}) {
	const fields = fieldsFrom(await client.get(FIELDS_PATH));
	const before = inspectPostEditorLayout(fields);
	if (before.status === "incompatible") throw new Error(`posts schema is incompatible: ${before.problems.join("; ")}`);
	if (before.status === "ready") return { action: "unchanged", before, after: before };
	const plan = { order: desiredOrder(fields), pending: before.pending };
	if (!apply) return { action: "would-update", before, after: before, plan };

	const find = (slug) => fields.find((field) => field.slug === slug);
	if (before.pending.includes("featured_image.widget")) {
		await client.put(`${FIELDS_PATH}/featured_image`, updateBody(find("featured_image"), { widget: POST_EDITOR_LAYOUT.featuredWidget }));
	}
	if (before.pending.includes("excerpt.options.rows")) {
		const excerpt = find("excerpt");
		await client.put(`${FIELDS_PATH}/excerpt`, updateBody(excerpt, { options: { ...excerpt.options, rows: POST_EDITOR_LAYOUT.excerptRows } }));
	}
	if (before.pending.includes("labels")) {
		for (const slug of labelUpdates(fields)) {
			await client.put(`${FIELDS_PATH}/${slug}`, updateBody(find(slug), { label: POST_EDITOR_LAYOUT.labels[slug] }));
		}
	}
	if (before.pending.includes("order")) {
		await client.post(`${FIELDS_PATH}/reorder`, { fieldSlugs: plan.order });
	}
	const after = inspectPostEditorLayout(fieldsFrom(await client.get(FIELDS_PATH)));
	if (after.status !== "ready") throw new Error(`posts editor layout postflight failed: ${[...after.problems, ...(after.pending ?? [])].join("; ")}`);
	return { action: "updated", before, after, plan };
}


/** Current state, for showing the setup button only while something is left to do. */
export async function readPostEditorLayout(client) {
	return inspectPostEditorLayout(fieldsFrom(await client.get(FIELDS_PATH)));
}
